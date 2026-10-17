// A request too big for one change (#18): `split` proposes ordered parts, the owner approves the plan, and `plan` builds the
// parts one after another (each extends the app the previous one shipped), then checks the WHOLE request on the final commit.
// State is read from disk on every call (like `lap`): the command stops at each human gate and the same command resumes.
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from './adapter.ts'
import { approve, checkId, hash, loadApproved, vaultDir } from './vault.ts'
import { ask, checkWithin, specIface } from './roles.ts'
import { exportTree, removeTree, sandboxGit } from './sandbox.ts'
import { isObj, runScenarios } from './scenario.ts'

export type Part = { id: string; title: string; request: string }
export type Plan = { plan: string; requestSha256: string; wholeId: string; parts: Part[]; changeIds: string[] }

export const MIN_PARTS = 2, MAX_PARTS = 6
export const MAX_RETRIES = 3 // a part's retries are change ids `<id>-r2` .. `-r4`, all reserved when the plan is made
const PART_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const planDir = (sd: string, plan: string) => join(sd, 'runs', `${checkId(plan)}.plan`) // '.' is not in a change id: no clash with a change's run dir
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const wholeIdOf = (plan: string) => `${plan}-whole`
export const partChangeId = (plan: string, part: string) => `${plan}-${part}`
export const retryId = (id: string, k: number) => (k === 0 ? id : `${id}-r${k + 1}`) // k = 0 is the first try

// What the splitter may send back. The part ids become pieces of change ids, so they can never look like the plan's
// own derived ids (`whole`, or a retry suffix `-rN`) and must stay short enough for every derived id to pass checkId.
export function validateParts(x: unknown, plan: string): Part[] {
  const bad = (m: string) => new Error(`splitter: ${m}`)
  if (!Array.isArray(x) || x.length < MIN_PARTS || x.length > MAX_PARTS) throw bad(`needs ${MIN_PARTS} to ${MAX_PARTS} parts (a request that fits one change takes \`draft\`)`)
  const seen = new Set<string>()
  return x.map((p, i): Part => {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.request !== 'string') throw bad(`part ${i + 1} must be {id, title, request} strings`)
    if (!PART_ID.test(p.id) || p.id === 'whole' || /-r\d+$/.test(p.id)) throw bad(`part id "${p.id}" must be lower-case words joined by "-" and not "whole" or end in "-r<number>"`)
    if (seen.has(p.id)) throw bad(`part id "${p.id}" appears twice`)
    seen.add(p.id)
    if (!p.title.trim() || !p.request.trim()) throw bad(`part "${p.id}" has an empty title or request`)
    for (let k = 0; k <= MAX_RETRIES; k++) checkId(retryId(partChangeId(plan, p.id), k)) // too long: refused before anything is spent
    return { id: p.id, title: p.title, request: p.request }
  })
}

const SPLIT_FORMAT = `Reply with ONE JSON object and nothing else:
{"parts": [{"id": "<lower-case-words-joined-by-dashes, at most 20 characters>", "title": "<short>", "request": "<the part's own request, in plain words>"}, ...]}
Rules: ${MIN_PARTS} to ${MAX_PARTS} parts, in BUILD ORDER: part 1 builds a new app, every later part extends the app the earlier parts built.
Each part is one small change a builder can finish alone. Each "request" must be self-contained (it is read without the others), say what
this part adds, and use the names of the whole request. Together the parts must cover the whole request and add nothing to it.
Do not decide behaviour the request leaves open. You cannot ask questions.`

export async function splitRequest(model: Model, request: string, plan: string): Promise<Part[]> {
  return ask(model, 'splitter', `You are the splitter of a software factory. The request below is too big for one change (an HTTP JSON API). Split it into ordered parts.\n\nREQUEST:\n${request}\n\n${SPLIT_FORMAT}`,
    (j) => validateParts(j?.parts, plan))
}

// Every change id the plan owns, so a clash with any existing change (or another plan) is found before a model is called.
export function derivedIds(plan: string, parts: Part[]): string[] {
  return [plan, wholeIdOf(plan), ...parts.flatMap((p) => Array.from({ length: MAX_RETRIES + 1 }, (_, k) => retryId(partChangeId(plan, p.id), k)))]
}
export function assertIdsFree(sd: string, plan: string, ids: string[]) {
  const taken = new Set<string>()
  for (const d of existsSync(join(sd, 'runs')) ? readdirSync(join(sd, 'runs')).filter((f) => f.endsWith('.plan')) : []) {
    const f = join(sd, 'runs', d, 'plan.json')
    if (existsSync(f)) JSON.parse(readFileSync(f, 'utf8')).changeIds.forEach((i: string) => taken.add(i))
  }
  for (const id of ids) {
    if (taken.has(id) || existsSync(vaultDir(sd, id)) || existsSync(join(sd, 'runs', id))) throw new Error(`plan ${plan}: change id ${id} is already used; choose another plan name`)
  }
}

export const isPlan = (sd: string, id: string) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id) && existsSync(join(planDir(sd, id), 'plan.json'))

// The version the owner approves: the plan (parts and request) and the whole draft (spec interface + scenarios) together.
export function planVersion(sd: string, plan: string): string {
  const p = JSON.parse(readFileSync(join(planDir(sd, plan), 'plan.json'), 'utf8')) as Plan
  return sha256(`${sha256(readFileSync(join(planDir(sd, plan), 'plan.json')))}\0${hash(vaultDir(sd, p.wholeId))}`)
}

export function summaryOf(sd: string, p: Plan, version: string): string {
  return [
    `# Plan approval request: ${p.plan}`, '', `Version: ${version}`, '',
    `Approve with: \`npm run factory -- approve ${p.plan} --by <name> --version ${version}\`  (approves the plan and the whole-request draft ${p.wholeId} below, exactly as they are)`, '',
    `## Parts, in build order (${p.parts.length}). Each part is drafted after the one before it has shipped, and needs its own entrance approval then.`,
    ...p.parts.map((x, i) => `${i + 1}. ${x.id}: ${x.title}\n   ${x.request.trim().replaceAll('\n', '\n   ')}`), '',
    `## The whole request is verified by the scenarios of ${p.wholeId}, run on the final shipped commit (read ${join(vaultDir(sd, p.wholeId), 'approval-summary.md')}).`,
    `Its interface also binds every part: a part's drafters may use only names from it.`, '',
  ].join('\n')
}

export function writePlan(sd: string, p: Plan, request: string): string {
  const dir = planDir(sd, p.plan)
  mkdirSync(join(dir, 'parts'), { recursive: true })
  writeFileSync(join(dir, 'request.md'), request)
  const f = join(dir, 'plan.json')
  writeFileSync(f, JSON.stringify(p, null, 2))
  chmodSync(f, 0o444)
  const version = planVersion(sd, p.plan)
  writeFileSync(join(dir, 'plan-summary.md'), summaryOf(sd, p, version))
  return version
}

export function loadPlan(sd: string, plan: string, needApproval = true): Plan & { version: string } {
  const dir = planDir(sd, plan)
  if (!existsSync(join(dir, 'plan.json'))) throw new Error(`${plan} is not a plan (run \`split\` first)`)
  const p = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan
  const version = planVersion(sd, plan)
  if (needApproval) {
    const a = join(dir, 'plan-approval.json')
    if (!existsSync(a)) throw new Error(`plan ${plan} is not approved`)
    if (JSON.parse(readFileSync(a, 'utf8')).version !== version) throw new Error(`plan ${plan}: the plan or its whole draft was modified after approval`)
    loadApproved(sd, p.wholeId)
  }
  return { ...p, version }
}

export function approvePlan(sd: string, plan: string, a: { by: string; version: string; note?: string }): string {
  const dir = planDir(sd, plan)
  if (existsSync(join(dir, 'plan-approval.json'))) throw new Error(`plan ${plan} is already approved`)
  const p = loadPlan(sd, plan, false)
  if (a.version !== p.version) throw new Error(`plan ${plan}: the plan on disk (version ${p.version}) is not the version you reviewed (${a.version}); re-read the summary`)
  const whole = vaultDir(sd, p.wholeId)
  if (!existsSync(join(whole, 'approval.json'))) approve(sd, p.wholeId, { by: a.by, version: hash(whole), note: `plan ${plan} (version ${p.version})` })
  else loadApproved(sd, p.wholeId)
  const f = join(dir, 'plan-approval.json')
  writeFileSync(f, JSON.stringify({ version: p.version, by: a.by, note: a.note ?? '', at: new Date().toISOString() }, null, 2))
  chmodSync(f, 0o444)
  return p.version
}

// ---- the build ----
export type PlanOpts = { shipTarget: string; port: number; retries?: number; maxCostUsd?: number; maxAttempts?: number; stopFile: string }
type RunRec = { status: string; stopReason: string; shipped: { sha: string } | null; attempts: { builderOk: boolean; llmPass: boolean | null }[] }
type PartRep = { part: string; changeIds: string[]; status: 'pending' | 'drafted' | 'approved' | 'shipped' | 'failed'; sha?: string; reason?: string }

const readJson = <T>(f: string): T | null => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)

// Trying again can change the result only when the builds ran and were really rejected. A retry cap that was reached through
// failed builder calls or judge calls with no verdict is an error of the factory's side, not a verdict: not retried.
export const retryable = (r: RunRec) => r.status === 'failed' && /^retry cap reached/.test(r.stopReason) && r.attempts.length > 0 && r.attempts.every((a) => a.builderOk && a.llmPass !== null)

// factory: the CLI's own main (in process, so tests inject a fake model). Exit: 0 done, 1 failed, 3 waiting for an approval.
export async function runPlan(sd: string, plan: string, o: PlanOpts, factory: (argv: string[]) => Promise<number>): Promise<number> {
  const p = loadPlan(sd, plan)
  const dir = planDir(sd, plan)
  const retries = o.retries ?? 1
  if (!(Number.isInteger(retries) && retries >= 0 && retries <= MAX_RETRIES)) throw new Error(`--retries must be an integer from 0 to ${MAX_RETRIES}, got ${o.retries}`)
  // Same checks as `run`, before anything is drafted: an invalid limit is never replaced by the default.
  if (o.maxCostUsd !== undefined && !(Number.isFinite(o.maxCostUsd) && o.maxCostUsd > 0)) throw new Error(`max cost must be a positive number, got ${o.maxCostUsd}`)
  if (o.maxAttempts !== undefined && !(Number.isInteger(o.maxAttempts) && o.maxAttempts >= 1)) throw new Error(`max attempts must be an integer >= 1, got ${o.maxAttempts}`)
  const target = realpathSync(o.shipTarget)
  const head = async () => {
    const h = await sandboxGit(target, ['rev-parse', 'HEAD'], false)
    if (h.code !== 0 || !/^[0-9a-f]{40}$/.test(h.out.trim())) throw new Error(`${target}: no readable HEAD`)
    return h.out.trim()
  }
  // The chain: where the plan ships and from which commit it started. A later call with another target or port is refused.
  const chainFile = join(dir, 'chain.json')
  const chain = readJson<{ shipTarget: string; port: number; initialHead: string }>(chainFile) ?? { shipTarget: target, port: o.port, initialHead: await head() }
  if (chain.shipTarget !== target || chain.port !== o.port) throw new Error(`plan ${plan} started with ship target ${chain.shipTarget} on port ${chain.port}; resume with the same`)
  if (!existsSync(chainFile)) writeFileSync(chainFile, JSON.stringify(chain, null, 2))

  const reps: PartRep[] = p.parts.map((x) => ({ part: x.id, changeIds: [], status: 'pending' }))
  let whole: unknown = null
  const report = (status: 'waiting' | 'failed' | 'done', reason: string) => {
    writeFileSync(join(dir, 'result.json.tmp'), JSON.stringify({ at: new Date().toISOString(), status, reason, parts: reps, whole }, null, 2))
    renameSync(join(dir, 'result.json.tmp'), join(dir, 'result.json'))
    console.log(`plan ${plan}: ${status}${reason ? ` (${reason})` : ''}`)
    return status === 'done' ? 0 : status === 'waiting' ? 3 : 1
  }
  const rec = (id: string) => readJson<RunRec>(join(sd, 'runs', id, 'run.json'))
  const stopped = () => existsSync(o.stopFile)

  try {
    let prev: string = chain.initialHead // the commit the next part must extend
    for (const [i, part] of p.parts.entries()) {
      const rep = reps[i]
      const id0 = partChangeId(plan, part.id)
      const tries = Array.from({ length: retries + 1 }, (_, k) => retryId(id0, k))
      // What makes a change this plan's part: drafted from the plan's request for it, on the commit the part before shipped,
      // with an interface within the plan's. An ordinary change that took a reserved id fails this, shipped or not.
      const vet = (id: string): string | null => {
        const a = loadApproved(sd, id)
        if (a.base.requestSha256 !== sha256(part.request)) return `${id} was not drafted from the plan's request for part ${part.id}`
        if (a.base.baseSha !== (i === 0 ? null : prev)) return `${id} was drafted against ${a.base.baseSha ?? 'no app'}, not ${i === 0 ? 'a new app' : prev}`
        try { checkWithin(JSON.parse(specIface(a.spec)), JSON.parse(specIface(loadApproved(sd, p.wholeId).spec))) } catch (e) { return `${id}: ${(e as Error).message}` }
        return null
      }
      const done = tries.find((t) => rec(t)?.status === 'shipped')
      if (done) {
        const bad = vet(done)
        if (bad) return report('failed', bad)
        rep.status = 'shipped'; rep.changeIds = tries.filter((t) => rec(t)); rep.sha = prev = rec(done)!.shipped!.sha; continue }
      if (stopped()) return report('failed', `emergency stop is active (${o.stopFile}); delete it by hand to continue`)
      if ((await head()) !== prev) return report('failed', `${part.id}: the ship target is not at ${prev} (the commit the plan has shipped so far); parts must extend exactly what the one before shipped`)

      if (!existsSync(join(vaultDir(sd, id0), 'spec.md'))) {
        const reqFile = join(dir, 'parts', `${part.id}.md`)
        writeFileSync(reqFile, part.request)
        // The plan's interface binds the part: the whole scenarios and the parts must speak one vocabulary.
        const code = await factory(['draft', id0, '--request', reqFile, '--iface-from', p.wholeId, ...(i > 0 ? ['--base', target] : [])])
        if (code !== 0) return report('failed', `draft ${id0}: exit ${code}`)
        rep.status = 'drafted'
        rep.changeIds = [id0]
        console.log(`plan ${plan}: part ${i + 1}/${p.parts.length} (${part.id}) drafted; read ${join(vaultDir(sd, id0), 'approval-summary.md')}, approve it, then resume`)
        return report('waiting', `approve ${id0}`)
      }
      if (!existsSync(join(vaultDir(sd, id0), 'approval.json'))) { rep.status = 'drafted'; rep.changeIds = [id0]; return report('waiting', `approve ${id0}`) }
      const approved = loadApproved(sd, id0)
      const bad = vet(id0)
      if (bad) return report('failed', bad)
      rep.status = 'approved'

      let last = ''
      for (const [k, id] of tries.entries()) {
        const old = rec(id)
        if (old && old.status === 'running') return report('failed', `${id} was interrupted (its record says running; a deploy may or may not have happened); check the ship target and the prod release, then start a new plan`)
        if (!old) {
          if (stopped()) return report('failed', `emergency stop is active (${o.stopFile}); delete it by hand to continue`)
          if (k > 0) { // the same approved set under a new id: fresh builds, the same version
            if (!existsSync(vaultDir(sd, id))) cpSync(vaultDir(sd, id0), vaultDir(sd, id), { recursive: true, preserveTimestamps: true })
            if (loadApproved(sd, id).version !== approved.version) return report('failed', `${id} is not a copy of the approved ${id0}`)
          }
          await factory(['run', id, '--ship-target', target, '--port', String(o.port), ...(o.maxCostUsd !== undefined ? ['--max-cost', String(o.maxCostUsd)] : []), ...(o.maxAttempts !== undefined ? ['--max-attempts', String(o.maxAttempts)] : [])])
        }
        const r = rec(id)
        rep.changeIds.push(id)
        if (!r) return report('failed', `run ${id}: no record`)
        if (r.status === 'shipped') { rep.status = 'shipped'; rep.sha = prev = r.shipped!.sha; last = ''; break }
        if (r.status === 'running') return report('failed', `${id} was interrupted (its record says running)`)
        last = `${id}: ${r.stopReason}`
        if (!retryable(r)) { rep.status = 'failed'; rep.reason = last; return report('failed', `${last} (not a verdict: not retried)`) }
      }
      if (rep.status !== 'shipped') { rep.status = 'failed'; rep.reason = last; return report('failed', `part ${part.id} rejected in ${tries.length} ${tries.length === 1 ? 'try' : 'tries'}; the later parts were not started. Last: ${last}`) }
    }

    // All parts shipped: the whole request, on exactly the final commit. No model, no ship; a failing whole is reported, never patched.
    const wf = join(dir, 'whole.json')
    const old = readJson<{ sha: string; pass: boolean }>(wf)
    if (!old) {
      if (stopped()) return report('failed', `emergency stop is active (${o.stopFile}); delete it by hand to continue`)
      if ((await head()) !== prev) return report('failed', `the ship target is not at the final shipped commit ${prev}; the whole request is not checked on another one`)
      const tmp = mkdtempSync(join(tmpdir(), 'factory-whole-'))
      const ac = new AbortController(), poll = setInterval(() => { if (stopped()) ac.abort() }, 500)
      try {
        await exportTree(target, prev, tmp, ac.signal)
        const results = await runScenarios(tmp, loadApproved(sd, p.wholeId).scenarios, ac.signal)
        if (stopped()) return report('failed', `emergency stop is active (${o.stopFile}); the whole request was not recorded`)
        writeFileSync(wf, JSON.stringify({ sha: prev, pass: results.every((r) => r.pass), results }, null, 2))
      } finally { clearInterval(poll); removeTree(tmp) }
    }
    const w = readJson<{ sha: string; pass: boolean; results: { id: string; pass: boolean }[] }>(wf)!
    whole = { sha: w.sha, pass: w.pass, passed: w.results.filter((r) => r.pass).length, total: w.results.length }
    if (w.sha !== prev) return report('failed', `whole.json is for ${w.sha}, not the final commit ${prev}`)
    return w.pass ? report('done', `all ${p.parts.length} parts shipped; the whole request passes ${w.results.length}/${w.results.length} scenarios`) : report('failed', `all parts shipped but the whole request fails: ${w.results.filter((r) => !r.pass).map((r) => r.id).join(', ')}`)
  } catch (e) { report('failed', `error: ${(e as Error).message}`); throw e }
}

