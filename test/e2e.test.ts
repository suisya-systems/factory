// One full lap with a fake model: build (fails, then LLM-only reject, then ok) -> judge -> ship -> serve -> observe.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { runChange } from '../src/run.ts'
import { freePort } from '../src/sandbox.ts'
import { stopServer } from '../src/ship.ts'
import { approvedChange, CLI_MARKERS, freshState, gitTarget, MEMO_SERVER, SCENARIOS, writeApp } from './helpers.ts'

const sd = freshState()
after(() => stopServer(sd))

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

test('full lap ships a passing build and records signals; builder never sees scenario bodies', async () => {
  const version = approvedChange(sd, 'memo-1')
  const target = gitTarget()
  const builderInstructions: string[] = []
  let attempt = 0
  let judged = 0
  const model: Model = async (t) => {
    if (t.role === 'builder') {
      builderInstructions.push(t.instruction)
      attempt++
      // attempt 1: no 404 handling for unknown ids and no update; attempt 2: correct
      writeApp(t.workdir, attempt === 1 ? MEMO_SERVER.replace("if (!note) return send(res, 404, { error: 'not found' })", "if (!note) return send(res, 200, {})").replace("if (req.method === 'PUT')", "if (false)") : MEMO_SERVER)
      return { ok: true, text: 'built', costUsd: 0.5 }
    }
    judged++ // judge #2: every test passes but the LLM does not approve -> an LLM-only retry
    return { ok: true, text: judged === 2 ? '{"pass": false, "reason": "PUT /notes/{{id}} looks off"}' : '{"pass": true, "reason": "looks fine"}', costUsd: 0.1 }
  }
  const port = await freePort()
  const r = await runChange({ changeId: 'memo-1', shipTarget: target, model, stateDir: sd, port, stopFile: join(sd, 'NOSTOP'), trafficBase: '/notes' })
  assert.equal(r.status, 'shipped', r.stopReason)
  assert.equal(r.attempts.length, 3)
  assert.equal(r.llmOnlyRejections, 1)
  assert.match(r.attempts[1].llmReason, /looks off/) // kept in the (hidden) record for audit, never fed back
  assert.deepEqual(r.attempts.map((a) => [a.testsAllPass, a.llmPass]), [[false, true], [true, false], [true, true]])
  assert.equal(r.passedWithinCap, true)
  assert.equal(r.approvedVersion, version)
  assert.ok(r.attempts.every((a) => a.approvedVersion === version))
  const a1 = r.attempts[0]
  const one = (passed: number) => ({ passed, total: 1 })
  assert.deepEqual(a1.passRate, { inSpec: { passed: 2, total: 3 }, notInSpec: { passed: 0, total: 1 },
    byLabel: { 'readable-spec': one(1), 'readable-code': one(1), unstated: one(0), contradicts: one(0) } })
  assert.deepEqual(r.attempts[1].passRate, { inSpec: { passed: 3, total: 3 }, notInSpec: { passed: 1, total: 1 },
    byLabel: { 'readable-spec': one(1), 'readable-code': one(1), unstated: one(1), contradicts: one(1) } })
  assert.deepEqual(r.cost.byRole, { builder: 1.5, judge: 0.30000000000000004 })

  // retry feedback = summaries only
  assert.equal(builderInstructions.length, 3)
  assert.match(builderInstructions[2], /LLM judge did not approve/)
  assert.ok(!builderInstructions[2].includes('looks off'))
  assert.match(builderInstructions[1], /updating a note changes its title/)
  for (const s of SCENARIOS) for (const st of s.steps) {
    for (const lit of [st.path, JSON.stringify(st.body ?? null), JSON.stringify(st.expect)].filter((x) => x !== 'null' && x !== '/notes')) {
      assert.ok(!builderInstructions.join('\n').includes(lit), `builder saw ${lit}`)
    }
  }
  for (const lit of ['zebra-unique-777', 'quokka-missing-42']) assert.ok(!builderInstructions.join('\n').includes(lit))

  // shipped: ship target fast-forwarded to the passing sha, release live behind the proxy
  const head = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString().trim()
  assert.equal(head, r.attempts[2].sha)
  assert.ok(existsSync(join(sd, 'releases', 'current', 'server.cjs')))
  const live = await (await fetch(`http://127.0.0.1:${port}/notes`)).json()
  assert.ok(Array.isArray(live))

  const sig = JSON.parse(readFileSync(join(sd, 'prod', 'signals.json'), 'utf8'))
  assert.ok(sig.requests >= 5, JSON.stringify(sig))
  assert.ok(sig.byStatus['404'] >= 1)
  assert.equal(typeof sig.latencyMs.p50, 'number')

  // nothing the factory wrote to its records mentions the CLI
  for (const f of [...filesUnder(join(sd, 'runs')), ...filesUnder(join(sd, 'vault')), ...['signals.json', 'access.log', 'error.log'].map((x) => join(sd, 'prod', x)).filter(existsSync)]) {
    const txt = readFileSync(f, 'utf8')
    for (const m of CLI_MARKERS) assert.ok(!m.test(txt), `${f} contains ${m}`)
  }
})

test('a ship target that moved since the draft is refused before any build', async () => {
  const target = gitTarget()
  approvedChange(sd, 'memo-moved', SCENARIOS, { baseSha: 'f'.repeat(40), requestSha256: null })
  let calls = 0
  const r = await runChange({ changeId: 'memo-moved', shipTarget: target, model: async () => { calls++; return { ok: true, text: '', costUsd: 0 } }, stateDir: sd, port: await freePort(), stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /no longer at the approved base/)
  assert.equal(calls, 0)
})
