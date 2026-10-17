// The 3 stop conditions: per-change cost cap, retry cap, emergency stop from outside the process.
// Any of them ends the change as FAILED. Nobody is asked; nothing is re-enqueued.
import { existsSync } from 'node:fs'
import type { Model } from './adapter.ts'

// The ONE place for caps. Changing them is an owner decision, not something a role can do.
export const CAPS = { maxCostUsd: 10, maxAttempts: 3, modelTimeoutMs: 20 * 60_000, pollMs: 500 }

export class Stop extends Error {}

export type Ledger = {
  note: string
  byRole: Record<string, number>
  totalUsd: number
  uncounted: { role: string; reason: string; chargedUsd: number }[]
}

export type Guard = {
  signal: AbortSignal
  ledger: Ledger
  check(): void // throws Stop if the emergency stop fired
  model(m: Model): Model // wraps a model with cost cap + stop
  dispose(): void
}

export function startGuard(capUsd: number, stopFile: string): Guard {
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
    byRole: {}, totalUsd: 0, uncounted: [],
  }
  const check = () => { look(); if (ac.signal.aborted) throw new Stop(reason) } // look(): do not wait for the next poll
  return {
    signal: ac.signal,
    ledger,
    check,
    model: (m) => async (task) => {
      check()
      const remaining = capUsd - ledger.totalUsd
      if (remaining <= 0) throw new Stop(`cost cap reached ($${ledger.totalUsd.toFixed(4)} of $${capUsd})`)
      const r = await m({ ...task, maxCostUsd: remaining, signal: ac.signal })
      // No reported cost (e.g. killed on timeout): money may still have been spent. Charge the whole
      // budget the call was allowed, so the cap still binds (the next call then gets nothing).
      const cost = r.costUsd ?? remaining
      if (r.costUsd === null) ledger.uncounted.push({ role: task.role, reason: r.error ?? 'no cost reported', chargedUsd: remaining })
      ledger.byRole[task.role] = (ledger.byRole[task.role] ?? 0) + cost
      ledger.totalUsd += cost
      check()
      if (ledger.totalUsd > capUsd) throw new Stop(`cost cap exceeded ($${ledger.totalUsd.toFixed(4)} of $${capUsd})`)
      return r
    },
    dispose: () => {
      clearInterval(poll)
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
    },
  }
}
