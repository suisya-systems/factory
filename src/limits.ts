// The 3 stop conditions: per-change cost cap, retry cap, emergency stop from outside the process.
// Any of them ends the change as FAILED. Nobody is asked; nothing is re-enqueued.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { countedInCalls, requestedModel, type Model, type Result } from './adapter.ts'

// The ONE place for caps. Changing them is an owner decision, not something a role can do.
// maxAttempts: 5 since lap 3 (owner decision 2026-10-17; it was 3). builderCallUsd / judgeCallUsd: per-call
// ceilings (lap 3; lap 2 spent $0.47 / $0.23 per call). userCallUsd: one turn of the user agent (#30, no tools).
// maxCostUsd: $40 since lap 14 (it was $10; the classifier ($1) and drafter ($2) per-call ceilings rose with it). lapCostUsd: $260 since lap 9, screen included (owner decision 2026-10-18); $150 in lap 8, $30 in laps 1-7. lapCountedCalls: calls of models whose
// spend is not reported in USD (lap 8: 200 by the owner, 1 of them spent outside the factory on the adapter smoke).
export const CAPS = { maxCostUsd: 40, lapCostUsd: 260, lapCountedCalls: 199, maxAttempts: 5, builderCallUsd: 5, judgeCallUsd: 2, userCallUsd: 0.5, modelTimeoutMs: 20 * 60_000, pollMs: 500 }

export class Stop extends Error {}

export type Ledger = {
  note: string
  byRole: Record<string, number>
  totalUsd: number
  uncounted: { role: string; reason: string; chargedUsd: number }[]
  modelByRole?: Record<string, string> // which model answered each role (as reported)
  byRoleModel?: CostSplit // lap 4: the same cost per role, split per model (see modelSplit)
  // Lap 8: every call in order (a repair round shows as a second call of the same role), and the calls counted
  // instead of priced. answered: the model the call reported (null: it reported none).
  calls?: { role: string; requested: string | null; answered: string | null; counted?: true }[]
  countedCalls?: number
}

// role -> model -> USD. Since lap 4, so the cost of models the CLI calls internally is visible.
export type CostSplit = Record<string, Record<string, number>>
// The part of a call's charged cost the CLI did not attribute to any model (e.g. a call that reported no cost).
export const UNATTRIBUTED = '(unattributed)'
export function modelSplit(costUsd: number, byModel: Record<string, number> = {}): Record<string, number> {
  const out = { ...byModel }
  const rest = costUsd - Object.values(out).reduce((a, b) => a + b, 0)
  if (Math.abs(rest) > 1e-9) out[UNATTRIBUTED] = rest
  return out
}
function addSplit(to: CostSplit, from: CostSplit): CostSplit {
  for (const [role, models] of Object.entries(from)) for (const [m, usd] of Object.entries(models)) (to[role] ??= {})[m] = (to[role][m] ?? 0) + usd
  return to
}

export type Guard = {
  signal: AbortSignal
  ledger: Ledger
  check(): void // throws Stop if the emergency stop fired
  model(m: Model): Model // wraps a model with cost cap + stop
  dispose(): void
}

// Lap-wide spend. A lap is one owner-budgeted run of the factory loop; its ledger counts every model call
// of every change and command in this state dir. Append-only (#13), so parallel runs never lose a charge:
// before a call a hold line reserves its whole budget, after it a charge line settles it. A hold that was never
// settled (the process died mid-call, or the charge could not be written) counts in full.
// A state dir from before #13 has lap-ledger.json (totals); it is still counted, never written.
// counted: a call of a model priced in calls, not USD (lap 8). It holds and charges $0; every hold is one call.
// event: a line that moves no money, so the ledger also reads as the lap's history (#32: a redraft and why).
type LapLine = { call: string; role: string; hold?: number; usd?: number; byModel?: Record<string, number>; counted?: true; event?: string }
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const usdOk = (x: unknown): x is number => finite(x) && x >= 0
export function lapTotals(f: string): { totalUsd: number; byRoleModel: CostSplit; countedCalls: number } {
  const bad = (m: string) => new Error(`lap ledger ${f}: ${m}; refusing to guess what was spent`)
  const legacy = f.replace(/\.jsonl$/, '.json')
  const old = legacy !== f && existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : { totalUsd: 0 }
  if (!usdOk(old.totalUsd)) throw bad(`${legacy} has no valid totalUsd`)
  const byRoleModel = addSplit({}, old.byRoleModel ?? {})
  const held = new Map<string, LapLine>(), settled = new Set<string>()
  let totalUsd = old.totalUsd, countedCalls = 0
  for (const [i, l] of (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []).entries()) {
    let x: LapLine
    try { x = JSON.parse(l) } catch { throw bad(`line ${i + 1} is not JSON`) }
    if (x?.event !== undefined) { if (typeof x.event !== 'string' || x.hold !== undefined || x.usd !== undefined) throw bad(`line ${i + 1}: an event moves no money`); continue }
    if (typeof x?.call !== 'string' || typeof x.role !== 'string' || (x.hold === undefined) === (x.usd === undefined)) throw bad(`line ${i + 1} is neither a hold nor a charge`)
    if (x.counted !== undefined && x.counted !== true) throw bad(`line ${i + 1}: bad counted mark`)
    if (x.hold !== undefined) { if (!usdOk(x.hold)) throw bad(`line ${i + 1}: bad hold`); if (x.counted) countedCalls++; held.set(x.call, x); continue }
    if (!usdOk(x.usd) || !Object.values(x.byModel ?? {}).every(finite)) throw bad(`line ${i + 1}: bad charge`)
    settled.add(x.call)
    totalUsd += x.usd
    addSplit(byRoleModel, { [x.role]: x.byModel ?? {} })
  }
  for (const [call, h] of held) if (!settled.has(call)) { totalUsd += h.hold!; addSplit(byRoleModel, { [h.role]: { [UNATTRIBUTED]: h.hold! } }) }
  return { totalUsd, byRoleModel, countedCalls }
}
// ponytail: re-reads and sums the whole file on every call (O(lines)); a lap has hundreds of calls.
export const lapSpent = (f: string): number => lapTotals(f).totalUsd
const line = (f: string, l: LapLine) => appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), ...l })}\n`) // one write: O_APPEND keeps lines whole
export const noteLap = (f: string, event: string, o: Record<string, unknown>) => appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), event, ...o })}\n`)
const mark = (counted: boolean) => (counted ? { counted: true as const } : {})
export function holdLap(f: string, usd: number, role: string, counted = false): string {
  const call = randomUUID()
  line(f, { call, role, hold: usd, ...mark(counted) })
  return call
}
export function chargeLap(f: string, usd: number, role: string, byModel?: Record<string, number>, call: string = randomUUID(), counted = false): void {
  line(f, { call, role, usd, byModel: modelSplit(usd, byModel), ...mark(counted) })
}
// Calls of THIS process holding lap budget right now. They settle soon, so a call that would get less than
// it would with them settled waits for them instead of starting short.
// ponytail: per process; another factory command on the same state dir is only seen through its hold lines.
const inFlight = new Map<string, number>()
const flying = (f: string, d: number) => inFlight.set(resolve(f), (inFlight.get(resolve(f)) ?? 0) + d)
// CLI budgets have 4 decimals: round down, so a call is never allowed more than was reserved for it.
const floor4 = (x: number) => Math.floor(x * 1e4 + 1e-9) / 1e4

export function mergeLedger(a: Ledger | null, b: Ledger): Ledger {
  if (!a) return b
  const byRole = { ...a.byRole }
  for (const [k, v] of Object.entries(b.byRole)) byRole[k] = (byRole[k] ?? 0) + v
  return { note: b.note, byRole, totalUsd: a.totalUsd + b.totalUsd, uncounted: [...a.uncounted, ...b.uncounted], modelByRole: { ...a.modelByRole, ...b.modelByRole },
    byRoleModel: addSplit(addSplit({}, a.byRoleModel ?? {}), b.byRoleModel ?? {}), calls: [...a.calls ?? [], ...b.calls ?? []], countedCalls: (a.countedCalls ?? 0) + (b.countedCalls ?? 0) }
}

// spentUsd: already spent on this change elsewhere (the drafter), counted against capUsd.
// lapFile: the lap ledger; each call also gets at most what is left of CAPS.lapCostUsd (minus what calls in flight hold).
// models: `--model` overrides per role (lap 8: applied here, so the guard knows which model a call goes to before it starts).
export function startGuard(capUsd: number, stopFile: string, o: { spentUsd?: number; lapFile?: string; models?: Record<string, string> } = {}): Guard {
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error(`cost cap must be a positive number, got ${capUsd}`)
  const ac = new AbortController()
  let reason = ''
  const fire = (why: string) => { if (!ac.signal.aborted) { reason = why; ac.abort() } }
  const look = () => { if (existsSync(stopFile)) fire(`emergency stop: ${stopFile} exists`) }
  const poll = setInterval(look, CAPS.pollMs)
  poll.unref() // never the reason the process stays alive
  const onSig = (s: string) => () => fire(`emergency stop: ${s}`)
  const onTerm = onSig('SIGTERM'), onInt = onSig('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  look()

  const ledger: Ledger = {
    note: 'costs are client-side estimates: the total cost the model CLI reports per call, summed per role. A call that reported no cost is charged its whole allowed budget (see uncounted).',
    byRole: {}, totalUsd: 0, uncounted: [], modelByRole: {}, byRoleModel: {}, calls: [], countedCalls: 0,
  }
  const check = () => { look(); if (ac.signal.aborted) throw new Stop(reason) } // look(): do not wait for the next poll
  return {
    signal: ac.signal,
    ledger,
    check,
    model: (m) => async (asked) => {
      const task = Object.hasOwn(o.models ?? {}, asked.role) ? { ...asked, model: o.models![asked.role] } : asked
      check()
      const requested = requestedModel(task) // throws for a model the role may not use, before anything is spent
      if (countedInCalls(requested)) {
        // Read and reserve with no await between, as for USD. Counted from the hold: a stopped call is a call.
        if (o.lapFile && lapTotals(o.lapFile).countedCalls >= CAPS.lapCountedCalls) throw new Stop(`lap cap on calls not priced in USD reached (${CAPS.lapCountedCalls} calls)`)
        const call = o.lapFile ? holdLap(o.lapFile, 0, task.role, true) : ''
        ledger.countedCalls!++
        let r: Result, thrown: unknown
        try { r = await m({ ...task, signal: ac.signal }) } catch (e) { thrown = e; r = { ok: false, text: '', costUsd: null, error: `model threw: ${(e as Error).message}` } }
        ledger.calls!.push({ role: task.role, requested, answered: r.model ?? null, counted: true })
        addSplit(ledger.byRoleModel!, { [task.role]: { [requested!]: 0 } })
        if (o.lapFile) chargeLap(o.lapFile, 0, task.role, { [requested!]: 0 }, call, true)
        if (thrown) throw thrown
        check()
        return r
      }
      const spent = (o.spentUsd ?? 0) + ledger.totalUsd
      const want = Math.min(task.maxCostUsd, capUsd - spent)
      let lapLeft = Infinity
      // Read and reserve with no await between: no other call of this process can take the same room.
      if (o.lapFile) for (;;) {
        lapLeft = CAPS.lapCostUsd - lapSpent(o.lapFile)
        if (lapLeft >= want || !inFlight.get(resolve(o.lapFile))) break
        await new Promise((r) => setTimeout(r, CAPS.pollMs))
        check()
      }
      if (lapLeft <= 0) throw new Stop(`lap cost cap reached ($${CAPS.lapCostUsd})`)
      if (capUsd - spent <= 0) throw new Stop(`cost cap reached ($${spent.toFixed(4)} of $${capUsd})`)
      const remaining = floor4(Math.min(want, lapLeft)) // a call's own ceiling (e.g. classifier) binds too
      if (remaining <= 0) throw new Stop(`cost cap reached (less than $0.0001 left)`)
      const call = o.lapFile ? holdLap(o.lapFile, remaining, task.role) : ''
      if (o.lapFile) flying(o.lapFile, 1)
      let r: Result, thrown: unknown
      try { r = await m({ ...task, maxCostUsd: remaining, signal: ac.signal }) } catch (e) { thrown = e; r = { ok: false, text: '', costUsd: null, error: `model threw: ${(e as Error).message}` } }
      // No reported cost (e.g. killed on timeout, or the model threw): money may still have been spent. Charge
      // the whole budget the call was allowed, so the cap still binds (the next call then gets nothing).
      const cost = r.costUsd ?? remaining
      try {
        if (r.costUsd === null) ledger.uncounted.push({ role: task.role, reason: r.error ?? 'no cost reported', chargedUsd: remaining })
        ledger.byRole[task.role] = (ledger.byRole[task.role] ?? 0) + cost
        if (r.model) ledger.modelByRole![task.role] = r.model
        ledger.calls!.push({ role: task.role, requested, answered: r.model ?? null })
        addSplit(ledger.byRoleModel!, { [task.role]: modelSplit(cost, r.costByModel) })
        ledger.totalUsd += cost
        if (o.lapFile) chargeLap(o.lapFile, cost, task.role, r.costByModel, call) // if this throws, the hold still counts in full
      } finally { if (o.lapFile) flying(o.lapFile, -1) } // after the charge: a waiting call never sees neither
      if (thrown) throw thrown
      check()
      if (spent + cost > capUsd) throw new Stop(`cost cap exceeded ($${(spent + cost).toFixed(4)} of $${capUsd})`)
      if (o.lapFile && lapSpent(o.lapFile) > CAPS.lapCostUsd) throw new Stop(`lap cost cap exceeded ($${CAPS.lapCostUsd})`)
      return r
    },
    dispose: () => {
      clearInterval(poll)
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
    },
  }
}
