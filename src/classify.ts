// "Can this hidden scenario be read from the spec?" decided by a procedure, not by the drafter's claim.
// Per scenario, a separate session sees ONLY the spec, the existing app code and the scenario's
// requests (no expectations, ids, titles, summaries or kinds) and predicts each response. The
// scenario's real expectations are then compared with the prediction mechanically, three-valued:
// M (the prediction satisfies the check), X (it contradicts it), U (the prediction leaves it open).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { Stop } from './limits.ts'
import { at, fill, get, HEADER, isObj, lengthChecks, type Scenario, type Step } from './scenario.ts'

export type Basis = 'spec' | 'code' | 'convention'
export type Label = 'readable' | 'unstated' | 'contradicts' | 'unknown'
type Tri = 'M' | 'X' | 'U'
export type Prediction = { status: number[] | null; body: unknown; basis: Basis; quote: string }
export type Check = { step: number; check: string; result: Tri; basis: Basis }
// basis: for readable, the weakest basis among the steps that matched (spec > code > convention).
export type Classification = { id: string; label: Label; basis?: Basis; checks: Check[]; predictions?: Prediction[]; error?: string }

export const CLASSIFIER_BUDGET = { maxCostUsd: 0.5, timeoutMs: 3 * 60_000 }

// What the predictor sees of a scenario: the requests only. Anything else (id, title, summary, kind,
// expect) would tell it the intended outcome.
export const requestsOnly = (s: Scenario) => s.steps.map(({ method, path, body, headers, capture }) => ({ method, path, body, headers, capture }))

export function predictInstruction(spec: string, app: string, s: Scenario): string {
  return `You are checking how much a spec determines. Below are a SPEC, the EXISTING APP code it extends (may be empty), and a sequence of HTTP requests sent to a FRESH, EMPTY instance of an app built from that spec. Predict each response from the spec and the code only.

SPEC:
${spec}

EXISTING APP:
${app || '(none)'}

REQUESTS (in order; "{{name}}" is a value captured from an earlier response, per that step's "capture": {"name": "dot.path in the JSON body" or "header:<name>"}):
${JSON.stringify(requestsOnly(s), null, 1)}

Reply with ONE JSON object: {"steps": [one entry per request, in order]}. Each entry:
{"status": [<every status code the spec/code allows here>] or null if they do not determine it,
 "body": <the JSON response body as far as it is determined, or null>,
 "basis": "spec" | "code" | "convention" (where the prediction comes from; "convention" = general HTTP habit, not stated anywhere),
 "quote": "<the exact sentence of the spec or line of code you rely on, copied verbatim; empty for convention>"}
In "body": leave a field OUT when its presence is not determined; write "?" when the field is present but its value is not determined; an array you write is a claim about ALL its items in order, so use "?" for any item you cannot determine; write "{{name}}" where the value equals a captured value. Do not invent ids or timestamps.`
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
const worst = (rs: Tri[]): Tri => (rs.includes('X') ? 'X' : rs.includes('U') ? 'U' : 'M')
const open = (v: unknown) => v === undefined || v === null || v === '?'

// Expected json vs predicted body, leaf by leaf.
function tri(e: unknown, p: unknown): Tri {
  if (open(p) && e !== null) return 'U'
  if (Array.isArray(e)) return !Array.isArray(p) || p.length < e.length ? 'X' : worst(e.map((x, i) => tri(x, p[i])))
  if (isObj(e)) return !isObj(p) ? 'X' : worst(Object.entries(e).map(([k, v]) => tri(v, Object.hasOwn(p, k) ? p[k] : undefined)))
  if (e === null) return p === null ? 'M' : p === undefined || p === '?' ? 'U' : 'X'
  return e === p ? 'M' : 'X'
}

// The checks of one step against one prediction. Captures always bind an opaque marker, so neither
// side's concrete ids matter; a later "{{name}}" on either side becomes the same marker.
export function compareStep(st: Step, p: Prediction, vars: Record<string, unknown>): { check: string; result: Tri }[] {
  const out: { check: string; result: Tri }[] = []
  const e = st.expect
  const body = p.body === null ? undefined : fill(p.body, vars)
  if (e.status !== undefined) {
    const want = ([] as number[]).concat(e.status)
    const got = p.status ?? []
    out.push({ check: `status ${want.join('|')}`, result: !got.length ? 'U' : got.every((c) => want.includes(c)) ? 'M' : got.some((c) => want.includes(c)) ? 'U' : 'X' })
  }
  if (e.isArray !== undefined) out.push({ check: `isArray ${e.isArray}`, result: open(body) ? 'U' : Array.isArray(body) === e.isArray ? 'M' : 'X' })
  for (const [path, n] of lengthChecks(e)) {
    const v = at(body, path)
    out.push({ check: `length ${path || '(top)'} ${n}`, result: open(v) ? 'U' : Array.isArray(v) && v.length === n ? 'M' : 'X' })
  }
  for (const path of e.jsonHas ?? []) out.push({ check: `has ${path}`, result: get(body, path) === undefined ? 'U' : 'M' })
  if (e.json !== undefined) out.push({ check: 'json', result: tri(fill(e.json, vars), body) })
  for (const name of Object.keys(st.capture ?? {})) vars[name] = `\u0000captured:${name}`
  return out
}

// Classifies one scenario from the predictor's reply (already parsed). Throws on a malformed reply.
export function classifyReply(s: Scenario, spec: string, app: string, reply: unknown): Classification {
  const steps = isObj(reply) ? reply.steps : undefined
  if (!Array.isArray(steps) || steps.length !== s.steps.length) throw new Error('prediction does not have one entry per step')
  const preds: Prediction[] = steps.map((x) => {
    if (!isObj(x)) throw new Error('prediction entry is not an object')
    const status = x.status === null || x.status === undefined ? null : ([] as unknown[]).concat(x.status).filter(Number.isInteger) as number[]
    const quote = typeof x.quote === 'string' ? x.quote : ''
    // A claimed spec/code basis counts only if the quote really is in the spec / the code.
    const claimed: Basis = x.basis === 'spec' || x.basis === 'code' ? x.basis : 'convention'
    const source = claimed === 'spec' ? spec : app
    const basis: Basis = claimed !== 'convention' && norm(quote).length >= 8 && norm(source).includes(norm(quote)) ? claimed : 'convention'
    return { status, body: x.body ?? null, basis, quote }
  })
  const vars: Record<string, unknown> = {}
  const checks: Check[] = s.steps.flatMap((st, i) => compareStep(st, preds[i], vars).map((c) => ({ step: i + 1, ...c, basis: preds[i].basis })))
  const rank = { convention: 0, code: 1, spec: 2 }
  const label: Label = checks.some((c) => c.result === 'X' && c.basis !== 'convention') ? 'contradicts'
    : checks.some((c) => c.result !== 'M') ? 'unstated' : 'readable'
  const basis = label === 'readable' ? checks.map((c) => c.basis).reduce((a, b) => (rank[b] < rank[a] ? b : a)) : undefined
  return { id: s.id, label, ...(basis ? { basis } : {}), checks, predictions: preds }
}

// One session per scenario. Stops (emergency stop, cost caps) propagate; anything else about one
// scenario (failed call, unparseable or malformed reply) labels it 'unknown' and moves on.
export async function classify(model: Model, spec: string, app: string, scenarios: Scenario[], extractJson: (t: string) => unknown): Promise<Classification[]> {
  const out: Classification[] = []
  for (const s of scenarios) {
    const r = await model({ ...CLASSIFIER_BUDGET, role: 'classifier', instruction: predictInstruction(spec, app, s), workdir: mkdtempSync(join(tmpdir(), 'factory-classify-')), access: 'none' })
    if (!r.ok) { out.push({ id: s.id, label: 'unknown', checks: [], error: `classifier call failed: ${r.error}` }); continue }
    try { out.push(classifyReply(s, spec, app, extractJson(r.text))) } catch (e) {
      if (e instanceof Stop) throw e
      out.push({ id: s.id, label: 'unknown', checks: [], error: `classifier reply unusable: ${(e as Error).message}` })
    }
  }
  return out
}
