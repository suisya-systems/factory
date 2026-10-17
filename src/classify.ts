// "Can this hidden scenario be read from the spec?" decided by a procedure, not by the drafter's claim.
// Per scenario, a separate session sees ONLY the spec, the existing app code and the scenario's
// requests (no expectations, ids, titles, summaries or kinds) and predicts each response. The
// scenario's real expectations are then compared with the prediction mechanically, three-valued:
// M (the prediction satisfies the check), X (it contradicts it), U (the prediction leaves it open).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CONTROL } from './fake.ts'
import { at, fill, get, HEADER, isObj, lengthChecks, type Scenario, type Step } from './scenario.ts'

export type Basis = 'spec' | 'code' | 'convention'
export type Label = 'readable' | 'unstated' | 'contradicts' | 'unknown'
type Tri = 'M' | 'X' | 'U'
export type Prediction = { status: number[] | null; body: unknown; headers?: Record<string, unknown>; basis: Basis; quote: string }
export type Check = { step: number; check: string; result: Tri; basis: Basis }
// basis: for readable, the weakest basis among the steps that matched (spec > code > convention).
export type Classification = { id: string; label: Label; basis?: Basis; checks: Check[]; predictions?: Prediction[]; error?: string }

// Lap 3: the spec ends with the points it leaves open. Quoting them is no evidence that the spec decides anything.
export const UNDECIDED = /^##\s+Undecided\s*$/m
export const withoutUndecided = (spec: string) => {
  const [before, after] = spec.split(UNDECIDED)
  if (after === undefined) return spec
  const next = after.search(/^## /m)
  return before + (next < 0 ? '' : after.slice(next))
}

export const CLASSIFIER_BUDGET = { maxCostUsd: 0.5, timeoutMs: 3 * 60_000 }

// What the predictor sees of a scenario: the requests only. Anything else (id, title, summary, kind,
// expect) would tell it the intended outcome.
export const requestsOnly = (s: Scenario) => s.steps.map(({ method, path, body, headers, capture, service }) => ({ method, path, body, headers, capture, service }))
// #17: a step setting the fake's canned answer is the scenario's own setup, not app behaviour: its checks never count.
const isSetup = (st: Step) => st.service === true && `${st.method} ${st.path.split('?')[0]}` === CONTROL.set
const SERVICE_NOTE = `
A request with "service": true does not go to the app: it goes to the control endpoint of a fake that stands in for the external service the spec names.
"POST /responses" sets what the fake answers the app for that method and path (reply 204, no body); predict {"status": [204], "body": null, "basis": "convention", "quote": ""} for it.
"GET /requests" replies 200 with the array of requests the app has sent to the service so far, in order, each {"method", "path" (with query), "headers" (lower-case names), "body" (parsed JSON, else text)}: predict which requests the app sent.
`

export function predictInstruction(spec: string, app: string, s: Scenario): string {
  return `You are checking how much a spec determines. Below are a SPEC, the EXISTING APP code it extends (may be empty), and a sequence of HTTP requests sent to a FRESH, EMPTY instance of an app built from that spec. Predict each response from the spec and the code only.

SPEC:
${spec}

EXISTING APP:
${app || '(none)'}

REQUESTS (in order; "{{name}}" is a value captured from an earlier response, per that step's "capture": {"name": "dot.path in the JSON body" or "header:<name>"}):
${JSON.stringify(requestsOnly(s), null, 1)}
${s.steps.some((st) => st.service) ? SERVICE_NOTE : ''}
Reply with ONE JSON object: {"steps": [one entry per request, in order]}. Each entry:
{"status": [<every status code the spec/code allows here>] or null if they do not determine it,
 "body": <the JSON response body as far as it is determined, or null>,
 "headers": {<response headers a later request relies on (see "capture": "header:<name>"), lower-case name: value or "?"; omit if not determined>},
 "basis": "spec" | "code" | "convention" (where the prediction comes from; "convention" = general HTTP habit, not stated anywhere),
 "quote": "<the exact sentence of the spec or line of code you rely on, copied verbatim; empty for convention>"}
In "body": leave a field OUT when its presence is not determined; write "?" when the field is present but its value is not determined; an array you write is a claim about ALL its items in order, so use "?" for any item you cannot determine; write "{{name}}" where the value equals a value captured by an EARLIER step (if this step captures the same name again, "{{name}}" still means the earlier value). Do not invent ids or timestamps. Points the SPEC lists under "## Undecided" are NOT determined by it.`
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
const worst = (rs: Tri[]): Tri => (rs.includes('X') ? 'X' : rs.includes('U') ? 'U' : 'M')
// Undetermined. A null inside the body is a determined value; a whole body of null is turned into undefined.
const MARK = '\u0000captured:'
const open = (v: unknown) => v === undefined || v === '?'
// A captured object may hold "?" leaves; each becomes its own marker so it cannot meet a value as a mismatch.
const seal = (x: unknown, tag: string): unknown => x === '?' ? tag : Array.isArray(x) ? x.map((v, i) => seal(v, `${tag}.${i}`))
  : isObj(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, seal(v, `${tag}.${k}`)])) : x
// The prediction is untrusted: a "{{name}}" it uses but nothing captured reads as undetermined.
const fillOpen = (x: unknown, vars: Record<string, unknown>): unknown => {
  if (typeof x === 'string') {
    const names = [...x.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    return names.every((n) => Object.hasOwn(vars, n)) ? fill(x, vars) : '?'
  }
  if (Array.isArray(x)) return x.map((v) => fillOpen(v, vars))
  if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillOpen(v, vars)]))
  return x
}

// Expected json vs predicted body, leaf by leaf.
function tri(e: unknown, p: unknown): Tri {
  if (open(p)) return 'U'
  const marked = (v: unknown) => typeof v === 'string' && v.includes(MARK) // a captured value nobody determined
  if (marked(p) || marked(e)) return e === p ? 'M' : 'U'
  if (Array.isArray(e)) return !Array.isArray(p) || p.length < e.length ? 'X' : worst(e.map((x, i) => tri(x, p[i])))
  if (isObj(e)) return !isObj(p) ? 'X' : worst(Object.entries(e).map(([k, v]) => tri(v, Object.hasOwn(p, k) ? p[k] : undefined)))
  return e === p ? 'M' : 'X'
}

// The checks of one step against one prediction. A capture binds the value the prediction determines,
// else an opaque marker (one per capture step), so ids nobody can predict still match a later "{{name}}"
// on either side. n: the step number, which keeps a re-capture's marker apart from the earlier one.
export function compareStep(st: Step, p: Prediction, vars: Record<string, unknown>, n = 0): { check: string; result: Tri }[] {
  const out: { check: string; result: Tri }[] = []
  const e = st.expect
  const expected = e.json === undefined ? undefined : fill(e.json, vars) // as the runner: captures of this step come after its checks
  const marker = (name: string) => `${MARK}${name}@${n}`
  // A "{{name}}" in the prediction means the value captured EARLIER, as in the expectation; only a name
  // nothing captured yet may echo this step's own capture.
  for (const name of Object.keys(st.capture ?? {})) if (!Object.hasOwn(vars, name)) vars[name] = marker(name)
  const body = p.body === null ? undefined : fillOpen(p.body, vars)
  // Header names are case-insensitive, as in the runner's Headers.get.
  const headers = isObj(p.headers) ? Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), fillOpen(v, vars)])) : undefined
  // The runner fails a step whose capture is missing: the prediction must establish it.
  for (const [name, path] of Object.entries(st.capture ?? {})) {
    const v = path.startsWith(HEADER) ? headers?.[path.slice(HEADER.length).toLowerCase()] : get(body, path)
    out.push({ check: `capture ${name}`, result: v === undefined ? 'U' : 'M' }) // as the runner: only a missing value fails
    // The runner reads a header as a string.
    vars[name] = open(v) ? marker(name) : path.startsWith(HEADER) ? String(v) : seal(v, marker(name))
  }
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
  if (expected !== undefined) out.push({ check: 'json', result: tri(expected, body) })
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
    const source = claimed === 'spec' ? withoutUndecided(spec) : app
    const basis: Basis = claimed !== 'convention' && norm(quote).length >= 8 && norm(source).includes(norm(quote)) ? claimed : 'convention'
    return { status, body: x.body ?? null, ...(isObj(x.headers) ? { headers: x.headers } : {}), basis, quote }
  })
  const vars: Record<string, unknown> = {}
  const checks: Check[] = s.steps.flatMap((st, i) => isSetup(st) ? [] : compareStep(st, preds[i], vars, i + 1).map((c) => ({ step: i + 1, ...c, basis: preds[i].basis })))
  const rank = { convention: 0, code: 1, spec: 2 }
  const label: Label = checks.some((c) => c.result === 'X' && c.basis !== 'convention') ? 'contradicts'
    : checks.some((c) => c.result !== 'M') ? 'unstated' : 'readable'
  const basis = label === 'readable' ? checks.map((c) => c.basis).reduce((a, b) => (rank[b] < rank[a] ? b : a), 'spec' as Basis) : undefined
  return { id: s.id, label, ...(basis ? { basis } : {}), checks, predictions: preds }
}

// One session per scenario. Stops (emergency stop, cost caps) are thrown by the guarded model call and
// propagate; a failed call or an unparseable / malformed reply labels that scenario 'unknown'.
export async function classify(model: Model, spec: string, app: string, scenarios: Scenario[], extractJson: (t: string) => unknown): Promise<Classification[]> {
  const out: Classification[] = []
  for (const s of scenarios) {
    const r = await model({ ...CLASSIFIER_BUDGET, role: 'classifier', instruction: predictInstruction(spec, app, s), workdir: mkdtempSync(join(tmpdir(), 'factory-classify-')), access: 'none' })
    if (!r.ok) { out.push({ id: s.id, label: 'unknown', checks: [], error: `classifier call failed: ${r.error}` }); continue }
    try { out.push(classifyReply(s, spec, app, extractJson(r.text))) } catch (e) {
      out.push({ id: s.id, label: 'unknown', checks: [], error: `classifier reply unusable: ${(e as Error).message}` })
    }
  }
  return out
}
