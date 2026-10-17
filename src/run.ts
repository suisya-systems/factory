// One change through the loop: build -> judge (-> retry) -> ship -> observe.
// Every exit that is not "shipped" is "failed" with a reason. No human is asked, nothing re-enqueued.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CAPS, startGuard, Stop, type Ledger } from './limits.ts'
import { build, feedbackFor, judge, type Verdict } from './roles.ts'
import { observe } from './serve.ts'
import { ship, type PassMark } from './ship.ts'
import { loadApproved, checkId } from './vault.ts'
import type { ScenarioResult } from './scenario.ts'

export type RunOpts = { changeId: string; shipTarget: string; model: Model; stateDir: string; port: number; maxCostUsd?: number; maxAttempts?: number; stopFile?: string; trafficBase?: string }

const rate = (rs: ScenarioResult[], inSpec: boolean) => {
  const xs = rs.filter((r) => r.inSpec === inSpec)
  return { passed: xs.filter((r) => r.pass).length, total: xs.length }
}

// ponytail: fixed synthetic traffic shaped for a CRUD resource at `base`; derive from the spec when apps vary.
async function syntheticTraffic(port: number, base: string) {
  const u = (p: string) => `http://127.0.0.1:${port}${p}`
  const go = (p: string, init?: RequestInit) => fetch(u(p), { ...init, signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => '')
  await go(base)
  await go(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'synthetic', body: 'probe' }) })
  await go(base)
  await go(`${base}/does-not-exist`)
  await go('/no-such-route')
}

export async function runChange(o: RunOpts) {
  const id = checkId(o.changeId)
  const capUsd = o.maxCostUsd ?? CAPS.maxCostUsd
  const maxAttempts = o.maxAttempts ?? CAPS.maxAttempts
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error(`max cost must be a positive number, got ${capUsd}`)
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) throw new Error(`max attempts must be an integer >= 1, got ${maxAttempts}`)
  const runDir = join(o.stateDir, 'runs', id)
  if (existsSync(join(runDir, 'run.json'))) throw new Error(`${id} already ran; a new attempt must enter as a new change`)
  const approved = loadApproved(o.stateDir, id)
  mkdirSync(runDir, { recursive: true })
  const draftFile = join(runDir, 'draft-cost.json') // written by `draft`; reported here so the change's cost is in one record
  const draftCost: Ledger | null = existsSync(draftFile) ? JSON.parse(readFileSync(draftFile, 'utf8')) : null
  // The per-change cap covers all roles: the drafter's spend is already counted against it.
  const guard = startGuard(capUsd, o.stopFile ?? process.env.FACTORY_STOP_FILE ?? join(o.stateDir, 'STOP'),
    { spentUsd: draftCost?.totalUsd ?? 0, lapFile: join(o.stateDir, 'lap-ledger.json') })
  const model = guard.model(o.model)
  const record = {
    changeId: id, approvedVersion: approved.version, status: 'running' as 'running' | 'shipped' | 'failed', stopReason: '',
    caps: { maxCostUsd: capUsd, maxAttempts },
    attempts: [] as { n: number; sha: string; builderOk: boolean; testsAllPass: boolean; llmPass: boolean | null; pass: boolean; approvedVersion: string; passRate: { inSpec: object; notInSpec: object }; results: ScenarioResult[] }[],
    llmOnlyRejections: 0, // attempts where every deterministic test passed but the LLM judge did not approve
    judgeFailures: 0, // attempts where the LLM judge gave no verdict (call failed / unparseable reply)
    passedWithinCap: false, shipped: null as null | { sha: string; release: string }, signals: null as unknown,
    cost: guard.ledger as Ledger, // build + judge (the per-change cap applies to these + draftCost)
    draftCost, // drafter, spent before approval
    totalUsdAllRoles: 0,
  }
  const save = () => {
    record.totalUsdAllRoles = (draftCost?.totalUsd ?? 0) + guard.ledger.totalUsd
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(record, null, 2))
  }
  save()
  try {
    const work = join(o.stateDir, 'work', id)
    if (!existsSync(work)) execFileSync('git', ['clone', '-q', '--no-hardlinks', o.shipTarget, work], { stdio: 'pipe' })
    let feedback = ''
    let passed: Verdict | null = null
    let sha = ''
    for (let n = 1; n <= maxAttempts; n++) {
      guard.check()
      const b = await build(model, work, approved.spec, feedback, guard.signal)
      sha = b.sha
      const v = await judge(model, work, sha, approved.spec, approved.scenarios, approved.version, guard.signal)
      record.attempts.push({ n, sha, builderOk: b.ok, testsAllPass: v.testsAllPass, llmPass: v.llmPass, pass: v.pass, approvedVersion: v.approvedVersion,
        passRate: { inSpec: rate(v.results, true), notInSpec: rate(v.results, false) }, results: v.results })
      if (v.testsAllPass && v.llmPass === false) record.llmOnlyRejections++
      if (v.llmPass === null && !v.stop) record.judgeFailures++
      save()
      if (v.stop) throw v.stop // recorded first: the deterministic results of this attempt are kept
      if (v.pass) { passed = v; break }
      feedback = feedbackFor(v, approved.scenarios)
    }
    if (!passed) throw new Stop(`retry cap reached: ${maxAttempts} attempts without a pass`)
    record.passedWithinCap = true
    guard.check()
    const mark: PassMark = { changeId: id, sha, approvedVersion: approved.version }
    writeFileSync(join(runDir, 'pass.json'), JSON.stringify(mark, null, 2))
    const { release } = await ship(mark, work, o.shipTarget, o.stateDir, o.port, guard.signal)
    record.shipped = { sha, release }
    guard.check() // a stop during the (uncancellable) last phase of ship: live, but the change is NOT reported as clean
    await syntheticTraffic(o.port, o.trafficBase ?? '/memos')
    await new Promise((r) => setTimeout(r, 200))
    guard.check()
    record.signals = observe(o.stateDir)
    record.status = 'shipped'
  } catch (e) {
    let err = e as Error
    if (!(err instanceof Stop) && guard.signal.aborted) try { guard.check() } catch (s) { err = s as Error } // surface the stop reason
    record.status = 'failed'
    record.stopReason = err instanceof Stop ? err.message : `error: ${err.message}`
  } finally {
    guard.dispose()
    save()
  }
  return record
}
