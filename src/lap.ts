// One lap, one command: `factory lap <definition>` runs the lap's steps from the top and stops only at a human gate.
// The definition (JSON, written by the creator) holds every step's argv as an array: no shell, so no word splitting.
// Progress lives in $STATE/laps/<name>/; the same command resumes after a gate, skipping finished steps.
// The definition is trusted code (an `exec` step could run anything); the owner approves it as part of every gate.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { noteLap, Stop } from './limits.ts'
import { retryId } from './plan.ts'
import { approve, checkId, hash, loadApproved, stateDir, vaultDir } from './vault.ts'

export type Step = {
  factory?: string[]; exec?: string[] // argv; `{state}` in any arg is replaced by the state dir
  copy?: string; from?: string; to?: string[] // an approved vault set, from another state dir or to other ids
  gate?: string; approve?: string[]; fix?: Record<string, string>; read?: string[] // human stop
  newShipTarget?: string // run only: README of a fresh ship target $STATE/ship/<id>
  always?: boolean // exec / tally / observe only: runs even after a failed step (reports)
  parallel?: Step[]; max?: number // independent runs (or replicates) of one group, at most `max` at once
  redraft?: number // draft only (#32): a failed draft is drafted again as <id>-r2, -r3 .. at most this often; later steps say <id>
}
export type LapDef = { name: string; home?: string; steps: Step[] }

// Commands a step may run. approve / stop / serve are not steps: approval happens at a gate, by a human.
const FACTORY_STEPS = ['draft', 'run', 'replicate', 'tally', 'probe-isolation', 'observe']
const FREE = ['tally', 'observe'] // no model call: may be `always`
const KEYS: Record<string, string[]> = { factory: ['newShipTarget', 'always', 'redraft'], exec: ['always'], copy: ['from', 'to'], gate: ['approve', 'fix', 'read'], parallel: ['max'] }
// A group runs side by side only what shares nothing but the lap ledger: each change its own run dir, work dir,
// ship target and prod port. One command per group: `run x-rep` would share replicate x's work dir.
const PARALLEL = ['run', 'replicate']
const MAX_REDRAFTS = 3

// The value of `--name v` / `--name=v` in an argv (as parseArgs reads it: the last one wins).
function opt(argv: string[], name: string): string | undefined {
  let v: string | undefined
  argv.forEach((a, i) => { if (a === `--${name}`) v = argv[i + 1]; else if (a.startsWith(`--${name}=`)) v = a.slice(name.length + 3) })
  return v
}
// The ship target a run step ships to, before {state} is known for a fresh one.
const shipTargetOf = (s: Step) => (s.newShipTarget !== undefined ? `{state}/ship/${s.factory![1]}` : opt(s.factory!, 'ship-target'))

const strs = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((a) => typeof a === 'string')
export function parseLap(text: string): LapDef {
  const d = JSON.parse(text)
  const bad = (m: string) => new Error(`lap definition: ${m}`)
  if (typeof d?.name !== 'string') throw bad('name missing')
  checkId(d.name)
  if (d.home !== undefined && typeof d.home !== 'string') throw bad('home must be a path')
  if (!Array.isArray(d.steps) || d.steps.length === 0) throw bad('steps missing')
  const seen = new Set<string>(), gates = new Set<string>()
  const drafts: [string, string][] = [], redrafted = new Map<string, string>() // a redraft's names -> its step
  const check = (s: Step, at: string) => {
    const kind = Object.keys(KEYS).filter((k) => k in s)
    if (kind.length !== 1) throw bad(`${at}: needs exactly one of ${Object.keys(KEYS).join(', ')}`)
    const k = kind[0]
    for (const key of Object.keys(s)) if (key !== k && !KEYS[k].includes(key)) throw bad(`${at}: "${key}" does not go with ${k}`)
    if (k === 'factory' || k === 'exec') if (!strs(s[k])) throw bad(`${at}: ${k} must be a non-empty argv array of strings`)
    if (k === 'factory') {
      const [cmd, id] = s.factory!
      if (!FACTORY_STEPS.includes(cmd)) throw bad(`${at}: factory ${cmd} is not a lap step (allowed: ${FACTORY_STEPS.join(', ')})`)
      if (s.newShipTarget !== undefined && (cmd !== 'run' || typeof s.newShipTarget !== 'string')) throw bad(`${at}: newShipTarget (a README text) goes with run only`)
      if (s.always && !FREE.includes(cmd)) throw bad(`${at}: always goes with exec, tally and observe only (no model call after a failure)`)
      if (cmd === 'run') checkId(id ?? '')
      if (cmd === 'draft') drafts.push([id, at])
      if (s.redraft !== undefined) {
        if (cmd !== 'draft' || !(Number.isInteger(s.redraft) && s.redraft >= 1 && s.redraft <= MAX_REDRAFTS)) throw bad(`${at}: redraft (an integer from 1 to ${MAX_REDRAFTS}) goes with draft only`)
        for (let k = 0; k <= s.redraft; k++) redrafted.set(checkId(retryId(id ?? '', k)), at) // too long: refused before anything runs
      }
    }
    if (k === 'copy') {
      checkId(s.copy!)
      if ((s.from === undefined) === (s.to === undefined)) throw bad(`${at}: copy needs exactly one of from, to`)
      if (s.from !== undefined && typeof s.from !== 'string') throw bad(`${at}: from must be a state dir path`)
      if (s.to !== undefined) { if (!strs(s.to)) throw bad(`${at}: to must be a list of change ids`); s.to.forEach(checkId) }
    }
    if (k === 'gate') {
      checkId(s.gate!)
      if (gates.has(s.gate!)) throw bad(`${at}: gate "${s.gate}" appears twice`)
      gates.add(s.gate!)
      if (s.approve !== undefined) { if (!strs(s.approve)) throw bad(`${at}: approve must be a list of change ids`); s.approve.forEach(checkId) }
      if (s.read !== undefined && !strs(s.read)) throw bad(`${at}: read must be a list of files`)
      for (const [dest, src] of Object.entries(s.fix ?? {})) {
        const n = normalize(dest)
        if (typeof src !== 'string' || n.startsWith('..') || n.startsWith('/') || n.split('/')[0] === 'laps') throw bad(`${at}: fix "${dest}" must be a path inside the state dir (not laps/) -> a source file`)
      }
    }
    if (k === 'parallel') {
      const g = s.parallel!
      if (!Array.isArray(g) || g.length === 0) throw bad(`${at}: parallel must be a non-empty list of steps`)
      if (!(Number.isInteger(s.max) && s.max! >= 1)) throw bad(`${at}: parallel needs max, an integer >= 1 (how many run at once)`)
      g.forEach((t, j) => {
        check(t, `${at}.${j + 1}`)
        if (!t.factory || !PARALLEL.includes(t.factory[0])) throw bad(`${at}.${j + 1}: a parallel group holds only factory ${PARALLEL.join(' / ')} steps`)
      })
      const one = (what: string, xs: (string | undefined)[]) => { if (new Set(xs).size !== xs.length) throw bad(`${at}: two steps of the group share ${what}; they cannot run side by side`) }
      if (new Set(g.map((t) => t.factory![0])).size > 1) throw bad(`${at}: a parallel group holds one command (run or replicate), not both`)
      one('a change id', g.map((t) => checkId(t.factory![1] ?? '')))
      if (g[0].factory![0] === 'run') {
        const ports = g.map((t) => opt(t.factory!, 'port') ?? '8787')
        for (const p of ports) if (!/^\d+$/.test(p) || +p < 1 || +p > 65535) throw bad(`${at}: --port ${p} is not a port`)
        one('a --port (one prod per port)', ports.map(Number).map(String))
        const targets = g.map(shipTargetOf)
        if (targets.includes(undefined)) throw bad(`${at}: a run needs --ship-target or newShipTarget`)
        one('a ship target (changes to one app stay sequential)', targets.map((t) => resolve(t!)))
      }
    }
    const key = JSON.stringify(s)
    if (seen.has(key)) throw bad(`${at}: the same step appears twice (progress is kept per step content)`)
    seen.add(key)
  }
  d.steps.forEach((s: Step, i: number) => check(s, `step ${i + 1}`))
  // A redraft takes the next names: no other step may draft them (or the same id), or `<id>` would mean two sets.
  for (const [id, at] of drafts) { const o = redrafted.get(id); if (o && o !== at) throw bad(`${at}: draft ${id} is a name ${o} may redraft as`) }
  return d
}

// names: a redrafted id -> the name it was drafted as (#32); redrafts: each failed draft that was drafted again, and why.
type Redraft = { step: string; id: string; failed: string; as: string; reason: string }
type Progress = { steps: Record<string, { status: 'running' | 'done' | 'failed'; reason?: string; at: string }>; waiting: string | null; names?: Record<string, string>; redrafts?: Redraft[] }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
// The tree equality `cp -a` + `diff -r` gave: same relative paths, same bytes.
function sameTree(a: string, b: string): boolean {
  const ls = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort()
  const la = ls(a), lb = ls(b)
  return la.length === lb.length && la.every((p, i) => p === lb[i] && (statSync(join(a, p)).isDirectory() || readFileSync(join(a, p)).equals(readFileSync(join(b, p)))))
}

export type LapOpts = { approve?: string; by?: string; version?: string }
// factory: the CLI's own main (in process, so tests inject a fake model). Exit: 0 done, 1 failed, 3 stopped at a gate.
export async function lap(file: string, o: LapOpts, factory: (argv: string[]) => Promise<number>): Promise<number> {
  const defBytes = readFileSync(file)
  const def = parseLap(defBytes.toString('utf8'))
  if (def.home) {
    const want = resolve(def.home)
    if (process.env.FACTORY_HOME && resolve(process.env.FACTORY_HOME) !== want) throw new Error(`FACTORY_HOME is ${process.env.FACTORY_HOME}, but the lap's home is ${want}; unset it`)
    process.env.FACTORY_HOME = want
  }
  const sd = stateDir()
  const dir = join(sd, 'laps', def.name)
  const progFile = join(dir, 'progress.json')
  const stopFile = process.env.FACTORY_STOP_FILE ?? join(sd, 'STOP')
  const resume = `npm run factory -- lap ${file}`
  const stopped = () => existsSync(stopFile) && `emergency stop is active (${stopFile}); delete it by hand to continue`
  for (const f of ['lap-ledger.jsonl', 'lap-ledger.json']) if (!existsSync(progFile) && existsSync(join(sd, f))) throw new Error(`${sd} is not a fresh state dir (${f} exists); a lap starts from a fresh FACTORY_HOME`)
  const prog: Progress = existsSync(progFile) ? JSON.parse(readFileSync(progFile, 'utf8')) : { steps: {}, waiting: null }
  const save = () => { mkdirSync(dir, { recursive: true }); writeFileSync(`${progFile}.tmp`, JSON.stringify(prog, null, 2)); renameSync(`${progFile}.tmp`, progFile) }
  // A redrafted id stands for the name it was drafted as, wherever a step names it: a whole arg, or a piece of a path,
  // a comma list or `--opt=` (`{state}/vault/<id>/spec.md`, `--score <id>,<id>`); never the command itself or a piece of the state dir.
  const name = (id: string) => (prog.names && Object.hasOwn(prog.names, id) ? prog.names[id] : id)
  const sub = (argv: string[]) => argv.map((a, i) => (i ? a.split(/([/,=])/).map(name).join('') : a).replaceAll('{state}', sd))

  // A gate's version binds the whole definition (every later step, run count and cap), each draft's version and
  // each fixed / read file's bytes. Any change after approval asks for approval again.
  const gateVersion = (g: Step) => {
    const missing = [...Object.values(g.fix ?? {}), ...(g.read ?? [])].filter((f) => !existsSync(f))
    if (missing.length) return { missing }
    const h = createHash('sha256').update(`definition\0${sha256(defBytes)}\0`)
    // The redrafts before the gate are settled by then (those steps never run again); later ones never move this version.
    for (const s of def.steps.slice(0, def.steps.indexOf(g))) if (s.redraft && name(s.factory![1]) !== s.factory![1]) h.update(`redraft\0${s.factory![1]}\0${name(s.factory![1])}\0`)
    for (const id of g.approve ?? []) h.update(`approve\0${id}\0${hash(vaultDir(sd, name(id)))}\0`)
    for (const [dest, src] of Object.entries(g.fix ?? {})) h.update(`fix\0${dest}\0${sha256(readFileSync(src))}\0`)
    for (const f of g.read ?? []) h.update(`read\0${f}\0${sha256(readFileSync(f))}\0`)
    return { missing, version: h.digest('hex') }
  }
  const gateRecord = (g: Step) => join(dir, 'gates', `${g.gate}.json`)

  if (o.approve) {
    if (stopped()) { console.error(`factory: ${stopped()}`); return 1 }
    const g = def.steps.find((s) => s.gate === o.approve)
    if (!g) throw new Error(`lap ${def.name} has no gate "${o.approve}"`)
    if (prog.waiting !== g.gate) throw new Error(`lap ${def.name} is not waiting at gate "${g.gate}"; run \`${resume}\` first`)
    const { missing, version } = gateVersion(g)
    if (!version) throw new Error(`gate "${g.gate}" is still waiting for ${missing.join(', ')}`)
    if (o.version !== version) throw new Error(`gate "${g.gate}": the current version is ${version}, not the version you reviewed (${o.version}); re-read the summary`)
    // Everything checked before anything is written, so a refused approval leaves no half-approved gate.
    const fixes = Object.entries(g.fix ?? {}).map(([dest, src]) => ({ dest: join(sd, dest), bytes: readFileSync(src) }))
    for (const f of fixes) if (existsSync(f.dest) && !readFileSync(f.dest).equals(f.bytes)) throw new Error(`${f.dest} is already fixed with other content`)
    for (const id of (g.approve ?? []).map(name)) {
      if (!existsSync(join(vaultDir(sd, id), 'approval.json'))) approve(sd, id, { by: o.by!, version: hash(vaultDir(sd, id)), note: `lap ${def.name}, gate ${g.gate} (version ${version})` })
      else loadApproved(sd, id) // approved earlier: still the same set
    }
    for (const f of fixes) {
      mkdirSync(dirname(f.dest), { recursive: true })
      if (!existsSync(f.dest)) { writeFileSync(f.dest, f.bytes); chmodSync(f.dest, 0o444) }
    }
    mkdirSync(join(dir, 'gates'), { recursive: true })
    writeFileSync(gateRecord(g), JSON.stringify({ version, by: o.by, at: new Date().toISOString(), files: Object.fromEntries(fixes.map((f) => [f.dest, sha256(f.bytes)])) }, null, 2))
    prog.waiting = null
    save()
    console.log(`approved gate "${g.gate}" of lap ${def.name} by ${o.by}; version ${version}. Resume with: ${resume}`)
    return 0
  }

  // Throws when the step did not finish as the lap expects.
  const doStep = async (s: Step, at: string) => {
    if (s.exec) {
      const argv = sub(s.exec)
      const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' })
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error(`${argv.join(' ')}: exit ${r.status ?? r.signal}`)
    } else if (s.copy) {
      const pairs = s.from ? [[join(resolve(s.from), 'vault', s.copy), s.copy]] : s.to!.map((t) => [vaultDir(sd, name(s.copy!)), t])
      for (const [src, id] of pairs) {
        if (!existsSync(join(src, 'approval.json'))) throw new Error(`copy ${s.copy}: ${src} is not an approved set`)
        const dst = vaultDir(sd, id)
        if (!existsSync(dst)) cpSync(src, dst, { recursive: true, preserveTimestamps: true })
        if (!sameTree(src, dst)) throw new Error(`copy ${s.copy}: ${dst} differs from ${src}`)
        loadApproved(sd, id) // the copy still matches its approval
      }
    } else if (s.redraft) {
      // A failed draft is drafted again under the next name; its spend stays in the lap ledger. A stop or a cap is not retried.
      const [cmd, id, ...rest] = s.factory!
      for (let k = 0; ; k++) {
        const as = retryId(id, k)
        if (k > 0 && (existsSync(vaultDir(sd, as)) || existsSync(join(sd, 'runs', as)))) throw new Error(`redraft of ${id}: ${as} already exists`)
        try {
          const code = await factory([cmd, as, ...sub(rest)])
          if (code !== 0) throw new Error(`factory draft ${as}: exit ${code}`)
          if (k > 0) prog.names = { ...prog.names, [id]: as }
          return
        } catch (e) {
          if (k === s.redraft || e instanceof Stop || stopped()) throw e
          const r: Redraft = { step: at, id, failed: as, as: retryId(id, k + 1), reason: (e as Error).message }
          prog.redrafts = [...prog.redrafts ?? [], r]
          save()
          noteLap(join(sd, 'lap-ledger.jsonl'), 'redraft', { lap: def.name, ...r })
          console.error(`lap ${def.name}: ${at}: draft ${as} failed (${r.reason}); drafting it again as ${r.as}`)
        }
      }
    } else {
      const argv = sub(s.factory!)
      const runFile = argv[0] === 'run' ? join(sd, 'runs', argv[1], 'run.json') : ''
      if (runFile && existsSync(runFile)) throw new Error(`${argv[1]} already ran before this step`) // never read an old record as this step's result
      if (s.newShipTarget !== undefined) {
        const t = join(sd, 'ship', argv[1])
        if (existsSync(t)) throw new Error(`ship target ${t} already exists`)
        const git = (...a: string[]) => execFileSync('git', ['-C', t, '-c', 'user.name=factory', '-c', 'user.email=factory@localhost', ...a], { stdio: 'pipe' })
        mkdirSync(t, { recursive: true })
        git('init', '-q', '-b', 'main')
        writeFileSync(join(t, 'README.md'), s.newShipTarget)
        git('add', '-A')
        git('commit', '-qm', 'init')
        argv.push('--ship-target', t)
      }
      const code = await factory(argv)
      if (runFile) {
        // A run that used up its attempts is a result (laps count it); a cap, a stop or an error is a failure.
        if (!existsSync(runFile)) throw new Error(`run ${argv[1]}: no record (exit ${code})`)
        const r = JSON.parse(readFileSync(runFile, 'utf8'))
        if (r.status !== 'shipped' && !/^retry cap reached/.test(r.stopReason)) throw new Error(`run ${argv[1]}: ${r.stopReason}`)
      } else if (code !== 0) throw new Error(`factory ${argv.join(' ')}: exit ${code}`)
    }
  }

  let failed = ''
  // A step other than a gate: skipped when done, recorded before any spend, never re-run after a failure.
  // An `always` step makes no model call (a report), so one that failed or was cut off runs again on the next pass.
  const runStep = async (s: Step, at: string) => {
    const key = JSON.stringify(s), st = prog.steps[key]
    if (st?.status === 'done') return
    if (st && !s.always) { failed ||= `${at} ${st.status === 'running' ? 'was interrupted (the lap ended during it)' : `failed: ${st.reason}`}`; return }
    // While the STOP file exists only `always` exec steps (the report) run; nothing is recorded for the skipped ones.
    if (stopped() && !(s.always && s.exec)) { failed ||= stopped() as string; return }
    if (failed && !s.always) return
    prog.steps[key] = { status: 'running', at: new Date().toISOString() } // recorded before any spend: an interrupted step is never re-run silently
    save()
    try {
      await doStep(s, at)
      prog.steps[key] = { status: 'done', at: new Date().toISOString() }
    } catch (e) {
      prog.steps[key] = { status: 'failed', reason: (e as Error).message, at: new Date().toISOString() }
      failed ||= `${at} failed: ${(e as Error).message}`
    }
    save()
  }
  for (const [i, s] of def.steps.entries()) {
    const at = `step ${i + 1}`
    if (s.parallel) {
      // The same rules per step; after the first failure (or a STOP) no step of the group starts, the running ones finish.
      const real = (t: string) => (existsSync(t) ? realpathSync(t) : resolve(t)) // two spellings of one checkout are one app
      const group = s.parallel.map((t) => ({ ...t, factory: sub(t.factory!) })) // as they will run: a redraft may make two names one
      const targets = group.filter((t) => t.factory[0] === 'run').map((t) => real(shipTargetOf(t)!.replaceAll('{state}', sd)))
      if (new Set(targets).size !== targets.length) { failed ||= `${at}: two runs of the group ship to the same checkout`; continue }
      if (new Set(group.map((t) => t.factory[1])).size !== group.length) { failed ||= `${at}: two steps of the group name one change (after a redraft)`; continue }
      const todo = s.parallel.map((t, j) => [t, `${at}.${j + 1}`] as const)
      await Promise.all(Array.from({ length: Math.min(s.max!, todo.length) }, async () => { while (todo.length) await runStep(...todo.shift()!) }))
      continue
    }
    if (s.gate) {
      if (stopped()) { failed ||= stopped() as string; continue }
      if (failed) continue
      // Never cached: checked again on every resume against the current definition and files.
      let missing: string[], version: string | undefined, rec
      try {
        ({ missing, version } = gateVersion(s))
        rec = existsSync(gateRecord(s)) ? JSON.parse(readFileSync(gateRecord(s), 'utf8')) : null
        if (version && rec?.version === version) {
          for (const [f, h] of Object.entries(rec.files as Record<string, string>)) if (!existsSync(f) || sha256(readFileSync(f)) !== h) throw new Error(`fixed file ${f} changed after approval`)
          for (const id of s.approve ?? []) loadApproved(sd, name(id))
          continue
        }
      } catch (e) { failed ||= `${at} (gate "${s.gate}") failed: ${(e as Error).message}`; continue } // the report steps still run
      prog.waiting = s.gate!
      save()
      if (!version) { console.log(`lap ${def.name}: waiting at gate "${s.gate}" for ${missing.join(', ')} (the creator writes them); then resume with: ${resume}`); return 3 }
      const summary = join(dir, `${s.gate}.md`)
      writeFileSync(summary, [
        `# Lap ${def.name}: gate "${s.gate}"`, '',
        `Version: ${version}`, '',
        `Approve with: \`npm run factory -- lap ${file} --approve ${s.gate} --by <name> --version ${version}\``, '',
        ...(rec ? ['An earlier approval of this gate no longer matches: the definition or one of the files below changed since.', ''] : []),
        `Approving this gate approves the lap definition as it is now (${file}, sha256 ${sha256(defBytes)}): every step after this gate, with its run counts and caps.`, '',
        ...(prog.redrafts?.length ? ['## Redrafts (a failed draft was drafted again under the next name; every step names it by its first name)', ...prog.redrafts.map((r) => `- ${r.step}: ${r.failed} failed (${r.reason}); drafted again as ${r.as}`), ''] : []),
        ...(s.approve?.length ? ['## Changes to approve at the entrance (read each approval summary)', ...s.approve.map((id) => `- ${id}${name(id) !== id ? ` (drafted as ${name(id)})` : ''}: ${join(vaultDir(sd, name(id)), 'approval-summary.md')} (version ${hash(vaultDir(sd, name(id)))})`), ''] : []),
        ...(s.fix ? ['## Files fixed by this approval (pre-registration; never changed afterwards)', ...Object.entries(s.fix).map(([d, f]) => `- ${join(sd, d)} <- ${f} (sha256 ${sha256(readFileSync(f))})`), ''] : []),
        ...(s.read?.length ? ['## Also read', ...s.read.map((f) => `- ${f} (sha256 ${sha256(readFileSync(f))})`), ''] : []),
      ].join('\n'))
      console.log(`lap ${def.name}: stopped at gate "${s.gate}" for approval. Read ${summary}; after approving, resume with: ${resume}`)
      return 3
    }
    await runStep(s, at)
  }
  failed ||= stopped() || '' // a STOP that came during the last step: never report the lap as done
  if (failed) { console.error(`lap ${def.name}: failed (${failed}). A failed or interrupted step is never re-run; change the definition (e.g. a new change id) to go on.`); return 1 }
  prog.waiting = null
  save()
  console.log(`lap ${def.name}: done`)
  return 0
}
