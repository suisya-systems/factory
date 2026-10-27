// a change that extends an app (replicate --base) and a plan whose whole was drafted with split --base. Fake models only; the apps
// are command-line programs, so no HTTP server is needed anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { main } from '../src/cli.ts'
import { runPlan, splitRequest } from '../src/plan.ts'
import { contractOf, withRun, type Contract } from '../src/program.ts'
import { replicate } from '../src/replicate.ts'
import type { Scenario } from '../src/scenario.ts'
import { approve, hash, vaultDir, writeDraft } from '../src/vault.ts'
import { freshState, gitTarget, SCENARIOS, tmp } from './helpers.ts'

const CONTRACT: Contract = { command: ['node', '{app}/cli.cjs'] }
// The program says whether the files of the repository it extends are there: true only in a build that started from the base.
const CLI = `const fs = require('node:fs'), path = require('node:path')
process.stdout.write(JSON.stringify({ readme: fs.existsSync(path.join(__dirname, 'README.md')) }))
`
const RUN_SC: Scenario = { id: 'sees-base', title: 'sees the base', summary: 'the program reports that the files it extends are present', inSpec: true, kind: 'main',
  steps: [{ run: ['probe'], expect: { status: 0, json: { stdout: { readme: true } } } }] as Scenario['steps'] }
const SPEC = withRun('# CLI\n\n## Undecided\n- x\n', CONTRACT)
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim()
const headOf = (d: string) => git(d, 'rev-parse', 'HEAD')
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await f() } finally { console.log = l; console.error = e } }
const never: Model = async () => { throw new Error('model called') }

// ---- replicate ----
const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

function extending(id: string, repo: string, spec = SPEC) {
  const dir = writeDraft(sd, id, { spec, scenarios: [RUN_SC], assumptions: [], base: { baseSha: headOf(repo), requestSha256: null } })
  approve(sd, id, { by: 't', version: hash(dir) })
}

test('replicate of a change that extends an app: refused without the repo, with the wrong one, for a new app, and for probes', async () => {
  const repo = gitTarget(), base = headOf(repo)
  extending('rb-ref', repo)
  const o = { changeId: 'rb-ref', model: never, stateDir: sd, k: 1, builderModel: 'm1' }
  await assert.rejects(replicate(o), new RegExp(`extends an app \\(${base}\\); give --base`))
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'moved') // the repo is no longer at the commit the drafters read
  await assert.rejects(replicate({ ...o, base: repo }), /is not at the approved base/)
  // a change drafted without --base starts from nothing: a repo given anyway is a mistake, not an extension
  writeDraft(sd, 'rb-new', { spec: SPEC, scenarios: [RUN_SC], assumptions: [] })
  approve(sd, 'rb-new', { by: 't', version: hash(vaultDir(sd, 'rb-new')) })
  await assert.rejects(replicate({ ...o, changeId: 'rb-new', base: gitTarget() }), /is a new app; --base applies/)
  // probes are HTTP only, and a program has no HTTP: refused although the base is right
  const ok = gitTarget()
  extending('rb-probe', ok)
  const probes = join(vaultDir(sd, 'rb-probe'), 'probes.json')
  writeFileSync(probes, JSON.stringify({ decisions: [{ id: 'd', steps: [{ method: 'GET', path: '/' }], observe: ['1:status'], options: { a: [[200]], b: [[404]] } }] }))
  await assert.rejects(replicate({ ...o, changeId: 'rb-probe', base: ok, probesFile: probes }), /probes are HTTP only/)
  for (const id of ['rb-ref', 'rb-new', 'rb-probe']) assert.ok(!existsSync(join(sd, 'runs', id, 'replicates')), `${id}: a refusal leaves no mark`)
})

test('each build starts as its own clone of the repo it extends; the repo itself is untouched; rescore needs no --base', async () => {
  const repo = gitTarget(), base = headOf(repo)
  extending('rb-ok', repo)
  const seen: { dir: string; files: string[]; head: string }[] = []
  const builder: Model = async (t: Task) => {
    seen.push({ dir: t.workdir, files: readdirSync(t.workdir).sort(), head: headOf(t.workdir) })
    writeFileSync(join(t.workdir, 'cli.cjs'), CLI) // only this build's clone gets it
    return { ok: true, text: 'built', costUsd: 0.1 }
  }
  const rs = await replicate({ changeId: 'rb-ok', model: builder, stateDir: sd, k: 2, builderModel: 'm1', base: repo })
  assert.deepEqual(seen.map((s) => [s.files, s.head]), [[['.git', 'README.md'], base], [['.git', 'README.md'], base]]) // the second does not see the first's cli.cjs
  assert.notEqual(seen[0].dir, seen[1].dir)
  assert.deepEqual(rs.map((r) => [r.baseSha, r.builderOk, r.passed]), [[base, true, { 'rb-ok': 1 }], [base, true, { 'rb-ok': 1 }]]) // README.md in the judged tree = built on the base
  for (const r of rs) {
    const ws = join(sd, 'work', 'rb-ok-rep', `m1-${r.n}`)
    assert.equal(git(ws, 'rev-list', '--count', `${base}..${r.sha}`), '1') // one builder commit on top of the base, nothing else
    assert.equal(git(ws, 'rev-parse', `${r.sha}~1`), base)
  }
  // the repo that was extended is as it was
  assert.equal(headOf(repo), base)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  assert.ok(!existsSync(join(repo, 'cli.cjs')))
  // the kept workspaces are judged again with no model and no repo
  const again = await replicate({ changeId: 'rb-ok', model: never, stateDir: sd, k: 0, builderModel: 'm1', rescore: true })
  assert.deepEqual(again.map((r) => [r.baseSha, r.passed, !!r.rescoredAt]), [[base, { 'rb-ok': 1 }, true], [base, { 'rb-ok': 1 }, true]])
})

test('a build that did not start from the base fails the scenario that needs its files', async () => {
  const repo = gitTarget()
  extending('rb-bad', repo)
  // a builder that deletes what it extends: the judged tree has no README.md
  const rs = await replicate({ changeId: 'rb-bad', stateDir: sd, k: 1, builderModel: 'm1', base: repo, model: async (t) => {
    execFileSync('git', ['-C', t.workdir, 'rm', '-q', 'README.md'])
    writeFileSync(join(t.workdir, 'cli.cjs'), CLI)
    return { ok: true, text: '', costUsd: 0 }
  } })
  assert.deepEqual(rs[0].passed, { 'rb-bad': 0 })
})

// ---- split / plan ----
test('splitRequest: an existing app changes the rules for every part; without one the wording is as before', async () => {
  const tasks: Task[] = []
  const m: Model = async (t) => { tasks.push(t); return { ok: true, costUsd: 0, text: JSON.stringify({ parts: [{ id: 'a', title: 'a', request: 'r' }, { id: 'b', title: 'b', request: 'r' }] }) } }
  await splitRequest(m, 'WHOLE', 'pl', { app: '=== README.md\nhello\n', program: true })
  assert.match(tasks[0].instruction, /EXISTING APP \(the current code; the request extends it\):\n=== README\.md/)
  assert.match(tasks[0].instruction, /every part extends the EXISTING APP below/)
  assert.match(tasks[0].instruction, /\(a command-line program\)/)
  assert.doesNotMatch(tasks[0].instruction, /part 1 builds a new app/)
  await splitRequest(m, 'WHOLE', 'pl')
  assert.match(tasks[1].instruction, /part 1 builds a new app, every later part extends the app the earlier parts built/)
  assert.match(tasks[1].instruction, /\(an HTTP JSON API\)/)
  assert.doesNotMatch(tasks[1].instruction, /EXISTING APP/)
})

const PARTS = [{ id: 'one', title: 'first', request: 'part one request' }, { id: 'two', title: 'second', request: 'part two request' }]
// extend: the whole is drafted with split --base (and --base-path README.md); program: with --contract. The builder writes the program.
async function world(o: { extend: boolean; program: boolean }) {
  const sd = freshState()
  process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')
  const target = realpathSync(gitTarget())
  const base = headOf(target)
  const req = join(tmp('req'), 'req.md'), cf = join(tmp('contract'), 'contract.json')
  writeFileSync(req, 'WHOLE REQUEST: a program')
  writeFileSync(cf, JSON.stringify(CONTRACT))
  const log: Task[] = []
  const model: Model = async (t) => {
    log.push(t)
    const asProgram = t.instruction.includes('(command-line program)')
    if (t.role === 'splitter') return { ok: true, text: JSON.stringify({ parts: PARTS }), costUsd: 0.1 }
    if (t.role === 'spec-drafter') return { ok: true, costUsd: 0.1, text: JSON.stringify({ spec: '# CLI\n\n## Undecided\n- x\n', assumptions: [], interface: o.program ? { commands: ['probe'] } : { endpoints: ['GET /notes'] } }) }
    if (t.role === 'scenario-drafter') return { ok: true, costUsd: 0.1, text: JSON.stringify({ scenarios: asProgram ? [RUN_SC] : [SCENARIOS[1]], assumptions: [] }) }
    if (t.role === 'classifier') return { ok: false, text: '', costUsd: 0.01, error: 'down' }
    if (t.role === 'builder') { writeFileSync(join(t.workdir, 'cli.cjs'), CLI); return { ok: true, text: 'built', costUsd: 0.1 } }
    return { ok: true, text: '{"pass": true, "reason": "fine"}', costUsd: 0.05 }
  }
  const cli = (argv: string[]) => quiet(() => main(argv, model))
  const result = () => JSON.parse(readFileSync(join(sd, 'runs', 'pl.plan', 'result.json'), 'utf8'))
  const calls: string[][] = []
  const plan = () => quiet(() => runPlan(sd, 'pl', { shipTarget: target, port: 1, maxAttempts: 2, stopFile: join(sd, 'NOSTOP') }, (argv) => { calls.push(argv); return main(argv, model) }))
  const approveWaiting = async () => { const id = result().reason.replace('approve ', ''); assert.equal(await cli(['approve', id, '--by', 't', '--version', hash(vaultDir(sd, id))]), 0); return id }
  assert.equal(await cli(['split', 'pl', '--request', req, ...(o.extend ? ['--base', target, '--base-path', 'README.md'] : []), ...(o.program ? ['--contract', cf] : [])]), 0)
  const version = readFileSync(join(sd, 'runs', 'pl.plan', 'plan-summary.md'), 'utf8').match(/Version: (\w+)/)![1]
  assert.equal(await cli(['approve', 'pl', '--by', 't', '--version', version]), 0)
  const draftArgv = () => calls.filter((c) => c[0] === 'draft')
  return { sd, target, base, cf, log, cli, plan, result, approveWaiting, calls, draftArgv }
}
const sha256 = (s: string) => import('node:crypto').then(({ createHash }) => createHash('sha256').update(s).digest('hex'))

test('a plan whose whole extends an app: every part, part 1 too, is drafted against it with the same paths and contract; it ships by fast-forward', async () => {
  const w = await world({ extend: true, program: true })
  const whole = JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-whole'), 'base.json'), 'utf8'))
  assert.deepEqual(whole, { baseSha: w.base, requestSha256: whole.requestSha256, paths: ['README.md'] })
  assert.equal(await w.plan(), 3)
  const [d1] = w.draftArgv()
  assert.equal(d1[1], 'pl-one')
  assert.deepEqual(d1.slice(d1.indexOf('--base')), ['--base', w.target, '--base-path', 'README.md', '--contract', join(w.sd, 'runs', 'pl.plan', 'parts', 'contract.json')])
  assert.deepEqual(JSON.parse(readFileSync(d1[d1.indexOf('--contract') + 1], 'utf8')), CONTRACT) // the whole's contract, read back from its approved spec
  const p1 = JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-one'), 'base.json'), 'utf8'))
  assert.deepEqual(p1, { baseSha: w.base, requestSha256: await sha256('part one request'), paths: ['README.md'] })
  assert.deepEqual(contractOf(readFileSync(join(vaultDir(w.sd, 'pl-one'), 'spec.md'), 'utf8')), CONTRACT)
  assert.match(w.log.filter((l) => l.role === 'spec-drafter').at(-1)!.instruction, /EXISTING APP[\s\S]*=== README\.md/)
  assert.equal(await w.approveWaiting(), 'pl-one')
  assert.equal(await w.plan(), 3) // part 1 shipped, part 2 drafted on what part 1 shipped
  const [, d2] = w.draftArgv()
  assert.equal(d2[1], 'pl-two')
  const p2 = JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-two'), 'base.json'), 'utf8'))
  assert.equal(p2.baseSha, headOf(w.target))
  assert.notEqual(p2.baseSha, w.base)
  assert.deepEqual(p2.paths, ['README.md'])
  assert.equal(await w.approveWaiting(), 'pl-two')
  assert.equal(await w.plan(), 0)
  assert.equal(w.result().status, 'done')
  assert.deepEqual(w.result().whole, { sha: headOf(w.target), pass: true, passed: 1, total: 1 })
  assert.equal(git(w.target, 'rev-list', '--count', `${w.base}..HEAD`), '2') // one commit per part, on the base
})

test('a plan that extends refuses to start when the ship target is not at the whole\'s base commit', async () => {
  const w = await world({ extend: true, program: true })
  git(w.target, 'commit', '-q', '--allow-empty', '-m', 'moved')
  const drafts = w.log.length
  await assert.rejects(w.plan(), /the whole request was drafted against .*, but the ship target is at/)
  assert.equal(w.log.length, drafts) // nothing drafted or built
  assert.equal(w.draftArgv().length, 0)
  // the refused start fixed nothing: once the target is back at the base the same plan starts
  assert.ok(!existsSync(join(w.sd, 'runs', 'pl.plan', 'chain.json')))
  git(w.target, 'reset', '-q', '--hard', 'HEAD~1')
  assert.equal(await w.plan(), 3)
})

// A part drafted by hand under the id the plan reserves: it must have the whole's base commit, paths and contract.
async function vetted(draftArgs: (w: Awaited<ReturnType<typeof world>>) => Promise<string[]>) {
  const w = await world({ extend: true, program: true })
  const reqFile = join(tmp('req'), 'p1.md')
  writeFileSync(reqFile, PARTS[0].request) // the plan's own request for part 1: only the other properties differ
  assert.equal(await w.cli(['draft', 'pl-one', '--request', reqFile, '--iface-from', 'pl-whole', ...(await draftArgs(w))]), 0)
  assert.equal(await w.plan(), 3) // an unapproved draft: waiting
  await w.approveWaiting()
  const builds = w.log.filter((l) => l.role === 'builder').length
  assert.equal(await w.plan(), 1)
  assert.equal(w.log.filter((l) => l.role === 'builder').length, builds)
  return w.result().reason as string
}

test('part 1 drafted against another commit, other paths, or without the contract is not built', async () => {
  const otherRepo = gitTarget()
  git(otherRepo, 'commit', '-q', '--allow-empty', '-m', 'another history')
  assert.match(await vetted(async (w) => ['--base', otherRepo, '--base-path', 'README.md', '--contract', w.cf]), /pl-one was drafted against [0-9a-f]{40}, not [0-9a-f]{40}/)
  assert.match(await vetted(async (w) => ['--base', w.target, '--contract', w.cf]), /pl-one was shown other paths of the app than the plan's whole request/)
  assert.match(await vetted(async (w) => ['--base', w.target, '--base-path', 'README.md']), /pl-one does not declare the command-line contract of the plan's whole request/)
  // and drafted as a new app (no --base at all) is the old "no app" mistake, named as such
  assert.match(await vetted(async (w) => ['--contract', w.cf]), /pl-one was drafted against no app, not [0-9a-f]{40}/)
})

test('a plan whose whole is a new app (no --base) drafts part 1 without --base, as before; later parts extend the shipped app', async () => {
  const w = await world({ extend: false, program: true })
  assert.equal(await w.plan(), 3)
  const [d1] = w.draftArgv()
  assert.ok(!d1.includes('--base') && !d1.includes('--base-path'), d1.join(' '))
  assert.ok(d1.includes('--contract')) // the program contract still goes to every part
  assert.equal(JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-one'), 'base.json'), 'utf8')).baseSha, null)
  assert.equal(await w.approveWaiting(), 'pl-one')
  assert.equal(await w.plan(), 3)
  const [, d2] = w.draftArgv()
  assert.deepEqual(d2.slice(d2.indexOf('--base'), d2.indexOf('--base') + 2), ['--base', w.target]) // part 2 extends part 1, without path limits
  assert.ok(!d2.includes('--base-path'))
  assert.equal(JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-two'), 'base.json'), 'utf8')).baseSha, headOf(w.target))
})

test('a plan for an HTTP app (no --base, no contract) drafts part 1 with neither', async () => {
  const w = await world({ extend: false, program: false })
  assert.equal(await w.plan(), 3)
  const [d1] = w.draftArgv()
  assert.deepEqual(d1.filter((a) => ['--base', '--base-path', '--contract'].includes(a)), [])
  assert.equal(JSON.parse(readFileSync(join(vaultDir(w.sd, 'pl-one'), 'base.json'), 'utf8')).baseSha, null)
})
