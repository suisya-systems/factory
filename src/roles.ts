// Three model-calling roles: drafter, builder, judge. (The shipper is ship.ts and calls no model.)
// Each role gets a Model; the run loop passes one wrapped by the limits guard.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CAPS } from './limits.ts'
import { classify, UNDECIDED } from './classify.ts'
import { usesService, withService } from './fake.ts'
import { exportTree, removeTree, sandboxGit } from './sandbox.ts'
import { isObj, runScenarios, validateScenarios, type Scenario, type ScenarioResult } from './scenario.ts'
import type { Draft } from './vault.ts'

// Each call also gets at most what is left of the change / lap caps (the guard).
// Since lap 3 the builder and the judge have a per-call ceiling (CAPS): a call that reports no cost
// (a timeout) is charged that ceiling, not everything left of the change cap, so one timeout does not end the retries.
const base = { maxCostUsd: Infinity, timeoutMs: CAPS.modelTimeoutMs }

export function extractJson(text: string): any {
  const tries = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const t of tries) {
    if (!t) continue
    try { return JSON.parse(t) } catch { /* next */ }
  }
  throw new Error('model reply contained no parseable JSON object')
}

// ---- drafters ----
// Two separate sessions from the same request. The spec drafter writes the spec; the scenario drafter
// writes the hidden scenarios WITHOUT seeing the spec: it gets the request, the existing app and the
// interface (names and shapes only, so both use one vocabulary). Not the spec drafter's assumptions:
// in lap 2 they carried nearly every rule of the spec (owner decision 2026-10-17: pass the interface only).
// Then every scenario is classified by a third, spec-only procedure (classify.ts).
export const INTERFACE_KEYS = ['endpoints', 'queryParams', 'fields', 'listShape', 'conflictToken']

// Lap 3 (owner decision 2026-10-17): a deliberately coarse spec, so the hidden scenarios have room to
// check behaviour the spec does not state. The spec carries only what the request says and the interface.
// Lap 4: the interface carries names and shapes, never the values a field may take. In lap 3 an enumerated
// value of a field ("create" among the history actions) decided the first Undecided point for both drafters.
const SPEC_FORMAT = `Write ONLY what the request states, plus the interface (names and shapes). Do NOT decide behaviour the
request leaves open (defaults, status codes, limits and boundaries, ordering, error cases, how features combine):
end the spec with a "## Undecided" section that lists each such point as one bullet, without choosing an answer.
Reply with ONE JSON object and nothing else:
{"spec": "<markdown spec for the builder, ending with the ## Undecided section>",
 "interface": {"endpoints": ["METHOD /path", ...], "queryParams": {"METHOD /path": ["name", ...]}, "fields": {"<resource>": ["name", "nested.name", "items[].name", ...]},
   "listShape": "bare array" or ["<envelope key>", ...], "conflictToken": {"in": "body" or "header", "name": "<name>"}},
 "assumptions": ["<one line each: what you assumed because the request did not say>"]}
"interface" holds NAMES AND SHAPES ONLY, and must match the spec: no status codes, no rules (no AND/OR, matching, ordering,
defaults, limits or page boundaries) and no values: never list the values a field or parameter may take (no enumerations), no examples.
Every name is a bare identifier (letters, digits, _; "." for a nested field, "[]" for the items of an array).
Every interface key is optional: leave out a key that does not apply.
It is given to a separate scenario writer who never sees your spec.
You cannot ask questions: record every guess in assumptions.`

const SCENARIO_FORMAT = `Reply with ONE JSON object and nothing else:
{"assumptions": ["<one line each: anything you assumed because the request did not say>"],
 "scenarios": [{"id": "kebab-id", "title": "...", "summary": "<one line, plain words; this is all the builder sees if it fails. It must NOT contain any path, any status code, or any string value (3+ chars) or number (3+ digits) used in that scenario's steps>",
   "inSpec": <true if the REQUEST states this behaviour, false if it is an unstated but reasonable expectation>, "kind": "<a short kebab-case category>",
   "steps": [{"method": "GET|POST|PUT|PATCH|DELETE", "path": "/...", "body": <json, optional, not on GET>, "headers": {<optional>},
     "expect": {"status": <int or [ints]>, "json": <partial deep subset, optional>, "jsonHas": ["dot.path", ...], "isArray": <bool>, "length": <int, or {"dot.path": int} for arrays inside the body>},
     "capture": {"name": "dot.path", "name2": "header:<response header name>"}}]}]}
"{{name}}" in a later path/body/headers/json is replaced by a captured value (a value that is exactly "{{name}}" keeps the captured type).
Every expect needs at least one check. Arrays in "json" match by position (a prefix), so only list items whose order is fixed;
use "length" to check that a list holds exactly the expected items.
Use ONLY the endpoint, parameter and field names in the INTERFACE. Where the request does not fix a status code, accept every reasonable one (e.g. [400, 422]).
Each scenario starts from an EMPTY app.
Write 8-15 scenarios, a mix of inSpec true and false. You cannot ask questions: record every guess in assumptions.`

// #17: only for a spec that declares an external service (fake.ts). The fake answers what the scenario sets; never the builder's business.
const SERVICE_STEPS = `EXTERNAL SERVICE: the app calls the external service the request names. In judging a fake stands in for it, and a step with
"service": true goes to the fake's control endpoint instead of the app (no "headers" on such a step). Two forms only:
- {"service": true, "method": "POST", "path": "/responses", "body": {"method": "GET|POST|PUT|PATCH|DELETE", "path": "/<path on the service>", "status": <int 200-599>, "json": <optional body>, "headers": {<optional>}}, "expect": {"status": 204}}
  sets what the fake answers to that method and path (query ignored; the last one set wins; anything not set gets 404 {"error": "no canned response"}).
- {"service": true, "method": "GET", "path": "/requests", "expect": {...}} returns the array of requests the app sent to the service so far, in order,
  each {"method", "path" (with query), "headers" (lower-case names), "body" (parsed JSON, else text)}: use it to check what the app sent.
Service steps before the scenario's first app step run before the app starts. The fake starts empty in every scenario.
Use the service's API exactly as the request describes it. The summary rule covers service steps too.`

// Lap 6 (`draft --minority`): the scenario writer picks, on purpose, reasonable answers most builders would not
// (in lap 5 builders and scenario writers chose the same answer 16/16 times, so no retry ever happened). Each choice is
// marked in the assumptions, so the approver and the report know which scenarios carry it. The summary rule is unchanged.
const MINORITY = `MINORITY CHOICES (an experiment): pick 2 or 3 points that the request and common practice leave open and where more than one
answer is reasonable. For each, deliberately choose a reasonable answer that most implementers would NOT choose (not the textbook default),
and write at least one scenario that checks it. Your answer must still satisfy everything the request states. Do not pick a status code.
For each such point add one assumption in exactly this form:
"[minority] <the point>: <your answer> (most would: <the usual answer>); scenarios: <id>, <id>"`
// Lap 7 (`draft --minority-brief <text>`): the experimenter's extra constraints on the minority points (how many, which kind).
// It is kept in the assumptions, so it is part of the approved version; the builder never sees assumptions.
const minorityPrompt = (brief?: string) => `\n\n${MINORITY}` + (brief ? `\nEXPERIMENTER'S BRIEF (where it differs from the paragraph above, the brief wins): ${brief}` : '')
const MINORITY_LINE = /^\[minority\] (.+?): (.+) \(most would: (.+)\); scenarios: (.+)$/
// ponytail: at least one marked point, well formed, citing real scenario ids; whether the answer is really
// a minority one is checked outside the factory (lap-6 runbook, entrance check).
function checkMinority(more: string[], scenarios: Scenario[]) {
  const lines = more.filter((a) => a.startsWith('[minority]'))
  if (!lines.length) throw new Error('scenario drafter: no "[minority] ..." assumption')
  const ids = new Set(scenarios.map((s) => s.id))
  for (const l of lines) {
    const m = l.match(MINORITY_LINE)
    if (!m || m.slice(1, 4).some((x) => !x.trim())) throw new Error(`scenario drafter: malformed minority assumption: ${l}`)
    const bad = m[4].split(',').map((x) => x.trim()).find((x) => !ids.has(x))
    if (bad !== undefined) throw new Error(`scenario drafter: minority assumption cites unknown scenario "${bad}"`)
  }
}

const appBlock = (app: string) => (app ? `\nEXISTING APP (the current code; the request extends it):\n${app}\n` : '')
// Each drafter gets at most $1 so the classifier calls (CLASSIFIER_BUDGET each, about 15) still fit in the draft cap.
const draftTask = (role: string, instruction: string) => ({ ...base, maxCostUsd: 1, role, instruction, workdir: mkdtempSync(join(tmpdir(), 'factory-draft-')), access: 'none' as const })

// Every entry must be a bare name, so a value cannot be written in the lap-3 form ("action: create|update").
// ponytail: syntax only; values spelled as names (a field "listing" its values) still pass, so the
// approver reads the interface at the entrance (runbook, stop point B).
const NAME = /^[A-Za-z_]\w*(\[\])?(\.[A-Za-z_]\w*(\[\])?)*$/
const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE) \/[\w.:{}\/-]*$/
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
function checkInterface(raw: unknown): Record<string, unknown> {
  const bad = (what: string) => new Error(`spec drafter: interface ${what} (names and shapes only, no values or enumerations)`)
  const list = (v: unknown, re: RegExp, what: string) => { if (!Array.isArray(v) || !v.every((n) => typeof n === 'string' && re.test(n))) throw bad(what) }
  if (!isObj(raw)) throw new Error('spec drafter: interface missing')
  const x = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) // a key sent as null is a key left out
  if (Object.keys(x).length === 0) throw new Error('spec drafter: interface missing')
  for (const k of Object.keys(x)) if (!INTERFACE_KEYS.includes(k)) throw new Error(`spec drafter: unknown interface field "${k}"`)
  if (/\b[1-5]\d\d\b/.test(JSON.stringify(x))) throw new Error('spec drafter: interface must not carry status codes')
  if (x.endpoints !== undefined) list(x.endpoints, ENDPOINT, 'endpoints must be "METHOD /path" strings')
  for (const [k, re] of [['queryParams', ENDPOINT], ['fields', NAME]] as const) {
    const m = x[k]
    if (m === undefined) continue
    if (!isObj(m)) throw bad(`${k} must be an object`)
    for (const [key, names] of Object.entries(m)) { if (!re.test(key)) throw bad(`${k} key "${key}" is not a name`); list(names, NAME, `${k}["${key}"] must be a list of bare names`) }
  }
  if (x.listShape !== undefined && x.listShape !== 'bare array') list(x.listShape, NAME, 'listShape must be "bare array" or a list of key names')
  const t = x.conflictToken
  if (t !== undefined && !(isObj(t) && Object.keys(t).length === 2 && typeof t.name === 'string'
    && ((t.in === 'body' && NAME.test(t.name)) || (t.in === 'header' && HEADER_NAME.test(t.name))))) throw bad('conflictToken must be {"in": "body" or "header", "name": <name>}, or left out if there is none')
  return x
}

const strs = (x: unknown, who: string): string[] => {
  if (!Array.isArray(x) || !x.every((a) => typeof a === 'string')) throw new Error(`${who}: assumptions must be strings`)
  return x
}

// A drafter reply that fails validation gets ONE repair round in a fresh session (same role, same
// inputs, plus its reply and the error). Nothing is relaxed: the repaired reply must pass the same checks.
// Both rejected replies travel on the final error (`rejected`), so `draft` can keep them in the hidden run dir (lap 5).
export type Rejected = { role: string; error: string; reply: string }
async function ask<T>(model: Model, role: string, instruction: string, parse: (j: any) => T): Promise<T> {
  let text = '', err = ''
  const rejected: Rejected[] = []
  for (const repair of [false, true]) {
    const r = await model(draftTask(role, repair ? `${instruction}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${err}\nPREVIOUS REPLY:\n${text}\n\nReply again with the whole corrected JSON object.` : instruction))
    if (!r.ok) throw new Error(`${role} failed: ${r.error}`)
    text = r.text
    try { return parse(extractJson(text)) } catch (e) {
      err = (e as Error).message
      rejected.push({ role, error: err, reply: text })
      if (repair) throw Object.assign(e as Error, { rejected })
    }
  }
  throw new Error('unreachable')
}

// The spec section the factory appends; specBody / specIface split an approved spec back into its parts.
const IFACE_HEAD = '\n\n## Interface (names and shapes, shared with the scenario writer)\n\n```json\n'
export const specBody = (spec: string) => spec.split(IFACE_HEAD)[0]
export function specIface(spec: string): string {
  const i = spec.split(IFACE_HEAD)[1]
  if (i === undefined) throw new Error('spec has no factory interface section')
  return i.slice(0, i.indexOf('\n```'))
}

// o.reuse (lap 5, `draft --spec-from`): an approved spec (body + interface) is used as is and the spec drafter is not called,
// so several scenario sets (or a hand-edited control spec) share one spec and one interface.
// o.service (#17, `draft --service`): the spec declares an external service (fake.ts); a reused spec that already does keeps it.
export async function draft(model: Model, request: string, o: { signals?: string; app?: string; reuse?: { body: string; iface: string }; minority?: boolean; minorityBrief?: string; service?: boolean } = {}): Promise<Omit<Draft, 'base'>> {
  const req = `REQUEST:\n${request}\n` + (o.signals ? `\nPRODUCTION SIGNALS (observed from the running app):\n${o.signals}\n` : '') + appBlock(o.app ?? '')
  const j = o.reuse ? { spec: o.reuse.body, iface: o.reuse.iface, assumptions: ['(spec reused from an approved change; the spec drafter was not called)'] } : await ask(model, 'spec-drafter', `You are the spec drafter of a software factory. Turn the request into a spec for a builder (HTTP JSON API).\n\n${req}\n${SPEC_FORMAT}`, (j) => {
    if (typeof j.spec !== 'string' || !j.spec.trim()) throw new Error('spec drafter: spec missing')
    if (!UNDECIDED.test(j.spec)) throw new Error('spec drafter: spec has no "## Undecided" section')
    return { spec: j.spec as string, iface: JSON.stringify(checkInterface(j.interface)), assumptions: strs(j.assumptions, 'spec drafter') }
  })
  const assumptions = [`Interface (names and shapes only): ${j.iface}`, ...j.assumptions]
  // The builder sees the same names the scenarios use.
  const body = o.service ? withService(j.spec) : j.spec
  const spec = `${body.trimEnd()}${IFACE_HEAD}${j.iface}\n\`\`\`\n`

  const k = await ask(model, 'scenario-drafter', `You are the scenario writer of a software factory. Write hidden acceptance scenarios (HTTP JSON API) for the request. ` +
    `A builder will implement a spec you do not see; your scenarios judge it.\n\n${req}\nINTERFACE (names and shapes the builder uses; it says nothing about behaviour):\n${j.iface}\n\n${SCENARIO_FORMAT}${usesService(spec) ? `\n\n${SERVICE_STEPS}` : ''}${o.minority ? minorityPrompt(o.minorityBrief) : ''}`,
  (k) => {
    const scenarios = validateScenarios(k.scenarios), more = k.assumptions === undefined ? [] : strs(k.assumptions, 'scenario drafter')
    if (o.minority) checkMinority(more, scenarios)
    return { scenarios, more }
  })
  return { spec, scenarios: k.scenarios, assumptions: [...assumptions, ...(o.minorityBrief ? [`(experimenter) minority brief: ${o.minorityBrief}`] : []), ...k.more.map((x) => `(scenario writer) ${x}`)], classification: await classify(model, spec, o.app ?? '', k.scenarios, extractJson) }
}

// ---- builder ----
export const RUN_CONTRACT = `RUN CONTRACT (fixed, non-negotiable):
- Node.js 22, standard library only. No dependencies, no package installs, no network at runtime.
- package.json must have "scripts": {"start": "..."}; \`npm start\` starts the HTTP server on process.env.PORT (bind 127.0.0.1 only; a listener on any other address fails the run).
- Persist data only under process.env.DATA_DIR (if at all). The app directory is read-only at runtime.
- JSON request and response bodies.
- Work only inside the current directory. The factory commits your work when you finish.`

// #17: a spec that declares an external service lifts "no network" for that one address.
export const runContract = (spec: string) => (usesService(spec)
  ? RUN_CONTRACT.replace('no network at runtime.', 'no network at runtime except the external service at process.env.SERVICE_URL (see the spec).') : RUN_CONTRACT)

// The builder gets the spec only. assumptions.json carries scenario-writer text: never pass it here.
export async function build(model: Model, workspace: string, spec: string, feedback: string, signal?: AbortSignal): Promise<{ sha: string; ok: boolean; error?: string }> {
  const instruction = `You are the builder of a software factory. Implement the spec below in the current directory. ` +
    `Points the spec lists under "Undecided" are left to you: choose sensible behaviour.\n\nSPEC:\n${spec}\n\n${runContract(spec)}\n` +
    (feedback ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Feedback:\n${feedback}\n` : '')
  const r = await model({ ...base, maxCostUsd: CAPS.builderCallUsd, role: 'builder', instruction, workdir: workspace, access: 'write' })
  // The workspace (incl. .git/config) is builder-written: a silently failed commit would leave HEAD
  // at the previous attempt's sha while the working tree holds new code.
  for (const args of [['add', '-A'], ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'factory: builder attempt']]) {
    const g = await sandboxGit(workspace, args, true, [], signal)
    if (g.code !== 0) throw new Error(`could not commit builder workspace (git ${args[0]} failed)`)
  }
  const head = await sandboxGit(workspace, ['rev-parse', 'HEAD'], false, [], signal)
  const sha = head.out.trim()
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('could not commit builder workspace')
  return { sha, ok: r.ok, error: r.error }
}

// ---- judge ----
// stop: a limit/stop fired during the LLM call; the deterministic results are still returned so the
// attempt is recorded, and the caller re-throws it. llmPass null = the judge gave no verdict (call
// failed, reply unparseable, or stopped); only false is an LLM rejection.
export type Verdict = { pass: boolean; testsAllPass: boolean; llmPass: boolean | null; reason: string; results: ScenarioResult[]; approvedVersion: string; stop?: Error }

// Owner decision: AND (both must pass).
export function combineVerdict(testsAllPass: boolean, llmPass: boolean): boolean {
  return testsAllPass && llmPass
}

// Judges the COMMIT (exported exactly as the shipper will export it), never the live workspace.
export async function judge(model: Model, workspace: string, sha: string, spec: string, scenarios: Scenario[], approvedVersion: string, signal: AbortSignal): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-judge-'))
  try {
    await exportTree(workspace, sha, dir, signal)
    return await judgeDir(model, dir, spec, scenarios, approvedVersion, signal)
  } finally { removeTree(dir) }
}

async function judgeDir(model: Model, dir: string, spec: string, scenarios: Scenario[], approvedVersion: string, signal: AbortSignal): Promise<Verdict> {
  const results = await runScenarios(dir, scenarios, signal, { service: usesService(spec) })
  const testsAllPass = results.every((r) => r.pass)
  const instruction = `You are the judge of a software factory. The deterministic hidden scenarios have already run. Read the code in the current directory (read-only) and decide whether it satisfies the spec as a whole. Points the spec lists under "Undecided" were left to the builder: any sensible choice satisfies the spec.\n\nSPEC:\n${spec}\n\nSCENARIOS:\n${JSON.stringify(scenarios)}\n\nRESULTS:\n${JSON.stringify(results)}\n\nReply with ONE JSON object: {"pass": true|false, "reason": "..."}`
  let r
  try { r = await model({ ...base, maxCostUsd: CAPS.judgeCallUsd, role: 'judge', instruction, workdir: dir, access: 'read' }) }
  catch (e) { return { pass: false, testsAllPass, llmPass: null, reason: 'judge call stopped', results, approvedVersion, stop: e as Error } }
  let llmPass: boolean | null = null
  let reason = r.ok ? '' : `judge call failed: ${r.error}`
  if (r.ok) {
    try {
      const j = extractJson(r.text)
      if (typeof j.pass !== 'boolean') throw new Error('no verdict')
      llmPass = j.pass
      reason = typeof j.reason === 'string' ? j.reason : ''
    } catch { reason = 'judge reply was not parseable' }
  }
  return { pass: combineVerdict(testsAllPass, llmPass === true), testsAllPass, llmPass, reason, results, approvedVersion }
}

// What the builder may learn from a rejection. DEFAULT = the drafter's one-line summary of each
// failed scenario + a bare "LLM judge did not approve" flag (only on a real rejection, not a judge failure). Never steps, values, expectations,
// details, or the judge's reason text (which may quote scenarios). Keep this the only path.
// Lap 7 control (`run --feedback bare`): the same lines without the summaries, so the builder learns that it was
// rejected and how many scenarios failed, never which or why.
export type FeedbackMode = 'summaries' | 'bare'
export function feedbackFor(v: Verdict, scenarios: Scenario[], mode: FeedbackMode = 'summaries'): string {
  const byId = new Map(mode === 'bare' ? [] : scenarios.map((s) => [s.id, s.summary]))
  const lines = v.results.filter((r) => !r.pass).map((r) => `- failed: ${byId.get(r.id) ?? 'a hidden scenario'}`)
  if (v.llmPass === false) lines.push('- LLM judge did not approve')
  return lines.join('\n')
}
