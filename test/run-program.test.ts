// the whole loop for a command-line program (build -> judge -> retry -> ship by fast-forward), with a fake model and no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { parseLap } from '../src/lap.ts'
import { withRun } from '../src/program.ts'
import { replicate } from '../src/replicate.ts'
import { build } from '../src/roles.ts'
import { runChange } from '../src/run.ts'
import type { Scenario } from '../src/scenario.ts'
import { ship } from '../src/ship.ts'
import { userJudge } from '../src/user.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { freshState, gitTarget, REPO, tmp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')
const never = new AbortController().signal
const head = (d: string) => execFileSync('git', ['-C', d, 'rev-parse', 'HEAD']).toString().trim()
const PORT = 59321 // handed to ship / runChange and never listened on: the tests check that nothing opens it or its prod dir

const GOOD = "process.stdout.write(JSON.stringify({ hello: process.argv[3] }))"
const WRONG = "process.stdout.write(JSON.stringify({ hello: 'nobody' }))"
const SCENARIOS: Scenario[] = [
  { id: 'greet', title: 'greet', summary: 'the greet sub-command greets the name it is given', inSpec: true, kind: 'main',
    steps: [{ run: ['greet', 'quokka-77'], expect: { status: 0, json: { stdout: { hello: 'quokka-77' } } } }] },
  { id: 'greet-again', title: 'greet again', summary: 'a second name is greeted too', inSpec: true, kind: 'main',
    steps: [{ run: ['greet', 'wombat-31'], expect: { status: 0, json: { stdout: { hello: 'wombat-31' } } } }] },
]
const SPEC = withRun('# Greeter\n- greet prints a greeting\n\n## Undecided\n- the exit code on a missing name', { command: ['node', '{app}/cli.cjs'] })
const CLASSIFICATION = SCENARIOS.map((s) => ({ id: s.id, label: 'readable' as const, basis: 'spec' as const, checks: [] }))
function program(id: string, scenarios = SCENARIOS, spec = SPEC, base?: { baseSha: string | null; requestSha256: string | null }) {
  const dir = writeDraft(sd, id, { spec, scenarios, assumptions: [], classification: CLASSIFICATION.slice(0, scenarios.length), base })
  return approve(sd, id, { by: 'test', version: hash(dir) })
}
// The fake builder: `code` per attempt, written as cli.cjs; the judge model approves.
const lap = (codes: string[], seen: string[] = []): Model => {
  let n = 0
  return async (t) => {
    if (t.role === 'builder') {
      seen.push(t.instruction)
      writeFileSync(join(t.workdir, 'cli.cjs'), codes[Math.min(n++, codes.length - 1)])
      return { ok: true, text: 'built', costUsd: 0.5 }
    }
    return { ok: true, text: '{"pass": true}', costUsd: 0.1 }
  }
}
const runIt = (id: string, model: Model, target: string, maxAttempts?: number) =>
  runChange({ changeId: id, shipTarget: target, model, stateDir: sd, port: PORT, stopFile: join(sd, 'NOSTOP'), maxAttempts })

test('a program ships by fast-forward only: no release, no signals, no prod dir, no listener; the builder is told it is no server', async () => {
  program('prog-ok')
  const target = gitTarget(), seen: string[] = []
  const r = await runIt('prog-ok', lap([GOOD], seen), target)
  assert.equal(r.status, 'shipped', r.stopReason)
  assert.equal(head(target), r.attempts[0].sha) // the target moved to the built commit
  assert.match(execFileSync('git', ['-C', target, 'log', '--format=%s', '-1']).toString(), /factory: builder attempt/)
  assert.equal(r.shipped?.release, '') // nothing was exported or flipped
  assert.equal(r.signals, null) // nothing to observe
  assert.ok(!existsSync(join(sd, 'prod', String(PORT))), 'a program has no prod dir')
  assert.ok(!existsSync(join(sd, 'prod')) || readdirSync(join(sd, 'prod')).length === 0)
  assert.equal(await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false), false, 'nothing listens')
  assert.equal(seen.length, 1)
  assert.match(seen[0], /A command-line program, not a server/)
  assert.match(seen[0], /node \{app\}\/cli\.cjs|node <repository>\/cli\.cjs/)
  assert.doesNotMatch(seen[0], /npm start/)
  for (const lit of ['quokka-77', 'wombat-31', 'the greet sub-command greets', 'a second name']) assert.ok(!seen[0].includes(lit), `builder saw ${lit}`)
})

test('a build that fails a run scenario is rejected with summary lines only; the next attempt ships', async () => {
  program('prog-retry')
  const target = gitTarget(), seen: string[] = []
  const r = await runIt('prog-retry', lap([WRONG, GOOD], seen), target)
  assert.equal(r.status, 'shipped', r.stopReason)
  assert.deepEqual(r.attempts.map((a) => [a.testsAllPass, a.pass]), [[false, false], [true, true]])
  assert.equal(seen.length, 2)
  assert.match(seen[1], /- failed: the greet sub-command greets the name it is given/)
  assert.match(seen[1], /- failed: a second name is greeted too/)
  assert.doesNotMatch(seen[1], /nobody|quokka-77|wombat-31|expected|stdout/) // not the output, not the argument, not the check
  assert.equal(head(target), r.attempts[1].sha)
})

test('a program that never passes ships nothing', async () => {
  program('prog-never')
  const target = gitTarget(), h0 = head(target)
  const r = await runIt('prog-never', lap([WRONG]), target, 2)
  assert.equal(r.status, 'failed')
  assert.match(r.stopReason, /retry cap reached/)
  assert.equal(head(target), h0)
  assert.equal(r.shipped, null)
})

// ---- ship(..., serve = false) ----
async function built() {
  const target = gitTarget(), ws = tmp('ws')
  execFileSync('git', ['clone', '-q', target, ws])
  const { sha } = await build(async (t) => { writeFileSync(join(t.workdir, 'cli.cjs'), GOOD); return { ok: true, text: '', costUsd: 0 } }, ws, 'spec', '')
  return { target, ws, mark: { changeId: 'c', sha, approvedVersion: 'v' } }
}

test('ship without serving: a dirty target or another branch is refused as for a served ship, and nothing is merged', async () => {
  const { target, ws, mark } = await built()
  const h0 = head(target), g = (...a: string[]) => execFileSync('git', ['-C', target, ...a], { stdio: 'pipe' })
  writeFileSync(join(target, 'stray.txt'), 'x')
  await assert.rejects(ship(mark, ws, target, sd, PORT, never, false), /local changes or untracked files/)
  assert.equal(head(target), h0)
  execFileSync('rm', ['-f', join(target, 'stray.txt')])
  g('checkout', '-q', '-b', 'side')
  await assert.rejects(ship(mark, ws, target, sd, PORT, never, false), /not on main/)
  assert.equal(head(target), h0)
  g('checkout', '-q', 'main')
  assert.deepEqual(await ship(mark, ws, target, sd, PORT, never, false), { release: '' }) // the same call ships once the target is fine
  assert.equal(head(target), mark.sha)
})

test('ship without serving: a stop before the last point changes nothing', async () => {
  const { target, ws, mark } = await built()
  const h0 = head(target), stop = new AbortController()
  stop.abort()
  await assert.rejects(ship(mark, ws, target, sd, PORT, stop.signal, false), /stopped before the release went live/)
  assert.equal(head(target), h0)
})

test('ship with serving (the default) still refuses before any server starts', async () => {
  const old = tmp('oldprod')
  execFileSync('mkdir', ['-p', join(old, 'prod', 'data')])
  await assert.rejects(ship({ changeId: 'c', sha: 'a'.repeat(40), approvedVersion: 'v' }, tmp('ws'), gitTarget(), old, PORT), /prod layout from before #13/)
  await assert.rejects(ship({ changeId: 'c', sha: 'not-a-sha', approvedVersion: 'v' }, tmp('ws'), gitTarget(), tmp('sd'), PORT), /no valid sha/)
})

// ---- user-judge, replicate, lap definitions ----
test('user-judge refuses a program before any model call', async () => {
  program('prog-user')
  let calls = 0
  await assert.rejects(userJudge({ changeId: 'prog-user', model: async () => { calls++; return { ok: true, text: '', costUsd: 0 } }, stateDir: sd, request: 'r' }), /is a command-line program/)
  assert.equal(calls, 0)
})

test('replicate scores a program through run steps: passed counts per build', async () => {
  program('prog-rep')
  program('prog-rep-b', SCENARIOS.slice(0, 1)) // same spec, one scenario
  const rs = await replicate({ changeId: 'prog-rep', model: lap([GOOD, WRONG]), stateDir: sd, k: 2, builderModel: 'm1', score: ['prog-rep-b'] })
  assert.deepEqual(rs.map((r) => r.passed), [{ 'prog-rep': 2, 'prog-rep-b': 1 }, { 'prog-rep': 0, 'prog-rep-b': 0 }])
  assert.deepEqual(rs.map((r) => r.results['prog-rep'].map((x) => x.pass)), [[true, true], [false, false]])
  assert.ok(rs.every((r) => r.builderOk && /^[0-9a-f]{40}$/.test(r.sha)))
  assert.ok(!existsSync(join(sd, 'prod')), 'scoring a program starts no server')
})

test('replicate refuses probes for a program', async () => {
  program('prog-probe')
  const f = join(sd, 'vault', 'prog-probe', 'probes.json')
  writeFileSync(f, JSON.stringify({ decisions: [{ id: 'p', steps: [{ method: 'GET', path: '/x' }], observe: ['1:status'], options: { a: [[200]], b: [[404]] } }] }))
  await assert.rejects(replicate({ changeId: 'prog-probe', model: lap([GOOD]), stateDir: sd, k: 1, builderModel: 'm1', probesFile: f }), /probes are HTTP only/)
})

test('lap definitions: every example parses unchanged; a draft step may carry --contract and --base-path', () => {
  const names = readdirSync(join(REPO, 'examples')).filter((f) => /^lap-.*\.json$/.test(f))
  assert.ok(names.length >= 7)
  for (const f of names) assert.ok(parseLap(readFileSync(join(REPO, 'examples', f), 'utf8')).steps.length > 0, f)
  const def = parseLap(JSON.stringify({ name: 'p', steps: [{ factory: ['draft', 'p-1', '--request', 'r.md', '--base', 'repo', '--base-path', 'src', '--base-path', 'docs', '--contract', 'contract.json'] }] }))
  assert.deepEqual(def.steps[0].factory?.slice(-5), ['src', '--base-path', 'docs', '--contract', 'contract.json'])
})
