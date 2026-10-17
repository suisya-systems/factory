// Stop conditions: cost cap, retry cap, emergency stop from outside. All end as 'failed'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli, type Model, type Task } from '../src/adapter.ts'
import { CAPS, chargeLap, holdLap, lapSpent, lapTotals, mergeLedger, startGuard, Stop, UNATTRIBUTED } from '../src/limits.ts'
import { runChange } from '../src/run.ts'
import { freePort } from '../src/sandbox.ts'
import { approvedChange, freshState, gitTarget, MEMO_SERVER, REPO, tmp, writeApp } from './helpers.ts'

const REPO_SRC = join(REPO, 'src')

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

test('per-model cost (lap 4): the guard ledger and the lap ledger split each role per model; the rest is unattributed', async () => {
  const lapFile = join(tmp('lapsplit'), 'lap-ledger.jsonl')
  const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile })
  const replies = [{ costUsd: 0.3, costByModel: { 'claude-opus-5-5': 0.25, 'claude-haiku-5-5': 0.05 } }, { costUsd: 0.2, costByModel: { 'claude-opus-5-5': 0.15 } }, { costUsd: null }]
  const m = g.model(async () => ({ ok: true, text: '', ...replies.shift()! }))
  await m(task('builder'))
  await m(task('builder'))
  await m({ ...task('judge'), maxCostUsd: 1 }) // no cost reported: charged its whole budget, attributed to no model
  g.dispose()
  const want = { builder: { 'claude-opus-5-5': 0.4, 'claude-haiku-5-5': 0.05, [UNATTRIBUTED]: 0.05 }, judge: { [UNATTRIBUTED]: 1 } }
  const close = (got: any) => {
    assert.deepEqual(Object.keys(got).sort(), ['builder', 'judge'])
    for (const [r, ms] of Object.entries(want)) {
      assert.deepEqual(Object.keys(got[r]).sort(), Object.keys(ms).sort())
      for (const [k, v] of Object.entries(ms)) assert.ok(Math.abs(got[r][k] - v) < 1e-9, `${r}/${k}: ${got[r][k]}`)
    }
  }
  close(g.ledger.byRoleModel)
  const lap = lapTotals(lapFile) // summed from the append-only lines: the same totals as the lap-4 totals file
  close(lap.byRoleModel)
  assert.ok(Math.abs(lap.totalUsd - 1.5) < 1e-9)
  // a re-draft's ledger adds to the earlier one, per role and model
  const before = JSON.stringify(g.ledger.byRoleModel)
  assert.ok(Math.abs(mergeLedger(g.ledger, g.ledger).byRoleModel!.builder['claude-opus-5-5'] - 0.8) < 1e-9)
  assert.equal(JSON.stringify(g.ledger.byRoleModel), before) // merge does not mutate its inputs
  assert.deepEqual(mergeLedger({ note: '', byRole: {}, totalUsd: 0, uncounted: [] }, g.ledger).byRoleModel, g.ledger.byRoleModel) // a lap-3 ledger has no split
})

// #13: the lap ledger is append-only, so parallel runs never lose a charge, and the lap cap holds under them.
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function fastPoll<T>(f: () => Promise<T>): Promise<T> {
  const p = CAPS.pollMs
  CAPS.pollMs = 10
  try { return await f() } finally { CAPS.pollMs = p }
}

test('lap ledger: concurrent guards lose no charge; the lap total is the sum of every call', async () => {
  const lapFile = join(tmp('lapconc'), 'lap-ledger.jsonl')
  const guards = Array.from({ length: 6 }, () => startGuard(5, join(sd, 'NOSTOP'), { lapFile }))
  await Promise.all(guards.map(async (g, i) => {
    const m = g.model(async () => { await sleep(Math.random() * 5); return { ok: true, text: '', costUsd: 0.01 * (i + 1) } })
    for (let n = 0; n < 15; n++) await m(task('builder'))
  }))
  guards.forEach((g) => g.dispose())
  near(lapSpent(lapFile), guards.reduce((a, g) => a + g.ledger.totalUsd, 0))
  near(lapSpent(lapFile), 15 * 0.01 * (1 + 2 + 3 + 4 + 5 + 6))
  assert.equal(readFileSync(lapFile, 'utf8').split('\n').filter(Boolean).length, 6 * 15 * 2) // a hold and a charge per call
})

test('lap ledger: several processes appending at once lose and tear no line', () => {
  const lapFile = join(tmp('lapproc'), 'lap-ledger.jsonl')
  const code = `import('${join(REPO_SRC, 'limits.ts')}').then(({ chargeLap }) => { for (let i = 0; i < 300; i++) chargeLap(process.argv[1], 0.01, 'builder') })`
  const kids = Array.from({ length: 4 }, () => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', code, lapFile], { stdio: 'inherit' }))
  return Promise.all(kids.map((k) => new Promise((ok) => k.on('exit', ok)))).then((codes) => {
    assert.deepEqual(codes, [0, 0, 0, 0])
    near(lapSpent(lapFile), 4 * 300 * 0.01)
  })
})

test('lap cap: calls started together just below the cap never take it past the cap', () => fastPoll(async () => {
  const lapFile = join(tmp('lapedge'), 'lap-ledger.jsonl')
  chargeLap(lapFile, CAPS.lapCostUsd - 1, 'builder')
  const seen: number[] = []
  const results = await Promise.allSettled(Array.from({ length: 5 }, async () => {
    const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile })
    try { return await g.model(async (t) => { seen.push(t.maxCostUsd); await sleep(30); return { ok: true, text: '', costUsd: t.maxCostUsd } })({ ...task('builder'), maxCostUsd: 0.6 }) } finally { g.dispose() }
  }))
  assert.deepEqual(seen, [0.6, 0.4]) // what the first held was not handed out twice
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof Stop && /lap cost cap reached/.test(r.reason.message)).length, 3)
  near(lapSpent(lapFile), CAPS.lapCostUsd)
}))

test('lap cap: a call held back by a sibling gets its whole budget once the sibling spent little', () => fastPoll(async () => {
  const lapFile = join(tmp('lapwait'), 'lap-ledger.jsonl')
  chargeLap(lapFile, CAPS.lapCostUsd - 1, 'builder')
  const seen: number[] = []
  const go = () => {
    const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile })
    return g.model(async (t) => { seen.push(t.maxCostUsd); await sleep(30); return { ok: true, text: '', costUsd: 0.01 } })({ ...task('builder'), maxCostUsd: 0.6 }).finally(() => g.dispose())
  }
  await Promise.all([go(), go()])
  assert.deepEqual(seen, [0.6, 0.6])
}))

test('lap ledger: an unsettled hold and a throwing model count in full; a malformed line refuses', async () => {
  const dir = tmp('lapbad'), lapFile = join(dir, 'lap-ledger.jsonl')
  holdLap(lapFile, 0.7, 'builder') // the process died mid-call: never settled
  near(lapSpent(lapFile), 0.7)
  assert.deepEqual(lapTotals(lapFile).byRoleModel, { builder: { [UNATTRIBUTED]: 0.7 } })
  const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile })
  await assert.rejects(g.model(async () => { throw new Error('boom') })({ ...task('builder'), maxCostUsd: 0.5 }), /boom/)
  g.dispose()
  near(lapSpent(lapFile), 1.2)
  assert.deepEqual(g.ledger.uncounted, [{ role: 'builder', reason: 'model threw: boom', chargedUsd: 0.5 }])
  for (const bad of ['{"call":"x"', '{}', '{"call":"x","role":"b","usd":-5}', '{"call":"x","role":"b","usd":"1"}', '{"call":"x","role":"b","hold":1,"usd":1}']) {
    writeFileSync(lapFile, `${bad}\n`)
    assert.throws(() => lapSpent(lapFile), /refusing to guess/, bad)
  }
  writeFileSync(join(dir, 'lap-ledger.json'), JSON.stringify({ totalUsd: 'x' })) // a pre-#13 totals file
  writeFileSync(lapFile, '')
  assert.throws(() => lapSpent(lapFile), /no valid totalUsd/)
  writeFileSync(join(dir, 'lap-ledger.json'), JSON.stringify({ totalUsd: 2, byRoleModel: { judge: { m: 2 } } }))
  chargeLap(lapFile, 1, 'judge', { m: 1 })
  assert.deepEqual(lapTotals(lapFile), { totalUsd: 3, byRoleModel: { judge: { m: 3 } }, countedCalls: 0 })
})

test('a budget is rounded down to the CLI precision; under $0.0001 left is a stop, not a free call', async () => {
  const lapFile = join(tmp('lapround'), 'lap-ledger.jsonl')
  chargeLap(lapFile, CAPS.lapCostUsd - 0.00005, 'builder')
  const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile })
  let calls = 0
  await assert.rejects(g.model(async () => { calls++; return { ok: true, text: '', costUsd: 0 } })(task('builder')), Stop)
  g.dispose()
  assert.equal(calls, 0)
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

test('run --feedback bare: the retry gets one bare line per failed scenario, recorded in run.json', async () => {
  approvedChange(sd, 'bare-fb')
  const seen: string[] = []
  const model: Model = async (t) => { if (t.role === 'builder') seen.push(t.instruction); return { ok: true, text: '{"pass":true}', costUsd: 0.01 } } // builds nothing
  const r = await runChange({ changeId: 'bare-fb', shipTarget: gitTarget(), model, stateDir: sd, port: await freePort(), maxAttempts: 2, stopFile: join(sd, 'NOSTOP'), feedback: 'bare' })
  const failed = r.attempts[0].results.filter((x) => !x.pass).length
  assert.ok(failed > 0)
  assert.equal(seen[1].split('Feedback:\n')[1].trim(), Array(failed).fill('- failed: a hidden scenario').join('\n'))
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'bare-fb', 'run.json'), 'utf8')).feedback, 'bare')
  await assert.rejects(runChange({ changeId: 'bare-fb-2', shipTarget: gitTarget(), model, stateDir: sd, port: 1, feedback: 'none' as 'bare' }), /feedback must be/)
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

test('run: a dirty ship target -> failed before going live, target untouched', async () => {
  approvedChange(sd, 'dirty-target')
  const target = gitTarget()
  writeFileSync(join(target, 'stray.txt'), 'local edit')
  const head0 = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString()
  const r = await runChange({ changeId: 'dirty-target', shipTarget: target, model: builderJudge(0.1), stateDir: sd, port: await freePort(), stopFile: join(sd, 'NOSTOP') })
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /local changes/)
  assert.equal(r.shipped, null)
  assert.equal(execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString(), head0)
})

test('run (lap 3): a builder timeout is charged the builder ceiling, so the retries go on', async () => {
  approvedChange(sd, 'builder-ceiling')
  const seen: [string, number][] = []
  const r = await runChange({ changeId: 'builder-ceiling', shipTarget: gitTarget(), stateDir: sd, port: 1, maxCostUsd: 28, maxAttempts: 2, stopFile: join(sd, 'NOSTOP'),
    model: async (t) => { seen.push([t.role, t.maxCostUsd]); return t.role === 'builder' ? { ok: false, text: '', costUsd: null, error: 'timed out' } : { ok: true, text: '{"pass":false}', costUsd: 0.1 } } })
  assert.equal(r.attempts.length, 2)
  assert.match(r.stopReason, /retry cap/)
  assert.deepEqual(seen.map(([role]) => role), ['builder', 'judge', 'builder', 'judge'])
  assert.ok(seen.every(([role, usd]) => usd <= (role === 'builder' ? CAPS.builderCallUsd : CAPS.judgeCallUsd))) // the lap ledger of this file may bind lower
  assert.deepEqual(r.cost.uncounted.map((u) => u.chargedUsd), [CAPS.builderCallUsd, CAPS.builderCallUsd])
})

// Lap 8: a model priced in calls (the second family) is counted, never charged a USD ceiling, and capped per lap.
test('counted calls: $0 in USD, one lap-ledger call each (repairs and failures too), refused at the lap cap before the call', async () => {
  const lapFile = join(tmp('lapcount'), 'lap-ledger.jsonl'), cap = CAPS.lapCountedCalls
  CAPS.lapCountedCalls = 3
  try {
    const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile, models: { 'spec-drafter': 'gpt-6-astra' } })
    const seen: (string | undefined)[] = []
    const m = g.model(async (t) => { seen.push(t.model); return t.role === 'classifier' ? { ok: true, text: '', costUsd: 0.25, model: 'claude-opus-5-5' } : { ok: false, text: '', costUsd: null, error: 'x' } })
    await m(task('spec-drafter'))
    await m(task('classifier'))
    await m(task('spec-drafter')) // a failed call that reported no cost: still $0, still one call
    await assert.rejects(g.model(async () => { throw new Error('boom') })(task('spec-drafter')), /boom/)
    let calls = 0
    await assert.rejects(g.model(async () => { calls++; return { ok: true, text: '', costUsd: 0 } })(task('spec-drafter')), /lap cap on calls not priced in USD reached \(3 calls\)/)
    g.dispose()
    assert.equal(calls, 0)
    assert.deepEqual(seen, ['gpt-6-astra', undefined, 'gpt-6-astra']) // the override is applied by the guard
    assert.equal(g.ledger.totalUsd, 0.25)
    assert.deepEqual(g.ledger.uncounted, [])
    assert.equal(g.ledger.countedCalls, 3)
    assert.deepEqual(g.ledger.calls!.map((c) => [c.role, c.requested, c.answered, c.counted ?? false]),
      [['spec-drafter', 'gpt-6-astra', null, true], ['classifier', 'claude-opus-5-5', 'claude-opus-5-5', false], ['spec-drafter', 'gpt-6-astra', null, true], ['spec-drafter', 'gpt-6-astra', null, true]])
    const t = lapTotals(lapFile)
    assert.equal(t.countedCalls, 3)
    near(t.totalUsd, 0.25)
    assert.deepEqual(t.byRoleModel['spec-drafter'], { 'gpt-6-astra': 0 })
  } finally { CAPS.lapCountedCalls = cap }
})

test('counted calls: a hold never settled (the process died) still counts; a bad mark refuses', () => {
  const lapFile = join(tmp('lapcount2'), 'lap-ledger.jsonl')
  holdLap(lapFile, 0, 'scenario-drafter', true)
  holdLap(lapFile, 0.5, 'builder')
  assert.equal(lapTotals(lapFile).countedCalls, 1)
  writeFileSync(lapFile, '{"call":"x","role":"b","hold":0,"counted":1}\n')
  assert.throws(() => lapTotals(lapFile), /bad counted mark/)
})

test('guard: a model the role may not use is refused before anything is spent or held', async () => {
  const lapFile = join(tmp('lapcount3'), 'lap-ledger.jsonl')
  const g = startGuard(5, join(sd, 'NOSTOP'), { lapFile, models: { builder: 'gpt-6-astra' } })
  let calls = 0
  await assert.rejects(g.model(async () => { calls++; return { ok: true, text: '', costUsd: 0 } })(task('builder')), /only/)
  g.dispose()
  assert.equal(calls, 0)
  assert.equal(existsSync(lapFile), false)
})
