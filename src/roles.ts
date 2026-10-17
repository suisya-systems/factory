// Three model-calling roles: drafter, builder, judge. (The shipper is ship.ts and calls no model.)
// Each role gets a Model; the run loop passes one wrapped by the limits guard.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CAPS } from './limits.ts'
import { classify } from './classify.ts'
import { exportTree, removeTree, sandboxGit } from './sandbox.ts'
import { runScenarios, validateScenarios, type Scenario, type ScenarioResult } from './scenario.ts'
import type { Draft } from './vault.ts'

// No per-call ceiling of their own: the guard gives each call what is left of the change / lap caps.
// Always call these roles through a guard (an unguarded Infinity budget is not a valid CLI budget).
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
// spec drafter's assumptions (incl. the interface: names and shapes only, so both use one vocabulary).
// Then every scenario is classified by a third, spec-only procedure (classify.ts).
export const INTERFACE_KEYS = ['endpoints', 'queryParams', 'fields', 'listShape', 'conflictToken']

const SPEC_FORMAT = `Reply with ONE JSON object and nothing else:
{"spec": "<markdown spec for the builder>",
 "interface": {"endpoints": ["METHOD /path", ...], "queryParams": {"METHOD /path": ["name", ...]}, "fields": {"<resource>": ["name", ...]},
   "listShape": "<'bare array', or the envelope's key names; say that a missing next page is null>", "conflictToken": {"in": "body|header", "name": "..."}},
 "assumptions": ["<one line each: what you assumed because the request did not say>"]}
"interface" holds NAMES AND SHAPES ONLY, and must match the spec: no status codes and no rules (no AND/OR, matching, ordering,
defaults, limits or page boundaries). It is given to a separate scenario writer who never sees your spec.
You cannot ask questions: record every guess in assumptions.`

const SCENARIO_FORMAT = `Reply with ONE JSON object and nothing else:
{"assumptions": ["<one line each: anything YOU assumed beyond the given assumptions>"],
 "scenarios": [{"id": "kebab-id", "title": "...", "summary": "<one line, NO concrete paths/values; this is all the builder sees if it fails>",
   "inSpec": <true if the REQUEST or the GIVEN ASSUMPTIONS state this behaviour, false if it is an unstated but reasonable expectation>, "kind": "<crud|validation|not-found|paging|filter|conflict|...>",
   "steps": [{"method": "GET|POST|PUT|PATCH|DELETE", "path": "/...", "body": <json, optional, not on GET>, "headers": {<optional>},
     "expect": {"status": <int or [ints]>, "json": <partial deep subset, optional>, "jsonHas": ["dot.path", ...], "isArray": <bool>, "length": <int, or {"dot.path": int} for arrays inside the body>},
     "capture": {"name": "dot.path", "name2": "header:<response header name>"}}]}]}
"{{name}}" in a later path/body/headers/json is replaced by a captured value (a value that is exactly "{{name}}" keeps the captured type).
Every expect needs at least one check. Arrays in "json" match by position (a prefix), so only list items whose order is fixed;
use "length" to check that a list holds exactly the expected items.
Use ONLY the endpoint, parameter and field names in the interface assumption. Where neither the request nor the assumptions fix a status code, accept every reasonable one (e.g. [409, 412]).
Each scenario starts from an EMPTY app.
Write 8-15 scenarios, a mix of inSpec true and false. You cannot ask questions: record every guess in assumptions.`

const appBlock = (app: string) => (app ? `\nEXISTING APP (the current code; the request extends it):\n${app}\n` : '')
const draftTask = (role: string, instruction: string) => ({ ...base, role, instruction, workdir: mkdtempSync(join(tmpdir(), 'factory-draft-')), access: 'none' as const })

function checkInterface(x: unknown): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || Object.keys(x).length === 0) throw new Error('spec drafter: interface missing')
  for (const k of Object.keys(x)) if (!INTERFACE_KEYS.includes(k)) throw new Error(`spec drafter: unknown interface field "${k}"`)
  if (/\b[1-5]\d\d\b/.test(JSON.stringify(x))) throw new Error('spec drafter: interface must not carry status codes')
  return x as Record<string, unknown>
}

const strs = (x: unknown, who: string): string[] => {
  if (!Array.isArray(x) || !x.every((a) => typeof a === 'string')) throw new Error(`${who}: assumptions must be strings`)
  return x
}

export async function draft(model: Model, request: string, o: { signals?: string; app?: string } = {}): Promise<Omit<Draft, 'base'>> {
  const req = `REQUEST:\n${request}\n` + (o.signals ? `\nPRODUCTION SIGNALS (observed from the running app):\n${o.signals}\n` : '') + appBlock(o.app ?? '')
  const a = await model(draftTask('spec-drafter', `You are the spec drafter of a software factory. Turn the request into a spec for a builder (HTTP JSON API).\n\n${req}\n${SPEC_FORMAT}`))
  if (!a.ok) throw new Error(`spec drafter failed: ${a.error}`)
  const j = extractJson(a.text)
  if (typeof j.spec !== 'string' || !j.spec.trim()) throw new Error('spec drafter: spec missing')
  const iface = JSON.stringify(checkInterface(j.interface))
  const assumptions = [`Interface (names and shapes only): ${iface}`, ...strs(j.assumptions, 'spec drafter')]
  // The builder sees the same names the scenarios use.
  const spec = `${j.spec.trimEnd()}\n\n## Interface (names and shapes, shared with the scenario writer)\n\n\`\`\`json\n${iface}\n\`\`\`\n`

  const b = await model(draftTask('scenario-drafter', `You are the scenario writer of a software factory. Write hidden acceptance scenarios (HTTP JSON API) for the request. ` +
    `A builder will implement a spec you do not see; your scenarios judge it.\n\n${req}\nASSUMPTIONS (made by the spec writer; follow them):\n${assumptions.map((x) => `- ${x}`).join('\n')}\n\n${SCENARIO_FORMAT}`))
  if (!b.ok) throw new Error(`scenario drafter failed: ${b.error}`)
  const k = extractJson(b.text)
  const scenarios = validateScenarios(k.scenarios)
  const more = k.assumptions === undefined ? [] : strs(k.assumptions, 'scenario drafter')
  return { spec, scenarios, assumptions: [...assumptions, ...more.map((x) => `(scenario writer) ${x}`)], classification: await classify(model, spec, o.app ?? '', scenarios, extractJson) }
}

// ---- builder ----
export const RUN_CONTRACT = `RUN CONTRACT (fixed, non-negotiable):
- Node.js 22, standard library only. No dependencies, no package installs, no network at runtime.
- package.json must have "scripts": {"start": "..."}; \`npm start\` starts the HTTP server on process.env.PORT (bind 127.0.0.1 only; a listener on any other address fails the run).
- Persist data only under process.env.DATA_DIR (if at all). The app directory is read-only at runtime.
- JSON request and response bodies.
- Work only inside the current directory. The factory commits your work when you finish.`

// The builder gets the spec only. assumptions.json carries scenario-writer text: never pass it here.
export async function build(model: Model, workspace: string, spec: string, feedback: string, signal?: AbortSignal): Promise<{ sha: string; ok: boolean; error?: string }> {
  const instruction = `You are the builder of a software factory. Implement the spec below in the current directory.\n\nSPEC:\n${spec}\n\n${RUN_CONTRACT}\n` +
    (feedback ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Feedback:\n${feedback}\n` : '')
  const r = await model({ ...base, role: 'builder', instruction, workdir: workspace, access: 'write' })
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
  const results = await runScenarios(dir, scenarios, signal)
  const testsAllPass = results.every((r) => r.pass)
  const instruction = `You are the judge of a software factory. The deterministic hidden scenarios have already run. Read the code in the current directory (read-only) and decide whether it satisfies the spec as a whole.\n\nSPEC:\n${spec}\n\nSCENARIOS:\n${JSON.stringify(scenarios)}\n\nRESULTS:\n${JSON.stringify(results)}\n\nReply with ONE JSON object: {"pass": true|false, "reason": "..."}`
  let r
  try { r = await model({ ...base, role: 'judge', instruction, workdir: dir, access: 'read' }) }
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
export function feedbackFor(v: Verdict, scenarios: Scenario[]): string {
  const byId = new Map(scenarios.map((s) => [s.id, s.summary]))
  const lines = v.results.filter((r) => !r.pass).map((r) => `- failed: ${byId.get(r.id) ?? 'a hidden scenario'}`)
  if (v.llmPass === false) lines.push('- LLM judge did not approve')
  return lines.join('\n')
}
