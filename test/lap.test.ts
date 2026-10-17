// One lap, one command: runs to a gate, stops, resumes after approval without redoing steps; failures stay failures.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { main } from '../src/cli.ts'
import { parseLap } from '../src/lap.ts'
import { freePort } from '../src/sandbox.ts'
import { stopServer } from '../src/ship.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { freshState, MEMO_SERVER, REPO, SCENARIOS, writeApp } from './helpers.ts'

const homes: string[] = []
after(() => homes.forEach(stopServer))
const home = () => { const sd = freshState(); homes.push(sd); return sd }
const scratch = () => mkdtempSync(join(REPO, '.worker-scratch', 'lap-'))
const count = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').length : 0)
const mark = (f: string) => [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], 'x')", f]
// Captures the factory's one-line stop message.
async function lapOut(argv: string[], m: Model): Promise<{ code: number; out: string }> {
  const log = console.log, lines: string[] = []
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try { return { code: await main(['lap', ...argv], m), out: lines.join('\n') } } finally { console.log = log }
}

test('a lap runs to its gate, resumes after approval without redoing steps, and asks again when the definition changes', async () => {
  const sd = home(), dir = scratch(), port = await freePort()
  // Another state dir holding an approved set, as lap 6 brought settle-a1 over from lap 5.
  const other = mkdtempSync(join(REPO, '.worker-scratch', 'other-'))
  approve(other, 'src-a1', { by: 't', version: hash(writeDraft(other, 'src-a1', { spec: '# Memo\n', scenarios: SCENARIOS, assumptions: [] })) })
  const req = join(dir, 'req.md'), prereg = join(dir, 'prereg.json'), m1 = join(dir, 'm1'), m2 = join(dir, 'm2'), file = join(dir, 'lap.json')
  writeFileSync(req, 'a memo api')
  const calls: string[] = []
  const model: Model = async (t) => {
    calls.push(t.role)
    if (t.role === 'spec-drafter') return { ok: true, text: JSON.stringify({ spec: '# Memo\n\n## Undecided\n- status codes\n', interface: { endpoints: ['POST /notes'] }, assumptions: [] }), costUsd: 0.1 }
    if (t.role === 'scenario-drafter') return { ok: true, text: JSON.stringify({ scenarios: SCENARIOS, assumptions: [] }), costUsd: 0.1 }
    if (t.role === 'classifier') return { ok: false, text: '', costUsd: 0.01, error: 'down' }
    if (t.role === 'builder') { writeApp(t.workdir, t.workdir.endsWith('lap-1-b') ? MEMO_SERVER.replace("if (req.method === 'PUT')", 'if (false)') : MEMO_SERVER); return { ok: true, text: 'built', costUsd: 0.2 } }
    return { ok: true, text: '{"pass": true, "reason": "fine"}', costUsd: 0.05 }
  }
  const steps = [
    { exec: mark(m1) },
    { copy: 'src-a1', from: other },
    { factory: ['draft', 'lap-1', '--request', req] },
    { gate: 'entrance', approve: ['lap-1'], fix: { 'prereg/prereg.json': prereg } },
    { copy: 'lap-1', to: ['lap-1-b'] },
    { factory: ['run', 'lap-1', '--port', String(port), '--traffic-base', '/notes'], newShipTarget: '# memo\n' },
    { factory: ['run', 'lap-1-b', '--port', String(port), '--max-attempts', '1'], newShipTarget: '# memo\n' }, // retry cap: a result, not a failure
    { exec: mark(m2), always: true },
  ]
  writeFileSync(file, JSON.stringify({ name: 'lapt', steps }))

  let r = await lapOut([file], model)
  assert.equal(r.code, 3)
  assert.match(r.out, /waiting at gate "entrance" for .*prereg\.json \(the creator writes them\); then resume with: npm run factory -- lap /)
  assert.equal(count(m1), 1)
  assert.ok(existsSync(join(sd, 'vault', 'src-a1', 'approval.json')))
  assert.ok(existsSync(join(sd, 'vault', 'lap-1', 'approval-summary.md')))

  writeFileSync(prereg, '{"minority": []}')
  r = await lapOut([file], model)
  assert.equal(r.code, 3)
  assert.equal(r.out.split('\n').length, 1) // one line: what to read, how to resume
  const summary = r.out.match(/Read (\S+); after approving, resume with: npm run factory -- lap \S+$/)![1]
  const text = readFileSync(summary, 'utf8')
  const version = text.match(/^Version: (\w+)$/m)![1]
  assert.match(text, /lap-1: .*approval-summary\.md \(version \w+\)/)
  assert.match(text, /prereg\.json <- .* \(sha256 \w+\)/)
  const drafted = calls.length
  assert.equal(count(m1), 1) // finished steps are skipped
  assert.equal(calls.filter((c) => c === 'spec-drafter').length, 1)

  assert.equal(await main(['lap', file, '--approve', 'entrance', '--by', 'owner'], model), 2) // --version is required
  await assert.rejects(main(['lap', file, '--approve', 'entrance', '--by', 'owner', '--version', 'x'], model), /not the version you reviewed/)
  await assert.rejects(main(['lap', file, '--approve', 'nope', '--by', 'owner', '--version', version], model), /no gate "nope"/)
  assert.ok(!existsSync(join(sd, 'vault', 'lap-1', 'approval.json')))
  assert.equal(await main(['lap', file, '--approve', 'entrance', '--by', 'owner', '--version', version], model), 0)
  assert.equal(JSON.parse(readFileSync(join(sd, 'vault', 'lap-1', 'approval.json'), 'utf8')).by, 'owner')
  assert.equal(statSync(join(sd, 'prereg', 'prereg.json')).mode & 0o777, 0o444)
  assert.equal(calls.length, drafted) // approving runs nothing

  r = await lapOut([file], model)
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'lap-1', 'run.json'), 'utf8')).status, 'shipped')
  assert.match(JSON.parse(readFileSync(join(sd, 'runs', 'lap-1-b', 'run.json'), 'utf8')).stopReason, /^retry cap reached/)
  assert.ok(existsSync(join(sd, 'ship', 'lap-1-b', 'README.md')))
  assert.deepEqual([count(m1), count(m2)], [1, 1])
  const ran = calls.length
  const fixed = join(sd, 'prereg', 'prereg.json'), keep = readFileSync(fixed)
  chmodSync(fixed, 0o644); writeFileSync(fixed, 'tampered')
  const err = console.error, errs: string[] = []
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')) }
  try { assert.equal(await main(['lap', file], model), 1) } finally { console.error = err } // a failure (the report steps would still run), not a crash
  assert.match(errs.join('\n'), /gate "entrance"\) failed: fixed file .*prereg\.json changed after approval/)
  writeFileSync(fixed, keep); chmodSync(fixed, 0o444)

  assert.equal((await lapOut([file], model)).code, 0) // nothing left to do
  assert.equal(calls.length, ran)
  writeFileSync(file, JSON.stringify({ name: 'lapt', steps: [...steps, { exec: mark(join(dir, 'm3')) }] })) // a changed plan after approval
  r = await lapOut([file], model)
  assert.equal(r.code, 3)
  assert.match(readFileSync(summary, 'utf8'), /earlier approval of this gate no longer matches/)
  assert.equal(calls.length, ran)
  writeFileSync(prereg, '{"minority": ["changed"]}') // the pre-registration cannot change once fixed
  const v2 = readFileSync(summary, 'utf8').match(/^Version: (\w+)$/m)![1]
  await assert.rejects(main(['lap', file, '--approve', 'entrance', '--by', 'owner', '--version', v2], model), /not the version you reviewed/)
  const v3 = (await lapOut([file], model), readFileSync(summary, 'utf8').match(/^Version: (\w+)$/m)![1])
  await assert.rejects(main(['lap', file, '--approve', 'entrance', '--by', 'owner', '--version', v3], model), /already fixed with other content/)
})

test('a failed step stops the lap and is never re-run; always-steps still report; the STOP file and a used state dir refuse', async () => {
  const sd = home(), dir = scratch()
  const req = join(dir, 'req.md'), rep = join(dir, 'rep'), after1 = join(dir, 'after'), file = join(dir, 'lap.json')
  writeFileSync(req, 'a memo api')
  let calls = 0
  const model: Model = async () => { calls++; return { ok: true, text: 'sorry', costUsd: 0.5 } }
  writeFileSync(file, JSON.stringify({ name: 'lapf', steps: [{ factory: ['draft', 'f-1', '--request', req] }, { exec: mark(after1) }, { gate: 'g', approve: ['f-1'] }, { exec: mark(rep), always: true }] }))
  assert.equal(await main(['lap', file], model), 1)
  assert.equal(calls, 2) // the drafter and its one repair
  assert.deepEqual([count(after1), count(rep)], [0, 1])
  assert.equal(await main(['lap', file], model), 1)
  assert.equal(calls, 2) // not retried
  assert.equal(count(rep), 1)
  const prog = JSON.parse(readFileSync(join(sd, 'laps', 'lapf', 'progress.json'), 'utf8'))
  assert.match(Object.values(prog.steps as Record<string, { reason: string }>)[0].reason, /no parseable JSON/)

  // A step the lap was in the middle of when it ended counts as failed, never re-run.
  const file2 = join(dir, 'lap2.json'), step = { factory: ['draft', 'f-2', '--request', req] }
  writeFileSync(file2, JSON.stringify({ name: 'lapi', steps: [step] }))
  mkdirSync(join(sd, 'laps', 'lapi'), { recursive: true })
  writeFileSync(join(sd, 'laps', 'lapi', 'progress.json'), JSON.stringify({ steps: { [JSON.stringify(step)]: { status: 'running', at: '' } }, waiting: null }))
  assert.equal(await main(['lap', file2], model), 1)
  assert.equal(calls, 2)

  // A new lap in a state dir that already spent money is refused.
  writeFileSync(file2, JSON.stringify({ name: 'lapn', steps: [step] }))
  await assert.rejects(main(['lap', file2], model), /not a fresh state dir/)

  const stop = join(sd, 'STOP')
  writeFileSync(stop, 'x')
  const rep2 = join(dir, 'rep2')
  writeFileSync(file, JSON.stringify({ name: 'lapf', steps: [...JSON.parse(readFileSync(file, 'utf8')).steps, { exec: mark(rep2), always: true }] }))
  try {
    assert.equal(await main(['lap', file], model), 1)
    assert.deepEqual([count(rep), count(rep2), calls], [1, 1, 2]) // the report still runs under STOP; nothing else does
    assert.equal(await main(['lap', file, '--approve', 'g', '--by', 'o', '--version', 'v'], model), 1)
  } finally { unlinkSync(stop) }
})

test('a definition home sets the state dir; another FACTORY_HOME is refused', async () => {
  const dir = scratch(), file = join(dir, 'lap.json')
  writeFileSync(file, JSON.stringify({ name: 'laph', home: join(dir, 'state'), steps: [{ exec: mark(join(dir, 'm')) }] }))
  await assert.rejects(main(['lap', file]), /FACTORY_HOME is .* but the lap's home is/)
  const prev = process.env.FACTORY_HOME
  delete process.env.FACTORY_HOME
  try {
    assert.equal(await main(['lap', file]), 0)
    assert.ok(existsSync(join(dir, 'state', 'laps', 'laph', 'progress.json')))
    writeFileSync(join(dir, 'state', 'STOP'), 'x') // e.g. pressed during the last step: the lap is not reported done
    assert.equal(await main(['lap', file]), 1)
  } finally { process.env.FACTORY_HOME = prev }
})

// Lap 5 as a definition (the lap 6 one is examples/lap-6.json): both runbooks' procedures fit the format.
const LAP5 = {
  name: 'lap5', home: '.factory-lap5',
  steps: [
    { exec: ['npm', 'test'] },
    { factory: ['probe-isolation', 'lap5-probe-opus', '--model', 'builder=claude-opus-5-5'] },
    { factory: ['probe-isolation', 'lap5-probe-sonnet', '--model', 'builder=claude-sonnet-5-5'] },
    { factory: ['draft', 'settle-a1', '--request', 'requests/split-settle.md'] },
    { gate: 'spec', approve: ['settle-a1'], read: ['docs/lap-5/settle-c1-spec.md'] },
    { factory: ['draft', 'settle-a2', '--request', 'requests/split-settle.md', '--spec-from', 'settle-a1'] },
    { factory: ['draft', 'settle-b1', '--request', 'requests/split-settle.md', '--spec-from', 'settle-a1', '--model', 'scenario-drafter=claude-sonnet-5-5'] },
    { factory: ['draft', 'settle-b2', '--request', 'requests/split-settle.md', '--spec-from', 'settle-a1', '--model', 'scenario-drafter=claude-sonnet-5-5'] },
    { factory: ['draft', 'settle-c1', '--request', 'requests/split-settle-ablated.md', '--spec-from', 'settle-a1', '--spec', 'docs/lap-5/settle-c1-spec.md'] },
    { gate: 'entrance', approve: ['settle-a2', 'settle-b1', 'settle-b2', 'settle-c1'],
      fix: { 'vault/settle-a1/probes.json': 'docs/lap-5/probes.json', 'vault/settle-c1/probes.json': 'docs/lap-5/probes.json', 'prereg/prereg.json': 'docs/lap-5/prereg.json' } },
    ...['claude-opus-5-5', 'claude-sonnet-5-5'].map((b) => ({ factory: ['replicate', 'settle-a1', '--k', '8', '--model', `builder=${b}`, '--score', 'settle-a2,settle-b1,settle-b2', '--probes', '{state}/vault/settle-a1/probes.json', '--max-cost', '20'] })),
    ...['claude-opus-5-5', 'claude-sonnet-5-5'].map((b) => ({ factory: ['replicate', 'settle-c1', '--k', '8', '--model', `builder=${b}`, '--probes', '{state}/vault/settle-c1/probes.json', '--max-cost', '20'] })),
    { factory: ['tally', 'settle-a1'], always: true },
    { factory: ['tally', 'settle-c1'], always: true },
  ],
}

test('lap 5 and lap 6 are expressible; malformed definitions are refused before anything runs', () => {
  const lap6 = parseLap(readFileSync(join(REPO, 'examples', 'lap-6.json'), 'utf8'))
  assert.deepEqual(lap6.steps.filter((s) => s.factory?.[0] === 'run').map((s) => s.factory![1]), ['minor-1', 'minor-2', 'minor-1-b', 'minor-2-b', 'minor-1-c', 'minor-2-c'])
  parseLap(JSON.stringify(LAP5))
  const bad = (steps: unknown[], re: RegExp) => assert.throws(() => parseLap(JSON.stringify({ name: 'x', steps })), re)
  bad([{ factory: ['approve', 'a', '--by', 'me', '--version', 'v'] }], /not a lap step/)
  bad([{ factory: ['lap', 'other.json'] }], /not a lap step/)
  bad([{ exec: 'npm test' }], /argv array/)
  bad([{ factory: ['draft', 'a'], always: true }], /always goes with/)
  bad([{ factory: ['draft', 'a'], newShipTarget: '#' }], /newShipTarget/)
  bad([{ gate: 'g' }, { gate: 'g', approve: ['a'] }], /appears twice/)
  bad([{ exec: ['true'] }, { exec: ['true'] }], /same step appears twice/)
  bad([{ gate: 'g', fix: { '../x': 'f' } }], /inside the state dir/)
  bad([{ gate: 'g', fix: { 'laps/x/gates/g.json': 'f' } }], /inside the state dir/)
  bad([{ copy: 'a', from: 'x', to: ['b'] }], /exactly one of from, to/)
  bad([{ exec: ['true'], gate: 'g' }], /exactly one of/)
})
