// Stop conditions: cost cap, retry cap, emergency stop from outside. All end as 'failed'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli, type Model, type Task } from '../src/adapter.ts'
import { startGuard, Stop } from '../src/limits.ts'
import { runChange } from '../src/run.ts'
import { freePort } from '../src/sandbox.ts'
import { approvedChange, freshState, gitTarget, MEMO_SERVER, tmp, writeApp } from './helpers.ts'

const sd = freshState()
const task = (role: string): Task => ({ role, instruction: 'x', workdir: tmp('lim'), access: 'none', maxCostUsd: 99, timeoutMs: 10_000 })

test('cost cap: guard passes the remaining budget down and stops after the cap', async () => {
  const seen: number[] = []
  const g = startGuard(1, join(sd, 'NOSTOP'))
  const m = g.model(async (t) => { seen.push(t.maxCostUsd); return { ok: true, text: '', costUsd: 0.6 } })
  await m(task('builder'))
  await assert.rejects(m(task('judge')), Stop)
  await assert.rejects(m(task('builder')), /cost cap reached/)
  g.dispose()
  assert.deepEqual(seen, [1, 0.4]) // third call never reached the model
  assert.deepEqual(g.ledger.byRole, { builder: 0.6, judge: 0.6 })
})

test('null cost is listed as uncounted AND charged its whole budget, so the cap still binds', async () => {
  const g = startGuard(5, join(sd, 'NOSTOP'))
  let calls = 0
  const m = g.model(async () => { calls++; return { ok: false, text: '', costUsd: null, error: 'process died' } })
  await m(task('drafter'))
  await assert.rejects(m(task('builder')), /cost cap reached/)
  g.dispose()
  assert.equal(calls, 1) // a timed-out call must not hand the full budget to the next one
  assert.deepEqual(g.ledger.uncounted, [{ role: 'drafter', reason: 'process died', chargedUsd: 5 }])
  assert.equal(g.ledger.totalUsd, 5)
})

test('a non-numeric or non-positive cap / attempts is refused, never silently uncapped', async () => {
  for (const bad of [NaN, 0, -1, Infinity]) assert.throws(() => startGuard(bad, join(sd, 'NOSTOP')), /positive number/)
  approvedChange(sd, 'bad-caps')
  const o = { changeId: 'bad-caps', shipTarget: gitTarget(), model: async () => ({ ok: true, text: '', costUsd: 0 }), stateDir: sd, port: 1, stopFile: join(sd, 'NOSTOP') }
  await assert.rejects(runChange({ ...o, maxCostUsd: Number('10usd') }), /max cost/)
  await assert.rejects(runChange({ ...o, maxAttempts: Number('abc') }), /max attempts/)
  await assert.rejects(runChange({ ...o, maxAttempts: 1.5 }), /max attempts/)
})

test('check() sees a STOP file at once, without waiting for the poll', () => {
  const f = join(tmp('stopnow'), 'STOP')
  const g = startGuard(1, f)
  g.check()
  writeFileSync(f, 'x')
  assert.throws(() => g.check(), /emergency stop/)
  g.dispose()
})

test('run: cost cap reached -> failed, no further model calls', async () => {
  approvedChange(sd, 'cost-cap')
  let calls = 0
  const model: Model = async () => { calls++; return { ok: true, text: '{"pass":false}', costUsd: 5 } }
  const r = await runChange({ changeId: 'cost-cap', shipTarget: gitTarget(), model, stateDir: sd, port: await freePort(), maxCostUsd: 8, maxAttempts: 5, stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /cost cap/)
  assert.equal(calls, 2) // builder (5) + judge (5) > 8, then nothing
})

test('run: retry cap -> failed after N attempts, never re-enqueued', async () => {
  approvedChange(sd, 'retry-cap')
  let builds = 0
  const model: Model = async (t) => { if (t.role === 'builder') builds++; return { ok: true, text: '{"pass":true}', costUsd: 0.01 } } // builds nothing
  const target = gitTarget()
  const opts = { changeId: 'retry-cap', shipTarget: target, model, stateDir: sd, port: await freePort(), maxAttempts: 2, stopFile: join(sd, 'NOSTOP') }
  const r = await runChange(opts)
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /retry cap reached: 2/)
  assert.equal(builds, 2)
  assert.equal(r.attempts.length, 2)
  await assert.rejects(runChange(opts), /already ran/) // a failed change only re-enters as a NEW change
  assert.equal(builds, 2)
})

test('run: STOP file created mid-call aborts the in-flight call promptly and fails the change', async () => {
  approvedChange(sd, 'estop')
  const stopFile = join(tmp('stop'), 'STOP')
  const model: Model = (t) => new Promise((ok) => {
    const timer = setTimeout(() => ok({ ok: true, text: '', costUsd: 0.01 }), 30_000)
    t.signal!.addEventListener('abort', () => { clearTimeout(timer); ok({ ok: false, text: '', costUsd: null, error: 'aborted' }) })
  })
  setTimeout(() => writeFileSync(stopFile, 'stop'), 300)
  const t0 = Date.now()
  const r = await runChange({ changeId: 'estop', shipTarget: gitTarget(), model, stateDir: sd, port: await freePort(), stopFile })
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`)
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /emergency stop/)
  assert.equal(r.attempts.length, 0)
})

const builderJudge = (judgeCost: number, onJudge = () => {}): Model => async (t) => {
  if (t.role === 'builder') { writeApp(t.workdir, MEMO_SERVER); return { ok: true, text: '', costUsd: 0.5 } }
  onJudge()
  return { ok: true, text: '{"pass":true}', costUsd: judgeCost }
}

test('run: STOP file written just as the judge passes -> not shipped, target untouched', async () => {
  approvedChange(sd, 'stop-ship')
  const stopFile = join(tmp('stopship'), 'STOP')
  const target = gitTarget()
  const head0 = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString()
  const r = await runChange({ changeId: 'stop-ship', shipTarget: target, model: builderJudge(0.1, () => writeFileSync(stopFile, 'x')), stateDir: sd, port: await freePort(), stopFile })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /emergency stop/)
  assert.equal(r.shipped, null)
  assert.equal(execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString(), head0)
})

test('run: cost cap hit during the judge LLM call still records the attempt and its deterministic results', async () => {
  approvedChange(sd, 'cap-judge')
  const r = await runChange({ changeId: 'cap-judge', shipTarget: gitTarget(), model: builderJudge(0.6), stateDir: sd, port: await freePort(), maxCostUsd: 1, stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /cost cap exceeded/)
  assert.equal(r.attempts.length, 1)
  assert.equal(r.attempts[0].testsAllPass, true)
  assert.equal(r.attempts[0].llmPass, null)
  assert.deepEqual(r.attempts[0].passRate.inSpec, { passed: 3, total: 3 })
})

test('run: the drafter cost is merged into the run record', async () => {
  approvedChange(sd, 'draft-merge')
  mkdirSync(join(sd, 'runs', 'draft-merge'), { recursive: true })
  writeFileSync(join(sd, 'runs', 'draft-merge', 'draft-cost.json'), JSON.stringify({ note: '', byRole: { drafter: 0.3 }, totalUsd: 0.3, uncounted: [] }))
  const r = await runChange({ changeId: 'draft-merge', shipTarget: gitTarget(), model: async () => ({ ok: true, text: '{"pass":false}', costUsd: 0.1 }), stateDir: sd, port: 1, maxAttempts: 1, stopFile: join(sd, 'NOSTOP') })
  assert.deepEqual(r.draftCost?.byRole, { drafter: 0.3 })
  assert.ok(Math.abs(r.totalUsdAllRoles - 0.5) < 1e-9, String(r.totalUsdAllRoles))
})

test('adapter kills the sandboxed CLI process on abort', async () => {
  const w = tmp('kill')
  const fake = join(w, 'slow')
  writeFileSync(fake, '#!/bin/sh\nsleep 20\ntouch survived\necho \'{"result":"late","total_cost_usd":1}\'\n')
  chmodSync(fake, 0o755)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const t0 = Date.now()
  const r = await runCli({ role: 'builder', instruction: 'x', workdir: w, access: 'write', maxCostUsd: 1, timeoutMs: 60_000, signal: ac.signal }, fake)
  assert.ok(Date.now() - t0 < 4000)
  assert.equal(r.ok, false)
  assert.equal(r.costUsd, null)
  await new Promise((res) => setTimeout(res, 500))
  assert.ok(!existsSync(join(w, 'survived')))
})

test('run: the drafter spend counts against the per-change cap', async () => {
  approvedChange(sd, 'draft-cap')
  mkdirSync(join(sd, 'runs', 'draft-cap'), { recursive: true })
  writeFileSync(join(sd, 'runs', 'draft-cap', 'draft-cost.json'), JSON.stringify({ note: '', byRole: { drafter: 9.5 }, totalUsd: 9.5, uncounted: [] }))
  const seen: number[] = []
  const r = await runChange({ changeId: 'draft-cap', shipTarget: gitTarget(), model: async (t) => { seen.push(t.maxCostUsd); return { ok: true, text: '', costUsd: 1 } },
    stateDir: sd, port: 1, maxCostUsd: 10, stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /cost cap exceeded \(\$10\.5/)
  assert.deepEqual(seen, [0.5]) // the builder got only what the drafter left
})

test('run: a judge failure is not an LLM rejection and the builder is not told the LLM rejected it', async () => {
  approvedChange(sd, 'judge-fail')
  const instr: string[] = []
  const model: Model = async (t) => {
    if (t.role === 'builder') { instr.push(t.instruction); writeApp(t.workdir, MEMO_SERVER); return { ok: true, text: '', costUsd: 0.01 } }
    return { ok: false, text: '', costUsd: 0.01, error: 'execution error' }
  }
  const r = await runChange({ changeId: 'judge-fail', shipTarget: gitTarget(), model, stateDir: sd, port: 1, maxAttempts: 2, stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.attempts.map((a) => [a.testsAllPass, a.llmPass]), [[true, null], [true, null]])
  assert.equal(r.llmOnlyRejections, 0)
  assert.equal(r.judgeFailures, 2)
  assert.ok(!instr[1].includes('LLM judge did not approve'))
})
