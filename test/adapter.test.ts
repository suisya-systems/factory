// Adapter boundary: CLI flags / output fields exist only in src/adapter.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliEnv, codexBin, codexEnv, crossLoginSecrets, CROSS_ROLES, MODEL_BY_ROLE, MODELS, modelFor, parseModels, realModel, runCli, runCodex, type Access, type Task } from '../src/adapter.ts'
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
const call = (w: string, access: Access = 'write', more: { role?: string; model?: string } = {}) => runCli({ role: 'builder', instruction: 'hello', workdir: w, access, maxCostUsd: 2.5, timeoutMs: 10_000, ...more }, join(w, 'cli'))

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
})

// Lap 4 found the table keyed drafter/builder/judge while the factory called spec-drafter, scenario-drafter
// and classifier, which silently fell back to the default. Every role name the factory calls with must be a key.
test('every role the factory calls a model with has its own entry in MODEL_BY_ROLE', () => {
  const roles = new Set<string>()
  for (const f of readdirSync(join(REPO, 'src')).filter((f) => f.endsWith('.ts'))) {
    for (const m of readFileSync(join(REPO, 'src', f), 'utf8').matchAll(/role: '([\w-]+)'|ask\(model, '([\w-]+)'/g)) roles.add(m[1] ?? m[2])
  }
  assert.deepEqual([...roles].sort(), ['builder', 'classifier', 'judge', 'scenario-drafter', 'spec-drafter', 'splitter'])
  assert.deepEqual(Object.keys(MODEL_BY_ROLE).sort(), [...roles].sort())
})

test('a role missing from the table is an error, not a default; a per-role model reaches --model', async () => {
  const w = fakeCli(`printf '{"result":"%s","total_cost_usd":0}' "$*"`)
  await assert.rejects(call(w, 'none', { role: 'drafter' }), /no model is set for role "drafter"/)
  for (const role of Object.keys(MODEL_BY_ROLE)) {
    assert.match((await call(w, 'none', { role })).text, /--model claude-opus-5-5 /)
    assert.match((await call(w, 'none', { role, model: 'claude-sonnet-5-5' })).text, /--model claude-sonnet-5-5 /)
  }
})

test('--model values: only table roles and the listed models', () => {
  assert.deepEqual(MODELS, ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra'])
  assert.deepEqual(parseModels(['builder=claude-sonnet-5-5', 'scenario-drafter=claude-opus-5-5']), { builder: 'claude-sonnet-5-5', 'scenario-drafter': 'claude-opus-5-5' })
  assert.deepEqual(parseModels(['spec-drafter=gpt-6-astra', 'scenario-drafter=gpt-6-astra']), { 'spec-drafter': 'gpt-6-astra', 'scenario-drafter': 'gpt-6-astra' })
  for (const bad of ['drafter=claude-opus-5-5', 'builder=claude-sonnet-5', 'builder', 'builder=claude-opus-5-5=x', 'builder=gpt-6-astra', 'judge=gpt-6-astra', 'classifier=gpt-6-astra']) assert.throws(() => parseModels([bad]), /--model/)
})

test('per-model cost (lap 4): costUSD of each model in the usage, only when it is a number', async () => {
  const r = await call(fakeCli(`echo '{"result":"ok","total_cost_usd":0.3,"modelUsage":{"claude-opus-5-5":{"costUSD":0.25},"claude-haiku-5-5":{"costUSD":0.05},"odd":{"costUSD":"x"}}}'`))
  assert.deepEqual(r.costByModel, { 'claude-opus-5-5': 0.25, 'claude-haiku-5-5': 0.05 })
  const e = await call(fakeCli(`echo '{"result":"","is_error":true,"total_cost_usd":0.1,"modelUsage":{"claude-opus-5-5":{"costUSD":0.1}}}'; exit 1`))
  assert.deepEqual(e.costByModel, { 'claude-opus-5-5': 0.1 }) // a failed call's spend is split too
  assert.equal((await call(fakeCli(`echo '{"result":"ok","total_cost_usd":0.2,"modelUsage":{"claude-opus-5-5":{}}}'`))).costByModel, undefined)
})

// ---- lap 8: the second model family (Codex CLI) ----
// A fake codex laid out like the npm package (<pkg>/bin/codex), so the package mount is <pkg>, never a parent dir.
function fakeCodex(body: string) {
  const w = tmp('fakecodex')
  mkdirSync(join(w, 'pkg', 'bin'), { recursive: true })
  writeFileSync(join(w, 'pkg', 'bin', 'codex'), `#!/bin/sh\nIN=$(cat)\n${body}\n`)
  chmodSync(join(w, 'pkg', 'bin', 'codex'), 0o755)
  return { w, bin: join(w, 'pkg', 'bin', 'codex') }
}
const msg = (text: string) => JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
const drafterTask = (w: string, more: Partial<Task> = {}): Task => ({ role: 'spec-drafter', model: 'gpt-6-astra', instruction: 'hello', workdir: w, access: 'none', maxCostUsd: 1, timeoutMs: 10_000, ...more })

test('codex: the last agent message is the reply; no USD and no answering model are reported; flags are pinned', async () => {
  const echo = `node -e 'console.log(JSON.stringify({type:"item.completed",item:{id:"i",type:"agent_message",text:process.argv.slice(1).join(" ")}}))' "$IN" "$@"`
  const { w, bin } = fakeCodex(`echo '{"type":"thread.started","thread_id":"t"}'\necho '${msg('first')}'\n${echo}\necho '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'`)
  const r = await runCodex(drafterTask(w), bin, join(w, 'no-auth.json'))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.costUsd, null)
  assert.equal(r.model, undefined)
  assert.match(r.text, /^hello exec --json --model gpt-6-astra --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config -c model_reasoning_effort="medium" --cd \S+ -$/)
})

test('codex: a failed turn, no reply, a crash or garbage is not ok, and no CLI words reach the error', async () => {
  for (const body of [`echo '${msg('partial')}'; echo '{"type":"turn.failed","error":{"message":"usage limit --model x"}}'`, `echo '{"type":"turn.completed"}'`,
    `echo '${msg('x')}'; exit 3`, 'echo "error: unexpected argument --ephemeral"; exit 2', `echo '{"type":"error","message":"stream disconnected"}'`]) {
    const { w, bin } = fakeCodex(body)
    const r = await runCodex(drafterTask(w), bin, join(w, 'no-auth.json'))
    assert.equal(r.ok, false, body)
    assert.equal(r.costUsd, null)
    assert.doesNotMatch(r.error!, /--|turn\.failed|agent_message|usage limit|stream/, r.error)
  }
})

test('codex: only drafters, only without tools; the builder never reaches it, whatever the task says', async () => {
  const { w, bin } = fakeCodex(`echo '${msg('x')}'`)
  for (const role of Object.keys(MODEL_BY_ROLE).filter((r) => !CROSS_ROLES.includes(r))) {
    assert.throws(() => modelFor({ role, model: 'gpt-6-astra' }), /only/)
    await assert.rejects(runCodex(drafterTask(w, { role, access: 'write' }), bin), /only/)
    await assert.rejects(realModel(drafterTask(w, { role, access: 'write' })), /only/) // refused before any process starts
  }
  await assert.rejects(runCodex(drafterTask(w, { access: 'read' }), bin), /without tool access/)
})

test('codex: found on PATH by its real path (a version manager links it), or an explicit error', () => {
  const { w, bin } = fakeCodex('true')
  mkdirSync(join(w, 'shell-bin'))
  symlinkSync(bin, join(w, 'shell-bin', 'codex'))
  assert.equal(codexBin(`/nonexistent:${join(w, 'shell-bin')}`), realpathSync(bin))
  assert.throws(() => codexBin('/nonexistent'), /not on PATH/)
})

test('codex: env carries no first-family auth; its home is the dir of the login file', () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' })
  try {
    const e = codexEnv('/h/.codex/auth.json')
    assert.equal(e.ANTHROPIC_API_KEY, undefined)
    assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(e.CODEX_HOME, '/h/.codex')
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CODE_OAUTH_TOKEN }
})

test('login secrets for the leak check: every long string of the login file, nested; none when it is missing or garbage', () => {
  const w = tmp('login')
  writeFileSync(join(w, 'auth.json'), JSON.stringify({ mode: 'chatgpt', tokens: { id_token: 'i'.repeat(30), access_token: 'a'.repeat(25), list: ['r'.repeat(20)] }, short: 'x'.repeat(19) }))
  assert.deepEqual(crossLoginSecrets(join(w, 'auth.json')).sort(), ['a'.repeat(25), 'i'.repeat(30), 'r'.repeat(20)])
  assert.deepEqual(crossLoginSecrets(join(w, 'missing.json')), [])
  writeFileSync(join(w, 'bad.json'), '{')
  assert.deepEqual(crossLoginSecrets(join(w, 'bad.json')), [])
})
