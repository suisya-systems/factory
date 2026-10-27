// Three model-calling roles: drafter, builder, judge. (The shipper is ship.ts and calls no model.)
// Each role gets a Model; the run loop passes one wrapped by the limits guard.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CAPS } from './limits.ts'
import { classify, UNDECIDED } from './classify.ts'
import { TEST_ID, UI_LIMITS, usesUi, withUi } from './browser.ts'
import { usesService, withService } from './fake.ts'
import { contractOf, depsDir, loadDeps, usesRun, withRun, type Contract } from './program.ts'
import { exportTree, removeTree, sandboxGit } from './sandbox.ts'
import { isObj, judgeOpts, runScenarios, validateScenarios, type Scenario, type ScenarioResult } from './scenario.ts'
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
export const INTERFACE_KEYS = ['endpoints', 'queryParams', 'fields', 'listShape', 'conflictToken', 'testIds', 'commands', 'flags', 'files']

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
Every name is a bare identifier (letters, digits, _; "." for a nested field, "[]" for the items of an array): no spaces and no description in a "fields" key or in a name list.
Every interface key is optional: leave out a key that does not apply.
It is given to a separate scenario writer who never sees your spec.
You cannot ask questions: record every guess in assumptions.`

const SCENARIO_FORMAT = `Reply with ONE JSON object and nothing else:
{"assumptions": ["<one line each: anything you assumed because the request did not say>"],
 "scenarios": [{"id": "kebab-id", "title": "...", "summary": "<one line of AT MOST 200 characters, plain words; this is all the builder sees if it fails. It must NOT contain any path, any status code, or any string value (3+ chars) or number (3+ digits) used in that scenario's steps>",
   "inSpec": <true if the REQUEST states this behaviour, false if it is an unstated but reasonable expectation>, "kind": "<a short kebab-case category>",
   "steps": [{"method": "GET|POST|PUT|PATCH|DELETE", "path": "/...", "body": <json, optional, not on GET>, "headers": {<optional>},
     "expect": {"status": <int or [ints]>, "json": <partial deep subset, optional>, "jsonHas": ["dot.path", ...], "jsonAbsent": ["dot.path", ...], "isArray": <bool>, "length": <int, or {"dot.path": int} for arrays inside the body>},
     "capture": {"name": "dot.path", "name2": "header:<response header name>"}}]}]}
"{{name}}" in a later path/body/headers/json is replaced by a captured value (a value that is exactly "{{name}}" keeps the captured type).
Every expect needs at least one check. Arrays in "json" match by position (a prefix), so only list items whose order is fixed;
use "length" to check that a list holds exactly the expected items.
Use "jsonAbsent" to check that a value is NOT there (a record that must have been removed, a field that must not be returned): it fails when the path exists.
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

// A program that also calls the external service: the same two service steps, between "run" steps.
const SERVICE_WITH_RUN = `The app is a command-line program, so "the app" above is the program, and a "run" step (not an app start) is what makes it call the service.
Order the steps as the check needs: "POST /responses" steps to set the answers, then the "run" step, then "GET /requests" to see what the program sent. A "service" step may also come between two "run" steps.
The program finds the service at its environment variable SERVICE_URL (do not set it in "env"). To give the address to the program in a file or an argument, write {{SERVICE_URL}} in "files", "run" or "stdin"
(e.g. "files": {"config.json": {"url": "{{SERVICE_URL}}/topic"}}). "{{SERVICE_URL}}" is a base URL like http://127.0.0.1:41234 and you do not know the port: never write the port, and do not check it.
A "run" step still has no network except the service. A service step has no "capture" of values from a run. The fake starts empty in every scenario; the working directory is shared by the "run" steps only.`

// #4: only for a spec that declares a browser UI (browser.ts). The spec drafter names the elements; the scenario writer drives them.
const UI_IFACE = `BROWSER UI: the app has pages a user works in a browser. Add "testIds": ["name", ...] to the interface: the data-testid of every element
a page shows or a user acts on (inputs, buttons, list items, texts to read), bare names without ".". Pages are endpoints too ("GET /path").`
const UI_STEPS = `BROWSER UI: the app's pages are judged in a headless browser. Besides HTTP steps, a step with "ui" drives the page (no method, body or headers):
- {"ui": "goto", "path": "/<page>", "expect": {...}} opens the page; "status" is the page's HTTP status.
- {"ui": "fill", "target": "<testId>", "text": "<what the user types>"} types into an input (replacing what is there).
- {"ui": "click", "target": "<testId>"} clicks it. "<testId>.<n>" is the n-th visible element with that test id (0-based); a bare "<testId>" must be the only visible one.
After a ui step its optional "expect" and "capture" read the page as JSON: {"<testId>": [the visible text of each visible element with that test id, in page order]}
(whitespace collapsed; an input gives its value). E.g. "json": {"<testId>": ["<text>"]} (positional prefix), "length": {"<testId>": 2} (0 = none visible),
"capture": {"name": "<testId>.0"}. The checks are retried for up to ${UI_LIMITS.settleMs / 1000} s, as the page may update after the action. A step without an "expect" does not wait, so
before the next action write an "expect" for what the previous action should change. A scenario may mix
ui and HTTP steps. Use ONLY the test ids in the INTERFACE; you do not know any label or text the builder chooses, so check only texts the scenario itself entered
or that the request fixes. The summary rule covers ui steps too.`

// only for a spec that declares a command-line program (program.ts). The interface names its commands, flags and files; every scenario step is a run.
const RUN_IFACE = `COMMAND-LINE PROGRAM: the app is a command-line program, not an HTTP server. Describe it in the interface with these keys (instead of endpoints):
"commands": ["<command words>", ...] (e.g. "build plan": the sub-command words, one string per command), "flags": {"<command words>": ["--flag", ...]} (the key "" holds the flags of the program itself, before any sub-command),
"files": ["<name of a file the program reads or writes>", ...], and "fields" for the names inside the JSON it reads or prints ({"<name of the JSON>": ["name", "nested.name", ...]}).
A "commands" entry is lower-case words only. A "files" entry is a plain path (letters, digits, _ . - and "/"), no spaces. A file whose name changes (one per target, per worker, ...) is written ONCE
with one "{name}" in place of the changing part (e.g. "out/{target}.json"; the name inside the braces is a bare identifier). Never list alternatives ("a|b"), a description or an example name.
A "fields" key is a bare identifier too (e.g. "panes_json", not "panes json" or a phrase); the scenario writer sees these names, so keep each one short.
Names only, as for the other keys: no values, no exit codes, no rules.`
const RUN_SCENARIO_FORMAT = `Reply with ONE JSON object and nothing else:
{"assumptions": ["<one line each: anything you assumed because the request did not say>"],
 "scenarios": [{"id": "kebab-id", "title": "...", "summary": "<one line of AT MOST 200 characters, plain words; this is all the builder sees if it fails. It must NOT contain any argument value, file path or name (3+ chars), string value (3+ chars) or number (3+ digits) used in that scenario's steps>",
   "inSpec": <true if the REQUEST states this behaviour, false if it is an unstated but reasonable expectation>, "kind": "<a short kebab-case category>",
   "steps": [{"run": ["<argument>", ...], "stdin": "<optional text>", "files": {"<relative path>": <string, or JSON that is written as text>}, "read": ["<relative path of a file the program writes>"], "env": {"NAME": "value"},
     "expect": {"status": <int or [ints]>, "json": <partial deep subset, optional>, "jsonHas": ["dot.path", ...], "jsonAbsent": ["dot.path", ...], "isArray": <bool>, "length": <int, or {"dot.path": int} for arrays inside the body>},
     "capture": {"name": "dot.path"}}]}]}
"{{name}}" in a later argument, stdin, file path or content, env value or json is replaced by a captured value (a value that is exactly "{{name}}" keeps the captured type).
Every expect needs at least one check. Arrays in "json" match by position (a prefix), so only list items whose order is fixed;
use "length" to check that a list holds exactly the expected items.
Use "jsonAbsent" to check that a value is NOT there (a record that must have been removed, a field that must not be returned): it fails when the path exists.
Use ONLY the command, flag and file names in the INTERFACE. An interface file written "dir/{name}.json" stands for ONE concrete name in each step: write the concrete file name ("dir/worker-a.json"), never the "{name}" form. Where the request does not fix an exit code, accept every reasonable one (e.g. [1, 2]).
Each scenario starts from an EMPTY working directory.
Write 8-15 scenarios, a mix of inSpec true and false. You cannot ask questions: record every guess in assumptions.`
const RUN_STEPS = `COMMAND-LINE PROGRAM: the app is a program, not an HTTP server. Every step runs it (a step has no "method", "path", "body" or "headers"), except the "service": true steps below when the spec declares an external service.
The factory runs the program's command (given below as COMMAND) followed by the step's "run" arguments, in a working directory that is empty at the start of the scenario and stays the same
for its later steps: the step's "files" are written there first, and a file one run writes is there for the next run. No network (except the external service, when the spec declares one, below). A run is stopped after 20 seconds; at most 20 files in ("files") and 20 out ("read"),
each file in at most 64,000 characters. "env" may not set PATH, HOME, TMPDIR, PYTHON*, LD_*, NODE_* or VIRTUAL_ENV.
The step's response: "status" is the exit code; the JSON body is {"stdout": <the standard output parsed as JSON when it is JSON, else the text>, "stderr": "<text>",
"files": {"<path>": <the file, parsed as JSON when it is JSON, else its text>}} with the files named in "read" (a file that was not written is absent).
So "expect" and "capture" work as for an HTTP response: e.g. {"status": 0, "json": {"stdout": {...}, "files": {"out.json": {...}}}, "length": {"stdout.items": 2}}, "capture": {"name": "stdout.id"}
(dot paths; the file "out.json" is "files.out.json"). Prefer checks on JSON output and on files; check standard output as text only where the request fixes it exactly
(text is compared as it is, trailing newline included).
The summary rule covers every argument, file path and content.`

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

export const appBlock = (app: string) => (app ? `\nEXISTING APP (the current code; the request extends it):\n${app}\n` : '')
// Each drafter gets at most $2 so the classifier calls (CLASSIFIER_BUDGET each, about 15) still fit in the draft cap.
const draftTask = (role: string, instruction: string) => ({ ...base, maxCostUsd: 2, role, instruction, workdir: mkdtempSync(join(tmpdir(), 'factory-draft-')), access: 'none' as const })

// Every entry must be a bare name, so a value cannot be written in the lap-3 form ("action: create|update").
// ponytail: syntax only; values spelled as names (a field "listing" its values) still pass, so the
// approver reads the interface at the entrance (runbook, stop point B).
const NAME = /^[A-Za-z_]\w*(\[\])?(\.[A-Za-z_]\w*(\[\])?)*$/
const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE) \/[\w.:{}\/-]*$/
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
const COMMAND = /^[a-z][a-z0-9_-]*( [a-z][a-z0-9_-]*)*$/, FLAG = /^--?[A-Za-z][\w-]*$/, FILE_NAME = /^[\w.-]+(\/[\w.-]+)*$/
// An interface file may stand for a family of names with ONE `{name}` (name = a bare identifier): `dispatcher/spawn-prompt/{target}.json`.
const FILE_SLOT = /\{[A-Za-z_]\w*\}/g
export const fileEntry = (n: unknown): n is string => typeof n === 'string' && ((n.match(FILE_SLOT)?.length ?? 0) <= 1) && FILE_NAME.test(n.replace(FILE_SLOT, 'x')) && !/[{}]/.test(n.replace(FILE_SLOT, ''))
function checkInterface(raw: unknown): Record<string, unknown> {
  const bad = (what: string) => new Error(`spec drafter: interface ${what} (names and shapes only, no values or enumerations)`)
  // The error names every offending value, so one repair round can fix them all.
  const list = (v: unknown, ok: RegExp | ((n: unknown) => boolean), what: string) => {
    if (!Array.isArray(v)) throw bad(`${what}; got ${JSON.stringify(v)}, not a list`)
    const test = ok instanceof RegExp ? (n: unknown) => typeof n === 'string' && ok.test(n) : ok
    const offending = v.filter((n) => !test(n))
    if (offending.length) throw bad(`${what}; offending value${offending.length === 1 ? '' : 's'}: ${offending.map((n) => JSON.stringify(n)).join(', ')}`)
  }
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
    const badKeys = Object.keys(m).filter((key) => !re.test(key))
    if (badKeys.length) throw bad(`${k} key${badKeys.length === 1 ? '' : 's'} ${badKeys.map((key) => JSON.stringify(key)).join(', ')} not ${k === 'queryParams' ? 'a "METHOD /path" endpoint' : 'a bare name (letters, digits, _ only; no spaces, no description)'}`)
    for (const [key, names] of Object.entries(m)) list(names, NAME, `${k}["${key}"] must be a list of bare names`)
  }
  if (x.testIds !== undefined) list(x.testIds, TEST_ID, 'testIds must be a list of bare names without "."')
  if (x.commands !== undefined) list(x.commands, COMMAND, 'commands must be lists of bare command words ("a b" for a sub-command)')
  if (x.files !== undefined) list(x.files, fileEntry, 'files must be plain file names (a changing part is one {name} slot, e.g. "dir/{target}.json"; no spaces, no alternatives)')
  if (x.flags !== undefined) {
    if (!isObj(x.flags)) throw bad('flags must be an object')
    for (const [key, names] of Object.entries(x.flags)) { if (key !== '' && !COMMAND.test(key)) throw bad(`flags key "${key}" is not command words`); list(names, FLAG, `flags["${key}"] must be a list of flag names`) }
  }
  if (x.listShape !== undefined && x.listShape !== 'bare array') list(x.listShape, NAME, 'listShape must be "bare array" or a list of key names')
  const t = x.conflictToken
  if (t !== undefined && !(isObj(t) && Object.keys(t).length === 2 && typeof t.name === 'string'
    && ((t.in === 'body' && NAME.test(t.name)) || (t.in === 'header' && HEADER_NAME.test(t.name))))) throw bad('conflictToken must be {"in": "body" or "header", "name": <name>}, or left out if there is none')
  return x
}

// #18: the flat list of names an interface uses, to check that a part's interface stays within its plan's.
const flat = (x: Record<string, any>): string[] => [
  ...(x.endpoints ?? []), ...Object.entries<string[]>(x.queryParams ?? {}).flatMap(([k, ns]) => ns.map((n) => `${k}?${n}`)),
  ...Object.entries<string[]>(x.fields ?? {}).flatMap(([k, ns]) => ns.map((n) => `${k}.${n}`)),
  ...(x.testIds ?? []).map((n: string) => `testId:${n}`), ...(x.commands ?? []).map((n: string) => `command:${n}`), ...(x.files ?? []).map((n: string) => `file:${n}`),
  ...Object.entries<string[]>(x.flags ?? {}).flatMap(([k, ns]) => ns.map((n) => `flag:${k}:${n}`)),
  ...(x.listShape === undefined ? [] : [`list:${Array.isArray(x.listShape) ? [...x.listShape].sort().join(',') : x.listShape}`]), ...(x.conflictToken === undefined ? [] : [`token:${x.conflictToken.in}:${x.conflictToken.name}`]), // key order and list order do not matter
]
export function checkWithin(part: Record<string, unknown>, plan: Record<string, unknown>) {
  const ok = new Set(flat(plan)), extra = flat(part).filter((n) => !ok.has(n))
  if (extra.length) throw new Error(`spec drafter: interface names outside the plan's interface: ${extra.join(', ')}`)
}

const strs = (x: unknown, who: string): string[] => {
  if (!Array.isArray(x) || !x.every((a) => typeof a === 'string')) throw new Error(`${who}: assumptions must be strings`)
  return x
}

// A drafter reply that fails validation gets ONE repair round in a fresh session (same role, same
// inputs, plus its reply and the error). Nothing is relaxed: the repaired reply must pass the same checks.
// Both rejected replies travel on the final error (`rejected`), so `draft` can keep them in the hidden run dir (lap 5).
export type Rejected = { role: string; error: string; reply: string }
export async function ask<T>(model: Model, role: string, instruction: string, parse: (j: any) => T): Promise<T> {
  let text = '', err = ''
  const rejected: Rejected[] = []
  for (const repair of [false, true]) {
    const r = await model(draftTask(role, repair ? `${instruction}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${err}\nPREVIOUS REPLY:\n${text}\n\nReply again with the whole JSON object. Change only what the error names (for a rejected summary: that scenario's summary, nothing else); every other field of every scenario stays exactly as in your previous reply.` : instruction))
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
// o.ui (#4, `draft --ui`): the spec declares a browser UI (browser.ts), the same way.
// o.run (`draft --contract`): the app is a command-line program (program.ts); a reused spec that already declares one keeps it.
export async function draft(model: Model, request: string, o: { signals?: string; app?: string; reuse?: { body: string; iface: string }; minority?: boolean; minorityBrief?: string; service?: boolean; ui?: boolean; iface?: string; run?: Contract } = {}): Promise<Omit<Draft, 'base'>> {
  const req = `REQUEST:\n${request}\n` + (o.signals ? `\nPRODUCTION SIGNALS (observed from the running app):\n${o.signals}\n` : '') + appBlock(o.app ?? '')
  const j = o.reuse ? { spec: o.reuse.body, iface: o.reuse.iface, assumptions: ['(spec reused from an approved change; the spec drafter was not called)'] } : await ask(model, 'spec-drafter', `You are the spec drafter of a software factory. Turn the request into a spec for a builder (${o.run ? 'command-line program' : `HTTP JSON API${o.ui ? ' with browser pages' : ''}`}).\n\n${req}${o.iface ? `\nPLAN INTERFACE (fixed by the approved plan for the whole request; your interface must use only these names, spelled the same, and may leave out what this part does not touch):\n${o.iface}\n` : ''}\n${SPEC_FORMAT}${o.ui ? `\n${UI_IFACE}` : ''}${o.run ? `\n${RUN_IFACE}` : ''}`, (j) => {
    if (typeof j.spec !== 'string' || !j.spec.trim()) throw new Error('spec drafter: spec missing')
    if (!UNDECIDED.test(j.spec)) throw new Error('spec drafter: spec has no "## Undecided" section')
    const iface = checkInterface(j.interface)
    if (o.iface) checkWithin(iface, JSON.parse(o.iface))
    return { spec: j.spec as string, iface: JSON.stringify(iface), assumptions: strs(j.assumptions, 'spec drafter') }
  })
  const assumptions = [`Interface (names and shapes only): ${j.iface}`, ...(o.iface ? [`(plan) the interface is within the approved plan interface: ${o.iface}`] : []), ...j.assumptions]
  // The builder sees the same names the scenarios use.
  let body = o.service ? withService(j.spec, !!o.run) : j.spec
  if (o.ui) body = withUi(body)
  if (o.run) body = withRun(body, o.run)
  if (usesRun(body) && usesUi(body)) throw new Error('a command-line program does not go with browser pages')
  const spec = `${body.trimEnd()}${IFACE_HEAD}${j.iface}\n\`\`\`\n`

  const k = await ask(model, 'scenario-drafter', `You are the scenario writer of a software factory. Write hidden acceptance scenarios (${usesRun(spec) ? 'command-line program' : 'HTTP JSON API'}) for the request. ` +
    `A builder will implement a spec you do not see; your scenarios judge it.\n\n${req}\nINTERFACE (names and shapes the builder uses; it says nothing about behaviour):\n${j.iface}\n\n${usesRun(spec) ? RUN_SCENARIO_FORMAT : SCENARIO_FORMAT}${usesService(spec) ? `\n\n${SERVICE_STEPS}${usesRun(spec) ? `\n${SERVICE_WITH_RUN}` : ''}` : ''}${usesUi(spec) ? `\n\n${UI_STEPS}` : ''}${usesRun(spec) ? `\n\n${RUN_STEPS}\nCOMMAND (the factory adds it before your "run" arguments; "{app}" is the repository root): ${contractOf(spec).command.join(' ')}` : ''}${o.minority ? minorityPrompt(o.minorityBrief) : ''}`,
  (k) => {
    const words = usesRun(spec) ? new Set<string>((JSON.parse(j.iface).commands ?? []).flatMap((c: string) => c.split(' '))) : undefined
    const scenarios = validateScenarios(k.scenarios, { commandWords: words }), more = k.assumptions === undefined ? [] : strs(k.assumptions, 'scenario drafter')
    // A program has no server to send requests to, and a server no program to run: a program's steps are "run" steps, and the fake service's ("service": true) when the spec declares one.
    if (scenarios.some((s) => s.steps.some((st) => !!st.run !== usesRun(spec) && !(usesRun(spec) && usesService(spec) && st.service)))) throw new Error(`scenario drafter: ${usesRun(spec) ? `every step of a command-line program is a "run" step${usesService(spec) ? ' or a "service" step' : ''}` : 'a "run" step needs a spec that declares a command-line program'}`)
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
// #4: a spec that declares a browser UI serves HTML pages besides its JSON.
export function runContract(spec: string): string {
  if (usesRun(spec)) return programContract(spec)
  let c = RUN_CONTRACT
  if (usesService(spec)) c = c.replace('no network at runtime.', 'no network at runtime except the external service at process.env.SERVICE_URL (see the spec).')
  if (usesUi(spec)) c = c.replace('JSON request and response bodies.', 'JSON request and response bodies for the API; pages are HTML served by the app (see the spec).')
  return c
}

// the contract of a command-line program, as the builder reads it. Where the dependency set is built the builder may run its code with the set's own python.
function programContract(spec: string): string {
  const c = contractOf(spec), deps = c.deps ? loadDeps(c.deps) : null
  return `RUN CONTRACT (fixed, non-negotiable):
- A command-line program, not a server. The factory runs \`${c.command.join(' ')} <arguments of a check>\` from a fresh empty working directory${c.pythonPath ? `, with PYTHONPATH=${c.pythonPath.map((d) => `<repository>/${d}`).join(':')}` : ''}. The program reads its input from files in that directory and from standard input; its result is its exit code, standard output, standard error and files it writes under that directory.
- ${deps ? `Python ${deps.python.split('.').slice(0, 2).join('.')} with the standard library and exactly these packages, installed read-only and pinned by hash: ${deps.packages.join(', ')}. To try your code run it with ${depsDir(c.deps!)}/venv/bin/python3.` : 'Standard library only.'} No other dependencies, no package installs, no network at runtime${usesService(spec) ? ' except the external service at the environment variable SERVICE_URL (see the spec)' : ''}.
- The repository is read-only at runtime: the program writes nothing under it (no bytecode, no caches).
- Work only inside the current directory. The factory commits your work when you finish.`
}

// FACTORY_TRANSCRIPTS=1 keeps each builder session under <state dir>/transcripts/<change>/<name>.jsonl. Builder only: its input is the
// spec, never scenario text (a drafter's, classifier's or judge's session is not kept).
export const transcriptPath = (stateDir: string, changeId: string, name: string): string | undefined =>
  (process.env.FACTORY_TRANSCRIPTS === '1' ? join(stateDir, 'transcripts', changeId, `${name}.jsonl`) : undefined)

// The builder gets the spec only. assumptions.json carries scenario-writer text: never pass it here.
export async function build(model: Model, workspace: string, spec: string, feedback: string, signal?: AbortSignal, transcript?: string): Promise<{ sha: string; ok: boolean; error?: string }> {
  const instruction = `You are the builder of a software factory. Implement the spec below in the current directory. ` +
    `Points the spec lists under "Undecided" are left to you: choose sensible behaviour.\n\nSPEC:\n${spec}\n\n${runContract(spec)}\n` +
    (feedback ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Feedback:\n${feedback}\n` : '')
  const r = await model({ ...base, maxCostUsd: CAPS.builderCallUsd, role: 'builder', instruction, workdir: workspace, access: 'write', ...(transcript ? { transcript } : {}) })
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
  const results = await runScenarios(dir, scenarios, signal, judgeOpts(spec))
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
