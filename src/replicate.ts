// Lap 5: the builder run K times, independently, from one approved spec. Nothing ships and no LLM judge
// is called: each build is scored by the hidden scenarios (of this change and of --score changes that
// share its spec) and by the experimenter's probes, which name the answer the build chose per open decision.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model, Result } from './adapter.ts'
import { CAPS, mergeLedger, startGuard, type Ledger } from './limits.ts'
import { build } from './roles.ts'
import { exportTree, removeTree } from './sandbox.ts'
import { usesRun } from './program.ts'
import { BLOCKED, judgeOpts, OTHER, runProbe, runScenarios, validateProbes, type Probe, type ProbeResult, type ScenarioResult } from './scenario.ts'
import { checkId, hiddenFile, loadApproved, type Approved } from './vault.ts'

export type ReplicateOpts = {
  changeId: string; model: Model; stateDir: string; k: number
  builderModel: string // the model the builder is asked for (names the records)
  requestedModels?: Record<string, string>
  score?: string[]; probesFile?: string; maxCostUsd?: number; stopFile?: string
  rescore?: boolean // re-run scenarios + probes on the kept workspaces; no model call
  base?: string // the repo a change drafted with --base extends; each build starts as a clone of it (HEAD = the approved base)
}
export type Replicate = {
  changeId: string; n: number; builderModel: string; requestedModels: Record<string, string>; approvedVersion: string
  sha: string; builderOk: boolean; builderError: string | null; costUsd: number
  baseSha?: string // the commit the build started from (a change that extends an app); absent = an empty repository
  answeredBy: string | null; costByModel: Record<string, number> | null // as the builder call reported them
  results: Record<string, ScenarioResult[]>; passed: Record<string, number> // per scored change id
  probes: ProbeResult[]; probesSha256: string | null; at: string; rescoredAt?: string
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
export const replicatesDir = (sd: string, id: string) => join(sd, 'runs', checkId(id), 'replicates')
// #56: a rescore keeps the judgement it replaces, numbered per build: history/<build>.<k>.json (k = 1 is the oldest).
const historyOf = (dir: string, build: string) => {
  const h = join(dir, 'history')
  return existsSync(h) ? readdirSync(h).filter((f) => f.startsWith(`${build}.`) && /^\d+\.json$/.test(f.slice(build.length + 1)))
    .sort((a, b) => Number(a.slice(build.length + 1, -5)) - Number(b.slice(build.length + 1, -5))).map((f) => join(h, f)) : []
}

async function evaluate(ws: string, sha: string, scored: [string, Approved][], probes: Probe[], signal: AbortSignal) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-rep-'))
  try {
    await exportTree(ws, sha, dir, signal) // the same bytes a judge would test
    const results: Record<string, ScenarioResult[]> = {}
    for (const [cid, a] of scored) results[cid] = await runScenarios(dir, a.scenarios, signal, judgeOpts(a.spec))
    const pr: ProbeResult[] = []
    for (const p of probes) pr.push(await runProbe(dir, p, signal))
    return { results, passed: Object.fromEntries(Object.entries(results).map(([cid, rs]) => [cid, rs.filter((r) => r.pass).length])), probes: pr }
  } finally { removeTree(dir) }
}

export async function replicate(o: ReplicateOpts): Promise<Replicate[]> {
  const id = checkId(o.changeId)
  const approved = loadApproved(o.stateDir, id)
  const runDir = join(o.stateDir, 'runs', id)
  if (existsSync(join(runDir, 'run.json'))) throw new Error(`${id} already ran; replicate and run keep separate cost records, so one change takes only one of them`)
  // Builds are of THIS spec; another change's scenarios may judge them only if it was approved with the same spec.
  const scored: [string, Approved][] = [[id, approved]]
  for (const cid of o.score ?? []) {
    const a = loadApproved(o.stateDir, cid)
    if (a.spec !== approved.spec) throw new Error(`--score ${cid}: its approved spec is not the spec of ${id}`)
    scored.push([checkId(cid), a])
  }
  let probes: Probe[] = [], probesSha256: string | null = null
  if (o.probesFile) {
    const raw = hiddenFile(o.stateDir, o.probesFile, '--probes')
    probes = validateProbes(JSON.parse(raw.toString('utf8')))
    probesSha256 = createHash('sha256').update(raw).digest('hex')
  }
  // The replicates dir marks the change as replicated (run refuses it): made only once builds really start.
  const dir = replicatesDir(o.stateDir, id)

  const stopFile = o.stopFile ?? process.env.FACTORY_STOP_FILE ?? join(o.stateDir, 'STOP')
  if (o.rescore) {
    const out: Replicate[] = []
    if (!existsSync(dir)) return out
    const guard = startGuard(CAPS.maxCostUsd, stopFile) // no model call; only the emergency stop
    try {
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        guard.check()
        const r: Replicate = readJson(join(dir, f))
        const e = await evaluate(join(o.stateDir, 'work', `${id}-rep`, f.slice(0, -5)), r.sha, scored, probes, guard.signal)
        // archived only once the new judgement exists: a failed rescore leaves no duplicate of the old one
        mkdirSync(join(dir, 'history'), { recursive: true })
        copyFileSync(join(dir, f), join(dir, 'history', `${f.slice(0, -5)}.${historyOf(dir, f.slice(0, -5)).length + 1}.json`), constants.COPYFILE_EXCL)
        Object.assign(r, e, { probesSha256, rescoredAt: new Date().toISOString() })
        writeFileSync(join(dir, f), JSON.stringify(r, null, 2))
        out.push(r)
      }
    } finally { guard.dispose() }
    return out
  }

  // A change that extends an app starts each build as a clone of that app at the commit the drafters read; a new app starts empty.
  const want = approved.base.baseSha
  if (want && !o.base) throw new Error(`${id} extends an app (${want}); give --base <repo> at that commit`)
  if (!want && o.base) throw new Error(`${id} is a new app; --base applies to a change drafted with --base`)
  if (want && execFileSync('git', ['-C', o.base!, 'rev-parse', 'HEAD']).toString().trim() !== want) throw new Error(`--base ${o.base} is not at the approved base ${want}`)
  if (probes.length && usesRun(approved.spec)) throw new Error('probes are HTTP only; a command-line program has none')
  if (!(Number.isInteger(o.k) && o.k >= 1)) throw new Error(`--k must be an integer >= 1, got ${o.k}`)
  const capUsd = o.maxCostUsd ?? CAPS.maxCostUsd
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error(`max cost must be a positive number, got ${capUsd}`)
  mkdirSync(dir, { recursive: true })
  const costFile = join(runDir, 'replicate-cost.json')
  const draftFile = join(runDir, 'draft-cost.json')
  const before: Ledger | null = existsSync(costFile) ? readJson(costFile) : null
  const drafted = existsSync(draftFile) ? (readJson(draftFile) as Ledger).totalUsd : 0
  // One cap per change: its drafts and every replicate command so far count against it.
  const guard = startGuard(capUsd, stopFile,
    { spentUsd: drafted + (before?.totalUsd ?? 0), lapFile: join(o.stateDir, 'lap-ledger.jsonl'), models: o.requestedModels })
  let last: Result | null = null
  const guarded = guard.model(o.model)
  const model: Model = async (t) => (last = await guarded(t))
  const saveCost = () => writeFileSync(costFile, JSON.stringify(mergeLedger(before, guard.ledger), null, 2)) // after every call: a stop keeps the spend
  const prefix = `${o.builderModel}-`
  const wsRoot = join(o.stateDir, 'work', `${id}-rep`)
  mkdirSync(wsRoot, { recursive: true })
  // Numbered by workspaces, not records: a build stopped before its record keeps its number (a visible gap).
  const n0 = readdirSync(wsRoot).filter((f) => f.startsWith(prefix)).length
  const out: Replicate[] = []
  try {
    for (let n = n0 + 1; n <= n0 + o.k; n++) {
      guard.check()
      const ws = join(wsRoot, `${prefix}${n}`)
      mkdirSync(ws)
      // empty (no earlier answer to read), or the app being extended, as `run` clones its ship target
      // (checked out at the approved commit, whatever the repo's HEAD has become while earlier builds ran)
      if (want) { execFileSync('git', ['clone', '-q', '--no-hardlinks', o.base!, ws], { stdio: 'pipe' }); execFileSync('git', ['-C', ws, 'checkout', '-q', '--detach', want], { stdio: 'pipe' }) }
      else execFileSync('git', ['init', '-q', '-b', 'main', ws], { stdio: 'pipe' })
      const spent = guard.ledger.totalUsd
      last = null
      let b
      try { b = await build(model, ws, approved.spec, '', guard.signal) } finally { saveCost() }
      guard.check()
      const r: Replicate = {
        changeId: id, n, builderModel: o.builderModel, requestedModels: o.requestedModels ?? {}, approvedVersion: approved.version,
        sha: b.sha, builderOk: b.ok, builderError: b.error ?? null, costUsd: guard.ledger.totalUsd - spent, ...(want ? { baseSha: want } : {}),
        answeredBy: (last as Result | null)?.model ?? null, costByModel: (last as Result | null)?.costByModel ?? null,
        ...(await evaluate(ws, b.sha, scored, probes, guard.signal)), probesSha256, at: new Date().toISOString(),
      }
      writeFileSync(join(dir, `${prefix}${n}.json`), JSON.stringify(r, null, 2))
      out.push(r)
    }
  } finally {
    guard.dispose()
    saveCost()
  }
  return out
}

// Markdown tables from the replicate records: per decision, how often each builder model chose each
// answer (other / blocked apart, with what was observed); per scored change, the scenarios passed.
export function tally(sd: string, id: string): string {
  const dir = replicatesDir(sd, id)
  const rs: Replicate[] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(dir, f))) : []
  if (!rs.length) return `${id}: no replicates`
  const models = [...new Set(rs.map((r) => r.builderModel))].sort()
  const of = (m: string) => rs.filter((r) => r.builderModel === m)
  // answered by: the models the builder calls reported, so a build another model answered is visible before reading the tables.
  const lines = [`# Replicates of ${id}`, '', `| builder model | builds | builder failed | answered by | cost (USD) | probes sha256 |`, '|---|---|---|---|---|---|',
    ...models.map((m) => `| ${m} | ${of(m).length} | ${of(m).filter((r) => !r.builderOk).length} | ${[...new Set(of(m).map((r) => r.answeredBy ?? '(unreported)'))].join('; ')} | ${of(m).reduce((a, r) => a + r.costUsd, 0).toFixed(4)} | ${[...new Set(of(m).map((r) => r.probesSha256 ?? '-'))].join(', ')} |`), '']
  for (const pid of [...new Set(rs.flatMap((r) => r.probes.map((p) => p.id)))]) {
    const answers = [...new Set(rs.flatMap((r) => r.probes.filter((p) => p.id === pid).map((p) => p.answer)))].sort((a, b) => Number([OTHER, BLOCKED].includes(a)) - Number([OTHER, BLOCKED].includes(b)) || a.localeCompare(b))
    lines.push(`## Decision ${pid}`, '', `| builder model | ${answers.join(' | ')} |`, `|---|${answers.map(() => '---|').join('')}`,
      ...models.map((m) => `| ${m} | ${answers.map((a) => of(m).filter((r) => r.probes.some((p) => p.id === pid && p.answer === a)).length).join(' | ')} |`), '')
    const missing = rs.flatMap((r) => r.probes.filter((p) => p.id === pid && [OTHER, BLOCKED].includes(p.answer)).map((p) => `- ${r.builderModel}-${r.n}: ${p.answer} ${p.detail ?? JSON.stringify(p.observed)}`))
    if (missing.length) lines.push(...missing, '')
  }
  const scored = [...new Set(rs.flatMap((r) => Object.keys(r.passed)))].sort()
  lines.push('## Scenarios passed (per build)', '', `| scored change | scenarios | ${models.join(' | ')} |`, `|---|---|${models.map(() => '---|').join('')}`,
    ...scored.map((cid) => `| ${cid} | ${rs.find((r) => r.results[cid])!.results[cid].length} | ${models.map((m) => of(m).map((r) => r.passed[cid] ?? '-').join(', ')).join(' | ')} |`), '')
  // #56: every judgement of a build (kept rescores, oldest first, then the current record); a scenario whose
  // verdict differs between them is judge-side noise, not a property of the build. A judgement without it shows "-".
  const changed: string[] = []
  let rejudged = false
  for (const r of rs) {
    const build = `${r.builderModel}-${r.n}`
    const js: Replicate[] = [...historyOf(dir, build).map(readJson), r]
    if (js.length < 2) continue
    rejudged = true
    for (const cid of [...new Set(js.flatMap((j) => Object.keys(j.results)))].sort())
      for (const sid of [...new Set(js.flatMap((j) => (j.results[cid] ?? []).map((x) => x.id)))]) {
        const vs = js.map((j) => j.results[cid]?.find((x) => x.id === sid)?.pass)
        if (new Set(vs.filter((v) => v !== undefined)).size > 1) changed.push(`| ${build} | ${cid} | ${sid} | ${vs.map((v) => v === undefined ? '-' : v ? 'pass' : 'fail').join(', ')} |`)
      }
  }
  if (rejudged) lines.push('## Verdicts that changed across judgements (oldest first)', '', ...(changed.length ? ['| build | scored change | scenario | verdicts |', '|---|---|---|---|', ...changed] : ['none']), '')
  return lines.join('\n')
}
