// The 3 stop conditions: per-change cost cap, retry cap, emergency stop from outside the process.
// Any of them ends the change as FAILED. Nobody is asked; nothing is re-enqueued.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Model } from './adapter.ts'

// The ONE place for caps. Changing them is an owner decision, not something a role can do.
// maxAttempts: 5 since lap 3 (owner decision 2026-10-17; it was 3). builderCallUsd / judgeCallUsd: per-call
// ceilings (lap 3; lap 2 spent $0.47 / $0.23 per call).
export const CAPS = { maxCostUsd: 10, lapCostUsd: 30, maxAttempts: 5, builderCallUsd: 5, judgeCallUsd: 2, modelTimeoutMs: 20 * 60_000, pollMs: 500 }

export class Stop extends Error {}

export type Ledger = {
  note: string
  byRole: Record<string, number>
  totalUsd: number
  uncounted: { role: string; reason: string; chargedUsd: number }[]
  modelByRole?: Record<string, string> // which model answered each role (as reported)
  byRoleModel?: CostSplit // lap 4: the same cost per role, split per model (see modelSplit)
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
// of every change and command in this state dir.
// ponytail: read-modify-write without a lock; assumes one factory command at a time.
const readLap = (f: string): { totalUsd: number; byRoleModel?: CostSplit } => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { totalUsd: 0 })
export const lapSpent = (f: string): number => readLap(f).totalUsd
export function chargeLap(f: string, usd: number, role: string, byModel?: Record<string, number>): void {
  const l = readLap(f)
  writeFileSync(f, JSON.stringify({ note: 'lap-wide client-side estimate, all roles and commands; byRoleModel: role -> model -> USD (since lap 4)',
    totalUsd: l.totalUsd + usd, byRoleModel: addSplit(l.byRoleModel ?? {}, { [role]: modelSplit(usd, byModel) }) }, null, 2))
}

export function mergeLedger(a: Ledger | null, b: Ledger): Ledger {
  if (!a) return b
  const byRole = { ...a.byRole }
  for (const [k, v] of Object.entries(b.byRole)) byRole[k] = (byRole[k] ?? 0) + v
  return { note: b.note, byRole, totalUsd: a.totalUsd + b.totalUsd, uncounted: [...a.uncounted, ...b.uncounted], modelByRole: { ...a.modelByRole, ...b.modelByRole },
    byRoleModel: addSplit(addSplit({}, a.byRoleModel ?? {}), b.byRoleModel ?? {}) }
}

// spentUsd: already spent on this change elsewhere (the drafter), counted against capUsd.
// lapFile: the lap ledger; each call also gets at most what is left of CAPS.lapCostUsd.
export function startGuard(capUsd: number, stopFile: string, o: { spentUsd?: number; lapFile?: string } = {}): Guard {
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
    byRole: {}, totalUsd: 0, uncounted: [], modelByRole: {}, byRoleModel: {},
  }
  const check = () => { look(); if (ac.signal.aborted) throw new Stop(reason) } // look(): do not wait for the next poll
  return {
    signal: ac.signal,
    ledger,
    check,
    model: (m) => async (task) => {
      check()
      const spent = (o.spentUsd ?? 0) + ledger.totalUsd
      const lapLeft = o.lapFile ? CAPS.lapCostUsd - lapSpent(o.lapFile) : Infinity
      if (lapLeft <= 0) throw new Stop(`lap cost cap reached ($${CAPS.lapCostUsd})`)
      if (capUsd - spent <= 0) throw new Stop(`cost cap reached ($${spent.toFixed(4)} of $${capUsd})`)
      const remaining = Math.min(task.maxCostUsd, capUsd - spent, lapLeft) // a call's own ceiling (e.g. classifier) binds too
      const r = await m({ ...task, maxCostUsd: remaining, signal: ac.signal })
      // No reported cost (e.g. killed on timeout): money may still have been spent. Charge the whole
      // budget the call was allowed, so the cap still binds (the next call then gets nothing).
      const cost = r.costUsd ?? remaining
      if (r.costUsd === null) ledger.uncounted.push({ role: task.role, reason: r.error ?? 'no cost reported', chargedUsd: remaining })
      ledger.byRole[task.role] = (ledger.byRole[task.role] ?? 0) + cost
      if (r.model) ledger.modelByRole![task.role] = r.model
      addSplit(ledger.byRoleModel!, { [task.role]: modelSplit(cost, r.costByModel) })
      ledger.totalUsd += cost
      if (o.lapFile) chargeLap(o.lapFile, cost, task.role, r.costByModel)
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
