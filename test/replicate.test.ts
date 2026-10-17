// Lap 5: K independent builds of one approved spec, scored by scenarios and probes; nothing ships.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { main } from '../src/cli.ts'
import { replicate, tally } from '../src/replicate.ts'
import { runChange } from '../src/run.ts'
import { approve, hash, vaultDir, writeDraft } from '../src/vault.ts'
import { approvedChange, MEMO_SERVER, SCENARIOS, freshState, gitTarget, writeApp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

// create-status: 201 or 200 on create. ghost: needs a capture the app never returns -> blocked.
const PROBES = { decisions: [
  { id: 'create-status', steps: [{ method: 'POST', path: '/notes', body: { title: 't', body: 'b' } }], observe: ['1:status'], options: { 'created-201': [[201]], 'ok-200': [[200]] } },
  { id: 'title-kept', steps: [{ method: 'POST', path: '/notes', body: { title: 't', body: 'b' }, capture: { id: 'id' } }, { method: 'GET', path: '/notes/{{id}}' }],
    observe: ['2:body.title'], options: { kept: [['t']], dropped: [[null]] } },
  // the second capture of g finds nothing: the first value must not be reused
  { id: 'ghost', steps: [{ method: 'POST', path: '/notes', body: {}, capture: { g: 'id' } }, { method: 'POST', path: '/notes', body: {}, capture: { g: 'ghost' } }, { method: 'GET', path: '/notes/{{g}}' }], observe: ['3:status'], options: { a: [[200]], b: [[404]] } },
  // unordered lists, extra keys and captured values: the order the app lists notes in does not matter
  { id: 'listed', steps: [{ method: 'POST', path: '/notes', body: { title: 'x', body: 'b' }, capture: { x: 'id' } }, { method: 'POST', path: '/notes', body: { title: 'y', body: 'b' } }, { method: 'GET', path: '/notes' }],
    observe: ['3:body'], options: { both: [[[{ title: 'y' }, { id: '{{x}}', title: 'x' }]]], one: [[[{ title: 'x' }]]] } },
  // two observations: an answer that only matches with the two swapped is not that answer
  { id: 'swap', steps: [{ method: 'POST', path: '/notes', body: { title: 't', body: 'b' } }, { method: 'GET', path: '/notes/nope' }], observe: ['1:status', '2:status'],
    options: { swapped: [[404, 201]], 'in-order': [[201, 404]] } },
] }
const probesFile = (id: string) => { const f = join(vaultDir(sd, id), 'probes.json'); writeFileSync(f, JSON.stringify(PROBES)); return f }

// Build n answers create with 201 on odd builds and 200 on even ones; records what each builder saw.
function builder(seen: { files: string[]; task: Task }[], cost = 0.25): Model {
  let n = 0
  return async (t) => {
    seen.push({ files: readdirSync(t.workdir), task: t })
    writeApp(t.workdir, ++n % 2 ? MEMO_SERVER : MEMO_SERVER.replace('return send(res, 201, note)', 'return send(res, 200, note)'))
    return { ok: true, text: 'built', costUsd: cost, model: n === 1 ? 'mx' : undefined, costByModel: n === 1 ? { mx: cost } : undefined }
  }
}

test('K builds from empty repos, scored by this change, a same-spec change and the probes; tally counts answers', async () => {
  approvedChange(sd, 'rep-a')
  approvedChange(sd, 'rep-b', SCENARIOS.slice(0, 2)) // same spec, other scenarios
  const seen: { files: string[]; task: Task }[] = []
  const rs = await replicate({ changeId: 'rep-a', model: builder(seen), stateDir: sd, k: 2, builderModel: 'm1', requestedModels: { builder: 'm1' }, score: ['rep-b'], probesFile: probesFile('rep-a') })
  assert.equal(rs.length, 2)
  assert.deepEqual(seen.map((s) => s.files), [['.git'], ['.git']]) // nothing to read: no earlier answer, no other build
  for (const s of seen) {
    assert.equal(s.task.role, 'builder')
    assert.match(s.task.instruction, /Memo API/)
    for (const sc of SCENARIOS) assert.ok(!s.task.instruction.includes(sc.summary), 'scenario text reached the builder')
    assert.ok(!s.task.instruction.includes('created-201'), 'probe text reached the builder')
  }
  assert.deepEqual(rs.map((r) => r.probes.map((p) => p.answer)), [['created-201', 'kept', 'blocked', 'both', 'in-order'], ['ok-200', 'kept', 'blocked', 'both', 'other']])
  assert.match(rs[0].probes[2].detail!, /step 3: variable g was never captured/)
  assert.deepEqual(rs.map((r) => r.passed), [{ 'rep-a': 4, 'rep-b': 2 }, { 'rep-a': 2, 'rep-b': 1 }]) // 200 on create fails the 201 checks
  assert.ok(rs.every((r) => r.probesSha256 && r.costUsd === 0.25 && r.requestedModels.builder === 'm1'))
  assert.deepEqual(rs.map((r) => [r.answeredBy, r.costByModel]), [['mx', { mx: 0.25 }], [null, null]])
  // a second command adds builds, numbered on
  const more = await replicate({ changeId: 'rep-a', model: builder([]), stateDir: sd, k: 1, builderModel: 'm2', probesFile: probesFile('rep-a') })
  assert.equal(more[0].n, 1)
  assert.deepEqual(readdirSync(join(sd, 'runs', 'rep-a', 'replicates')).sort(), ['m1-1.json', 'm1-2.json', 'm2-1.json'])
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'rep-a', 'replicate-cost.json'), 'utf8')).totalUsd, 0.75)
  const t = tally(sd, 'rep-a')
  assert.match(t, /\| builder model \| created-201 \| ok-200 \|/)
  assert.match(t, /\| m1 \| 2 \| 0 \| mx; \(unreported\) \|/)
  assert.match(t, /\| m1 \| 1 \| 1 \|/)
  assert.match(t, /\| m2 \| 1 \| 0 \|/)
  assert.match(t, /- m1-1: blocked step 3/)
  assert.match(t, /\| rep-b \| 2 \| 2, 1 \| - \|/) // m2 was not scored on rep-b
  // rescore re-runs the kept commits without a model call
  const again = await replicate({ changeId: 'rep-a', model: async () => { throw new Error('model called') }, stateDir: sd, k: 0, builderModel: 'm1', rescore: true })
  assert.equal(again.length, 3)
  assert.ok(again.every((r) => r.probes.length === 0 && r.probesSha256 === null && r.rescoredAt))
  const stop = join(sd, 'STOP-rescore')
  writeFileSync(stop, 'x')
  await assert.rejects(replicate({ changeId: 'rep-a', model: builder([]), stateDir: sd, k: 0, builderModel: 'm1', rescore: true, stopFile: stop }), /emergency stop/)
})

test('refused before any model call: other spec, probes outside the vault, a change that ran; run refuses after replicate', async () => {
  approvedChange(sd, 'rep-c')
  const dir = writeDraft(sd, 'rep-other', { spec: '# Other\n', scenarios: SCENARIOS, assumptions: [] })
  approve(sd, 'rep-other', { by: 't', version: hash(dir) })
  const never: Model = async () => { throw new Error('model called') }
  const o = { changeId: 'rep-c', model: never, stateDir: sd, k: 1, builderModel: 'm1' }
  await assert.rejects(replicate({ ...o, score: ['rep-other'] }), /not the spec of rep-c/)
  const outside = join(sd, 'probes.json')
  writeFileSync(outside, JSON.stringify(PROBES))
  await assert.rejects(replicate({ ...o, probesFile: outside }), /must be under/)
  symlinkSync(outside, join(vaultDir(sd, 'rep-c'), 'link.json'))
  await assert.rejects(replicate({ ...o, probesFile: join(vaultDir(sd, 'rep-c'), 'link.json') }), /must be under/)
  writeFileSync(join(vaultDir(sd, 'rep-c'), 'bad.json'), JSON.stringify({ decisions: [{ id: 'x', steps: [{ method: 'GET', path: '/' }], observe: ['2:status'], options: { a: [[1]], b: [[2]] } }] }))
  await assert.rejects(replicate({ ...o, probesFile: join(vaultDir(sd, 'rep-c'), 'bad.json') }), /bad observe/)

  await replicate({ ...o, model: builder([]) })
  await assert.rejects(runChange({ changeId: 'rep-c', shipTarget: gitTarget(), model: never, stateDir: sd, port: 1 }), /has replicates/)
  approvedChange(sd, 'rep-ran')
  mkdirSync(join(sd, 'runs', 'rep-ran'), { recursive: true })
  writeFileSync(join(sd, 'runs', 'rep-ran', 'run.json'), '{}')
  await assert.rejects(replicate({ ...o, changeId: 'rep-ran' }), /already ran/)
})

test('the change cap counts drafts and earlier replicates; the spend of a stopped build is kept', async () => {
  approvedChange(sd, 'rep-cap')
  mkdirSync(join(sd, 'runs', 'rep-cap'), { recursive: true })
  writeFileSync(join(sd, 'runs', 'rep-cap', 'draft-cost.json'), JSON.stringify({ totalUsd: 0.5 }))
  const o = { changeId: 'rep-cap', stateDir: sd, k: 3, builderModel: 'm1', maxCostUsd: 1.5 }
  await assert.rejects(replicate({ ...o, model: builder([], 0.6) }), /cost cap exceeded/)
  assert.equal(readdirSync(join(sd, 'runs', 'rep-cap', 'replicates')).length, 1) // the second build went over the cap
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'rep-cap', 'replicate-cost.json'), 'utf8')).totalUsd, 1.2)
  let calls = 0
  await assert.rejects(replicate({ ...o, model: async () => { calls++; return { ok: true, text: '', costUsd: 0 } } }), /cost cap reached/)
  assert.equal(calls, 0)
})

test('CLI: --model reaches the role it names, is recorded, and is refused for other roles, models and commands', async () => {
  approvedChange(sd, 'rep-cli')
  const tasks: Task[] = []
  const m: Model = async (t) => { tasks.push(t); writeApp(t.workdir, MEMO_SERVER); return { ok: true, text: '', costUsd: 0.1 } }
  assert.equal(await main(['replicate', 'rep-cli', '--k', '1', '--model', 'builder=claude-sonnet-5-5'], m), 0)
  assert.equal(tasks[0].model, 'claude-sonnet-5-5')
  const r = JSON.parse(readFileSync(join(sd, 'runs', 'rep-cli', 'replicates', 'claude-sonnet-5-5-1.json'), 'utf8'))
  assert.deepEqual(r.requestedModels, { builder: 'claude-sonnet-5-5' })
  assert.equal(await main(['replicate', 'rep-cli', '--k', '1', '--model', 'judge=claude-opus-5-5'], m), 0)
  assert.equal(tasks[1].model, undefined) // only the named role is overridden
  for (const argv of [['replicate', 'rep-cli', '--k', '1', '--model', 'drafter=claude-sonnet-5-5'], ['replicate', 'rep-cli', '--k', '1', '--model', 'builder=gpt'], ['approve', 'x', '--by', 'o', '--version', 'v', '--model', 'builder=claude-sonnet-5-5']]) {
    assert.equal(await main(argv, m), 2, argv.join(' '))
  }
  assert.equal(tasks.length, 2)
})

test('draft --spec-from reuses the approved spec byte for byte; --spec swaps the body and keeps the interface', async () => {
  const req = join(sd, 'req.md'), other = join(sd, 'req2.md'), ctl = join(sd, 'control.md')
  writeFileSync(req, 'a memo api'); writeFileSync(other, 'a memo api, shorter')
  writeFileSync(ctl, '# Control\n\n## Undecided\n- everything\n')
  const roles: string[] = []
  const m: Model = async (t) => {
    roles.push(t.role)
    if (t.role === 'spec-drafter') return { ok: true, text: JSON.stringify({ spec: '# Memo\n\n## Undecided\n- status codes\n', interface: { endpoints: ['POST /notes'] }, assumptions: [] }), costUsd: 0.1 }
    if (t.role === 'scenario-drafter') return { ok: true, text: JSON.stringify({ scenarios: SCENARIOS, assumptions: [] }), costUsd: 0.1 }
    return { ok: false, text: '', costUsd: 0.1, error: 'classifier down' }
  }
  const draftOk = async (argv: string[]) => {
    assert.equal(await main(['draft', ...argv], m), 0)
    const dir = vaultDir(sd, argv[0])
    approve(sd, argv[0], { by: 't', version: hash(dir) })
    return readFileSync(join(dir, 'spec.md'), 'utf8')
  }
  const a1 = await draftOk(['sf-a1', '--request', req])
  roles.length = 0
  assert.equal(await draftOk(['sf-a2', '--request', req, '--spec-from', 'sf-a1', '--model', 'scenario-drafter=claude-sonnet-5-5']), a1)
  assert.ok(!roles.includes('spec-drafter'))
  const c1 = await draftOk(['sf-c1', '--request', other, '--spec-from', 'sf-a1', '--spec', ctl])
  assert.ok(c1.startsWith('# Control'))
  assert.equal(c1.slice(c1.indexOf('## Interface')), a1.slice(a1.indexOf('## Interface')))
  assert.deepEqual(JSON.parse(readFileSync(join(sd, 'runs', 'sf-a2', 'draft-cost.json'), 'utf8')).requestedModels, { 'scenario-drafter': 'claude-sonnet-5-5' })
  roles.length = 0
  await assert.rejects(main(['draft', 'sf-x', '--request', other, '--spec-from', 'sf-a1'], m), /another request/)
  writeFileSync(ctl, '# Control without the section\n')
  await assert.rejects(main(['draft', 'sf-y', '--request', other, '--spec-from', 'sf-a1', '--spec', ctl], m), /Undecided/)
  await assert.rejects(main(['draft', 'sf-z', '--request', req, '--spec', ctl], m), /needs --spec-from/)
  const ext = writeDraft(sd, 'sf-ext', { spec: '# Ext\n', scenarios: SCENARIOS, assumptions: [], base: { baseSha: 'a'.repeat(40), requestSha256: null } })
  approve(sd, 'sf-ext', { by: 't', version: hash(ext) })
  await assert.rejects(main(['draft', 'sf-w', '--request', req, '--spec-from', 'sf-ext'], m), /extends an app/)
  assert.deepEqual(roles, [])
})

test('probe matching: same length, any order, each actual item used once, extra keys allowed', async () => {
  const { unordered } = await import('../src/scenario.ts')
  const t = (f: string, a: number) => ({ from: f, amount: a })
  assert.ok(unordered([t('b', 33), t('c', 34)], [{ ...t('c', 34), id: 1 }, t('b', 33)]))
  assert.ok(!unordered([t('b', 33), t('b', 33)], [t('b', 33), t('c', 33)])) // one actual item cannot match twice
  assert.ok(!unordered([t('b', 33)], [t('b', 33), t('c', 1)])) // an extra transfer is a different answer
  assert.ok(!unordered([t('b', 33)], [{ from: 'b' }]))
})
