// Adapter boundary: CLI flags / output fields exist only in src/adapter.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliEnv, MODEL_BY_ROLE, runCli, type Access } from '../src/adapter.ts'
import { startGuard } from '../src/limits.ts'
import { CLI_MARKERS, REPO, tmp } from './helpers.ts'


test('no src file other than adapter.ts knows the CLI', () => {
  const dir = join(REPO, 'src')
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'adapter.ts')) {
    const src = readFileSync(join(dir, f), 'utf8').replaceAll('claudeModel', 'MODEL') // the exported Model's name is allowed
    for (const m of CLI_MARKERS) assert.ok(!m.test(src), `${f} leaks ${m}`)
  }
})

function fakeCli(body: string) {
  const w = tmp('fake')
  writeFileSync(join(w, 'cli'), `#!/bin/sh\nIN=$(cat)\n${body}\n`)
  chmodSync(join(w, 'cli'), 0o755)
  return w
}
const call = (w: string, access: Access = 'write') => runCli({ role: 'r', instruction: 'hello', workdir: w, access, maxCostUsd: 2.5, timeoutMs: 10_000 }, join(w, 'cli'))

test('parses result text and cost from the CLI JSON', async () => {
  const r = await call(fakeCli(`printf '{"type":"result","result":"%s","total_cost_usd":0.125,"is_error":false}' "$IN"`))
  assert.deepEqual(r, { ok: true, text: 'hello', costUsd: 0.125, model: 'claude-opus-5-5' })
})

test('missing cost -> null; garbage output -> not ok, null cost; error result keeps cost', async () => {
  assert.deepEqual(await call(fakeCli(`echo '{"result":"x"}'`)), { ok: true, text: 'x', costUsd: null, model: 'claude-opus-5-5' })
  const g = await call(fakeCli('echo "Error: --output-format bogus"; exit 3'))
  assert.equal(g.ok, false)
  assert.equal(g.costUsd, null)
  assert.ok(!/--|output-format/.test(g.error!), `raw CLI text leaked into error: ${g.error}`)
  const e = await call(fakeCli(`echo '{"result":"","is_error":true,"subtype":"error_max_budget_usd","total_cost_usd":2.4}'; exit 1`))
  assert.equal(e.ok, false)
  assert.equal(e.costUsd, 2.4)
})

test('access maps to permissions; budget passed down', async () => {
  const echoArgs = `printf '{"result":"%s","total_cost_usd":0}' "$*"`
  const w = await call(fakeCli(echoArgs), 'write')
  assert.match(w.text, /--max-budget-usd 2\.5000/)
  assert.match(w.text, /bypassPermissions/)
  assert.match(w.text, /--model claude-opus-5-5/) // pinned, never the CLI default
  const r = await call(fakeCli(echoArgs), 'read')
  assert.match(r.text, /--tools Read,Grep,Glob/)
  assert.doesNotMatch(r.text, /bypassPermissions/)
  const n = await call(fakeCli(echoArgs), 'none')
  assert.match(n.text, /--tools\s*$/) // empty tool list
  assert.doesNotMatch(n.text, /setting-sources project/)
})

test('the CLI gets an allowlisted env: no parent-session tokens or behaviour knobs', async () => {
  const planted = { RENGA_TOKEN: 'x', CLAUDE_CODE_SESSION_ID: 'x', CLAUDECODE: '1', CLAUDE_EFFORT: 'medium', CLOUDSDK_PROXY_PASSWORD: 'x', SOME_SECRET: 'x' }
  Object.assign(process.env, planted)
  try {
    const r = await call(fakeCli(`printf '{"result":"%s","total_cost_usd":0}' "$(env | cut -d= -f1 | tr '\\n' ' ')"`))
    const names = r.text.trim().split(/\s+/)
    for (const k of Object.keys(planted)) assert.ok(!names.includes(k), `${k} reached the CLI`)
    const allowed = new Set([...Object.keys(cliEnv()), 'PWD', 'SHLVL', '_', 'OLDPWD']) // last four: set by the shell itself
    for (const n of names) assert.ok(allowed.has(n), `unexpected env ${n}`)
  } finally { for (const k of Object.keys(planted)) delete process.env[k] }
})

test('CLI error kinds, garbage and missing cost never reach records in CLI words', async () => {
  const outs = [
    `echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","session_id":"s-1","total_cost_usd":0.3}'; exit 1`,
    `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s-2"}'; exit 1`,
    `echo '{"type":"result","subtype":"weird_new_kind","is_error":true,"total_cost_usd":0.1}'; exit 1`,
    'echo "Error: unknown option --output-format"; exit 2',
    `echo '{"result":"ok","session_id":"s-3"}'`,
  ]
  const records: unknown[] = []
  for (const body of outs) {
    const g = startGuard(5, join(tmp('nostop'), 'STOP'))
    const w = fakeCli(body)
    const r = await g.model((t) => runCli(t, join(w, 'cli')))({ role: 'judge', instruction: 'x', workdir: w, access: 'read', maxCostUsd: 5, timeoutMs: 10_000 }).catch((e) => ({ thrown: e.message }))
    g.dispose()
    records.push(r, g.ledger)
  }
  const txt = JSON.stringify(records)
  for (const m of CLI_MARKERS) assert.ok(!m.test(txt), `record contains ${m}: ${txt}`)
  assert.match(txt, /budget exceeded/)
  assert.match(txt, /execution error/)
})

test('the model that actually answered is reported (per-model usage), and recorded per role', async () => {
  const r = await call(fakeCli(`echo '{"result":"ok","total_cost_usd":0.2,"modelUsage":{"claude-opus-5-5":{},"claude-haiku-5-5":{}}}'`))
  assert.equal(r.model, 'claude-opus-5-5,claude-haiku-5-5')
  for (const role of ['drafter', 'builder', 'judge']) assert.equal(MODEL_BY_ROLE[role], 'claude-opus-5-5')
})

test('per-model cost (lap 4): costUSD of each model in the usage, only when it is a number', async () => {
  const r = await call(fakeCli(`echo '{"result":"ok","total_cost_usd":0.3,"modelUsage":{"claude-opus-5-5":{"costUSD":0.25},"claude-haiku-5-5":{"costUSD":0.05},"odd":{"costUSD":"x"}}}'`))
  assert.deepEqual(r.costByModel, { 'claude-opus-5-5': 0.25, 'claude-haiku-5-5': 0.05 })
  const e = await call(fakeCli(`echo '{"result":"","is_error":true,"total_cost_usd":0.1,"modelUsage":{"claude-opus-5-5":{"costUSD":0.1}}}'; exit 1`))
  assert.deepEqual(e.costByModel, { 'claude-opus-5-5': 0.1 }) // a failed call's spend is split too
  assert.equal((await call(fakeCli(`echo '{"result":"ok","total_cost_usd":0.2,"modelUsage":{"claude-opus-5-5":{}}}'`))).costByModel, undefined)
})
