// Three model-calling roles: drafter, builder, judge. (The shipper is ship.ts and calls no model.)
// Each role gets a Model; the run loop passes one wrapped by the limits guard.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { CAPS } from './limits.ts'
import { exportTree, removeTree, sandboxGit } from './sandbox.ts'
import { runScenarios, validateScenarios, type Scenario, type ScenarioResult } from './scenario.ts'
import type { Draft } from './vault.ts'

const base = { maxCostUsd: CAPS.maxCostUsd, timeoutMs: CAPS.modelTimeoutMs }

export function extractJson(text: string): any {
  const tries = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const t of tries) {
    if (!t) continue
    try { return JSON.parse(t) } catch { /* next */ }
  }
  throw new Error('model reply contained no parseable JSON object')
}

// ---- drafter ----
const DRAFT_FORMAT = `Reply with ONE JSON object and nothing else:
{"spec": "<markdown spec for the builder>", "assumptions": ["<each thing you assumed because the request did not say>"],
 "scenarios": [{"id": "kebab-id", "title": "...", "summary": "<one line, NO concrete paths/values; this is all the builder sees if it fails>",
   "inSpec": <true if the spec states this behaviour, false if it is an unstated but reasonable expectation>, "kind": "<crud|validation|not-found|persistence|...>",
   "steps": [{"method": "GET|POST|PUT|PATCH|DELETE", "path": "/...", "body": <json, optional, not on GET>, "headers": {<optional>},
     "expect": {"status": <int or [ints]>, "json": <partial deep subset, optional>, "jsonHas": ["dot.path", ...], "isArray": <bool>, "length": <int>},
     "capture": {"name": "dot.path"}}]}]}
"{{name}}" in a later path/body/json is replaced by a captured value (a value that is exactly "{{name}}" keeps the captured type).
Every expect needs at least one check. Arrays in "json" match by position (a prefix), so only list items whose order the spec fixes.
Each scenario starts from an EMPTY app.
Write 8-15 scenarios, a mix of inSpec true and false. You cannot ask questions: record every guess in assumptions.`

export async function draft(model: Model, request: string, signals?: string): Promise<Draft> {
  const instruction = `You are the drafter of a software factory. Turn the request into a spec for a builder and hidden acceptance scenarios (HTTP JSON API).\n\nREQUEST:\n${request}\n` +
    (signals ? `\nPRODUCTION SIGNALS (observed from the running app):\n${signals}\n` : '') + `\n${DRAFT_FORMAT}`
  const r = await model({ ...base, role: 'drafter', instruction, workdir: mkdtempSync(join(tmpdir(), 'factory-draft-')), access: 'none' })
  if (!r.ok) throw new Error(`drafter failed: ${r.error}`)
  const j = extractJson(r.text)
  if (typeof j.spec !== 'string' || !j.spec.trim()) throw new Error('drafter: spec missing')
  if (!Array.isArray(j.assumptions) || !j.assumptions.every((a: unknown) => typeof a === 'string')) throw new Error('drafter: assumptions must be strings')
  return { spec: j.spec, scenarios: validateScenarios(j.scenarios), assumptions: j.assumptions }
}

// ---- builder ----
export const RUN_CONTRACT = `RUN CONTRACT (fixed, non-negotiable):
- Node.js 22, standard library only. No dependencies, no package installs, no network at runtime.
- package.json must have "scripts": {"start": "..."}; \`npm start\` starts the HTTP server on process.env.PORT (bind 127.0.0.1 only; a listener on any other address fails the run).
- Persist data only under process.env.DATA_DIR (if at all). The app directory is read-only at runtime.
- JSON request and response bodies.
- Work only inside the current directory. The factory commits your work when you finish.`

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
