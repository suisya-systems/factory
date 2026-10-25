// #30: the user-agent arm. A fake model stands in for the user agent (no spend); the app is the test's memo server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { replicate } from '../src/replicate.ts'
import { checkAction, compareTable, FOCI, focusOf, mutate, userDir, userInstruction, userJudge, USER_LIMITS, validateMutants, type Mutant, type UserRecord } from '../src/user.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { buildRequest, withSession } from '../src/scenario.ts'
import { CLASSIFICATION, MEMO_SERVER, SCENARIOS, freshState, tmp, writeApp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')
const REQUEST = 'I want a small memo service: create notes and list them.\n'
const BODY = '# Memo API\n- CRUD on /notes\n- secret-spec-line-xyz\n\n## Undecided\n- ordering\n'
const IFACE = '{"endpoints":["GET /notes","POST /notes"],"fields":{"note":["id","title","body"]}}'
const SPEC = `${BODY}\n\n## Interface (names and shapes, shared with the scenario writer)\n\n\`\`\`json\n${IFACE}\n\`\`\`\n`
function change(id: string) {
  const dir = writeDraft(sd, id, { spec: SPEC, scenarios: SCENARIOS, assumptions: ['(scenario writer) hidden-assumption-abc'], classification: CLASSIFICATION,
    base: { baseSha: null, requestSha256: createHash('sha256').update(REQUEST).digest('hex') } })
  approve(sd, id, { by: 'test', version: hash(dir) })
}
const hidden = [...SCENARIOS.flatMap((s) => [s.id, s.summary]), 'secret-spec-line-xyz', 'hidden-assumption-abc', 'Undecided']

test('the instruction carries the request, the interface and its own turns only; actions are checked', () => {
  const t = userInstruction(REQUEST, IFACE, {}, [{ actions: [{ method: 'GET', path: '/notes' }], seen: [{ status: 200, body: 'x'.repeat(5000) }] }], 1)
  assert.ok(t.includes(REQUEST) && t.includes(IFACE) && t.includes('"path":"/notes"') && t.includes('this is the last one'))
  assert.match(t, /"x{1400,}\.\.\. \(cut, 5\d{3} chars\)/) // what the app sent is bounded
  assert.ok(!/x{1500}/.test(t))
  for (const h of hidden) assert.ok(!t.includes(h), `instruction carries ${h}`)
  assert.ok(!/"service": true|"ui":/.test(t), 'forms for a fake or pages the app does not declare')
  assert.match(userInstruction(REQUEST, IFACE, { service: true, ui: true }, [], 6), /"service": true[\s\S]*"ui": "goto"[\s\S]*6 turn\(s\) left\.\n/)
  assert.ok(!t.includes('FOCUS'))
  assert.deepEqual([1, 2, 3, 4, 5].map(focusOf), ['main', 'input', 'state', 'failure', 'main']) // each session of a build leans elsewhere
  assert.ok(userInstruction(REQUEST, IFACE, {}, [], 6, 'input').includes(`FOCUS OF THIS TRY: ${FOCI.input}.`))
  assert.equal(checkAction({ method: 'POST', path: '/notes', body: { title: 'a' } }), null)
  assert.equal(checkAction({ service: true, method: 'GET', path: '/requests' }), null)
  assert.equal(checkAction({ ui: 'fill', target: 'title.0', text: 'a' }), null)
  for (const bad of [null, { method: 'FOO', path: '/' }, { method: 'GET', path: 'x' }, { method: 'GET', path: '/', body: {} }, { method: 'GET', path: '/', headers: { a: 1 } },
    { service: true, method: 'GET', path: '/other' }, { ui: 'hover', target: 'a' }, { ui: 'goto', target: 'a' }, { ui: 'click', target: 'a', text: 'b' }])
    assert.ok(checkAction(bad), `accepted ${JSON.stringify(bad)}`)
})

test('the comparison sets each session beside the verdict that counted, per model, and lists disagreements', () => {
  change('cmp-a')
  const run = join(sd, 'runs', 'cmp-a')
  const res = (fail: string[]) => SCENARIOS.map((s) => ({ id: s.id, inSpec: s.inSpec, kind: s.kind, pass: !fail.includes(s.id), detail: '' }))
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'run.json'), JSON.stringify({ status: 'shipped', attempts: [
    { n: 1, sha: 'a'.repeat(40), results: res(['missing-404']), llmPass: true, pass: false },
    { n: 2, sha: 'b'.repeat(40), results: res([]), llmPass: true, pass: true }] }))
  assert.match(compareTable(sd, 'cmp-a'), /No user sessions yet/)
  mkdirSync(userDir(sd, 'cmp-a'))
  const rec = (build: string, session: number, model: string, v: boolean | null, status: UserRecord['status'] = 'done') => writeFileSync(join(userDir(sd, 'cmp-a'), `${build}--${model}--s${session}.json`),
    JSON.stringify({ build, session, model, status, verdict: v === null ? null : { satisfied: v, reason: `reason ${build} ${session}`, problems: v ? [] : ['lists nothing'] }, costUsd: 0.5 }))
  rec('attempt-1', 1, 'm1', true); rec('attempt-1', 2, 'm1', false)
  rec('attempt-2', 1, 'm1', false); rec('attempt-2', 2, 'm1', null, 'running')
  rec('attempt-2', 1, 'm2', true)
  const t = compareTable(sd, 'cmp-a')
  assert.match(t, /\| attempt-1 \| aaaaaaa \| 3\/4 \| pass \| fail \| yes, no \| no \| 1\.0000 \|/)
  assert.match(t, /\| attempt-2 \| bbbbbbb \| 4\/4 \| pass \| pass \| no, interrupted \| no \| 1\.0000 \|/)
  assert.match(t, /## m1, no focus \(before #50\)[\s\S]*Sessions: both pass 0, both fail 1, user only fails 1, current only fails 1, no verdict 1\. Builds whose sessions disagree with each other: 1\./)
  assert.match(t, /- attempt-1 s1 \(user yes, current fail\): reason attempt-1 1\n {2}- failed scenarios: missing-404/)
  assert.match(t, /- attempt-2 s1 \(user no, current pass\): reason attempt-2 1\n {2}- lists nothing/)
  assert.deepEqual(buildRequest({ method: 'POST', path: '/a/{{x}}', body: { t: 'Hi {{name}}' } }, null), buildRequest({ method: 'POST', path: '/a/{{x}}', body: { t: 'Hi {{name}}' } }, { x: '{{x}}', name: '{{name}}' })) // a user action is sent literally
  assert.match(t, /## m2[\s\S]*\| attempt-2 \| bbbbbbb \| 4\/4 \| pass \| pass \| yes \| yes \|[\s\S]*both pass 1,/)
})

// #50: seeded defects. Checked and applied by hand-written rules; the table counts the sessions that said no.
const M201: Mutant = { id: 'create-200', build: 'm1-1', file: 'server.js', find: 'return send(res, 201, note)', replace: 'return send(res, 200, note)', defect: 'create answers 200 | not 201' }
test('a mutant changes exactly one place of one file inside the build; the table counts who said no to it', () => {
  assert.deepEqual(validateMutants([M201]), [M201])
  for (const bad of [{}, [{ ...M201, id: 'bad id' }], [M201, M201], [{ ...M201, find: '' }], [{ ...M201, replace: M201.find }], [{ ...M201, defect: ' ' }],
    [{ ...M201, file: '../x.js' }], [{ ...M201, file: '/etc/passwd' }], [{ ...M201, file: 'a//b' }], [{ ...M201, replace: 1 }]])
    assert.throws(() => validateMutants(bad), /mutants/, JSON.stringify(bad))
  const app = tmp('mutant')
  writeFileSync(join(app, 'server.js'), 'a\nreturn send(res, 201, note)\nb $&\n')
  mutate(app, { ...M201, replace: 'x $& y' })
  assert.equal(readFileSync(join(app, 'server.js'), 'utf8'), 'a\nx $& y\nb $&\n') // replaced literally
  assert.throws(() => mutate(app, M201), /occurs 0 times/)
  writeFileSync(join(app, 'twice.js'), 'q q')
  assert.throws(() => mutate(app, { ...M201, file: 'twice.js', find: 'q' }), /occurs 2 times/)
  const outside = tmp('outside')
  writeFileSync(join(outside, 'o.js'), M201.find)
  symlinkSync(join(outside, 'o.js'), join(app, 'link.js'))
  assert.throws(() => mutate(app, { ...M201, file: 'link.js' }), /not a file of build/)
  assert.equal(readFileSync(join(outside, 'o.js'), 'utf8'), M201.find)

  change('cmp-m')
  const res = (fail: string[]) => SCENARIOS.map((x) => ({ id: x.id, inSpec: x.inSpec, kind: x.kind, pass: !fail.includes(x.id), detail: '' }))
  const reps = join(sd, 'runs', 'cmp-m', 'replicates')
  mkdirSync(reps, { recursive: true })
  writeFileSync(join(reps, 'm1-1.json'), JSON.stringify({ sha: 'c'.repeat(40), results: { 'cmp-m': res([]) } }))
  mkdirSync(join(userDir(sd, 'cmp-m'), 'mutants'), { recursive: true })
  writeFileSync(join(userDir(sd, 'cmp-m'), 'mutants', 'create-200.json'), JSON.stringify({ mutant: M201, sha: 'c'.repeat(40), results: res(['create-get', 'update-title']) }))
  assert.match(compareTable(sd, 'cmp-m'), /\| create-200 \| m1-1 \| create answers 200 \\\| not 201 \| 2\/4 \(failed: create-get, update-title\) \|\n\nNo user sessions yet/) // the free check (--sessions 0) shows its scores
  const rec = (name: string, r: Partial<UserRecord>) => writeFileSync(join(userDir(sd, 'cmp-m'), `${name}.json`), JSON.stringify({ build: 'm1-1', model: 'm1', status: 'done', costUsd: 0.5, ...r }))
  const v = (satisfied: boolean) => ({ satisfied, reason: satisfied ? 'fine' : 'create says 200', problems: satisfied ? [] : ['POST /notes answered 200'] })
  rec('base-1', { session: 1, focus: 'main', verdict: v(true) })
  rec('base-2', { session: 2, focus: 'input', verdict: v(true) })
  rec('mut-1', { session: 1, focus: 'main', mutant: 'create-200', verdict: v(true) })
  rec('mut-2', { session: 2, focus: 'input', mutant: 'create-200', verdict: v(false) })
  const t = compareTable(sd, 'cmp-m')
  assert.match(t, /\| m1-1 \| ccccccc \| 4\/4 \| - \| pass \| yes \(main\), yes \(input\) \| yes \| 1\.0000 \|/) // the mutant's sessions are not the base build's
  assert.match(t, /Sessions: both pass 2, /)
  assert.match(t, /\| create-200 \| m1-1 \| create answers 200 \\\| not 201 \| 2\/4 \(failed: create-get, update-title\) \| yes \(main\), no \(input\) \| 1\/2 \| 1\.0000 \|/)
  assert.match(t, /Mutants: 1, caught by at least one session: 1\. Sessions with a verdict: 2, said no \(caught\): 1, satisfied \(missed\): 1\. Caught per focus: main 0\/1, input 1\/1\./)
  assert.match(t, /- create-200 s2 \(user no \(input\)\): create says 200\n {2}- POST \/notes answered 200/)
})

test('user-judge also drives each mutant (scored by the scenarios first, never told it is one), and refuses a bad or changed mutant before any call', async () => {
  change('uj-m')
  const builder: Model = async (t) => { writeApp(t.workdir, MEMO_SERVER); return { ok: true, text: 'built', costUsd: 0.25 } }
  await replicate({ changeId: 'uj-m', model: builder, stateDir: sd, k: 1, builderModel: 'm1' })
  // Satisfied only if creating a note answers 201.
  const seen: Task[] = []
  const strict: Model = async (t) => {
    seen.push(t)
    const text = /^TURN 1$/m.test(t.instruction) ? JSON.stringify({ verdict: { satisfied: t.instruction.includes('"status":201'), reason: 'checked create', problems: [] } })
      : JSON.stringify({ actions: [{ method: 'POST', path: '/notes', body: { title: 'a', body: 'b' } }] })
    return { ok: true, text, costUsd: 0.1 }
  }
  const outside = join(tmp('mutants'), 'm.json'), inVault = join(sd, 'vault', 'uj-m-mutants.json')
  writeFileSync(outside, JSON.stringify([M201]))
  await assert.rejects(userJudge({ changeId: 'uj-m', model: strict, stateDir: sd, request: REQUEST, mutantsFile: outside }), /--mutants must be under/)
  writeFileSync(inVault, JSON.stringify([{ ...M201, build: 'm1-9' }]))
  await assert.rejects(userJudge({ changeId: 'uj-m', model: strict, stateDir: sd, request: REQUEST, mutantsFile: inVault }), /has no build m1-9/)
  writeFileSync(inVault, JSON.stringify([{ ...M201, find: 'not in the server' }]))
  await assert.rejects(userJudge({ changeId: 'uj-m', model: strict, stateDir: sd, request: REQUEST, mutantsFile: inVault }), /occurs 0 times/)
  assert.equal(seen.length, 0)

  writeFileSync(inVault, JSON.stringify([M201]))
  const table = await userJudge({ changeId: 'uj-m', model: strict, stateDir: sd, request: REQUEST, mutantsFile: inVault })
  assert.equal(seen.length, 4) // the build and its mutant, 2 calls each
  for (const t of seen) assert.ok(!/create-200|create answers|mutant/i.test(t.instruction), 'the user agent is told it uses a mutant')
  const score = JSON.parse(readFileSync(join(userDir(sd, 'uj-m'), 'mutants', 'create-200.json'), 'utf8'))
  assert.deepEqual(score.results.filter((r: { pass: boolean }) => !r.pass).map((r: { id: string }) => r.id), ['create-get', 'update-title'])
  const m: UserRecord = JSON.parse(readFileSync(join(userDir(sd, 'uj-m'), 'm1-1~create-200--claude-opus-5-5--main-s1.json'), 'utf8'))
  assert.deepEqual([m.build, m.mutant, m.focus, m.verdict?.satisfied], ['m1-1', 'create-200', 'main', false])
  assert.match(table, /\| m1-1 \| \w{7} \| 4\/4 \| - \| pass \| yes \(main\) \| yes \|/)
  assert.match(table, /\| create-200 \| m1-1 \| [^|]+\\\| not 201 \| 2\/4 \(failed: create-get, update-title\) \| no \(main\) \| 1\/1 \|/)
  // the app the base build's session used was not mutated: the build's own record is satisfied, and its tree is untouched
  assert.equal(execFileSync('git', ['-C', join(sd, 'work', 'uj-m-rep', 'm1-1'), 'status', '--porcelain']).toString(), '')

  // A mutant changed under the same id would mix two defects in one row: refused before any call.
  writeFileSync(inVault, JSON.stringify([{ ...M201, defect: 'another' }]))
  await assert.rejects(userJudge({ changeId: 'uj-m', model: strict, stateDir: sd, request: REQUEST, mutantsFile: inVault, sessions: 2 }), /changed since it was scored/)
  assert.equal(seen.length, 4)
})

// A user agent that creates a note and lists it (plus one malformed action), then is satisfied. Records what it was told.
function user(seen: Task[], o: { cost?: number; never?: boolean } = {}): Model {
  return async (t) => {
    seen.push(t)
    const turn = (t.instruction.match(/^TURN \d+$/gm) ?? []).length
    const text = !o.never && turn >= 1 ? JSON.stringify({ verdict: { satisfied: true, reason: 'notes are kept', problems: [] } })
      : JSON.stringify({ actions: [{ method: 'POST', path: '/notes', body: { title: 'shopping', body: 'milk' } }, { method: 'GET', path: '/notes' }, { method: 'FOO', path: '/notes' }] })
    return { ok: true, text, costUsd: o.cost ?? 0.1 }
  }
}

test('user-judge drives each replicate build in one sandboxed session, records it once, and leaves the replicates alone', async () => {
  change('uj-a')
  let n = 0
  const builder: Model = async (t) => { writeApp(t.workdir, ++n === 1 ? MEMO_SERVER : MEMO_SERVER.replace('[...notes.values()]', '[]').replace('return send(res, 201, note)', 'return send(res, 200, note)')); return { ok: true, text: 'built', costUsd: 0.25 } }
  await replicate({ changeId: 'uj-a', model: builder, stateDir: sd, k: 2, builderModel: 'm1' })
  const reps = join(sd, 'runs', 'uj-a', 'replicates'), repsBefore = readdirSync(reps).map((f) => readFileSync(join(reps, f), 'utf8'))

  await assert.rejects(userJudge({ changeId: 'uj-a', model: user([]), stateDir: sd, request: 'another request' }), /not the request uj-a was drafted from/)
  const seen: Task[] = []
  const table = await userJudge({ changeId: 'uj-a', model: user(seen), stateDir: sd, request: REQUEST })
  assert.equal(seen.length, 4) // 2 builds x (actions, verdict)
  for (const t of seen) {
    assert.equal(t.role, 'user-agent')
    assert.equal(t.access, 'none')
    assert.deepEqual(readdirSync(t.workdir), [])
    for (const h of hidden) assert.ok(!t.instruction.includes(h), `instruction carries ${h}`)
    assert.ok(t.instruction.includes(`FOCUS OF THIS TRY: ${FOCI.main}.`))
  }
  const recs: UserRecord[] = readdirSync(userDir(sd, 'uj-a')).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(userDir(sd, 'uj-a'), f), 'utf8')))
  assert.deepEqual(recs.map((r) => [r.build, r.session, r.model, r.status, r.verdict?.satisfied, r.costUsd, r.focus]), [['m1-1', 1, 'claude-opus-5-5', 'done', true, 0.2, 'main'], ['m1-2', 1, 'claude-opus-5-5', 'done', true, 0.2, 'main']])
  const [created, listed, bad] = recs[0].turns[0].seen
  assert.equal(created.status, 201)
  assert.equal(created.headers?.['content-type'], 'application/json')
  assert.equal(JSON.parse(created.body!).title, 'shopping')
  assert.match(listed.body!, /shopping/) // one app for the whole session: the note is still there
  assert.match(recs[1].turns[0].seen[1].body!, /^\[\]$/) // the second build lists nothing (and answers create with 200)
  assert.match(bad.error!, /^not sent: needs a method/)
  assert.ok(seen[1].instruction.includes('"title":"shopping"'), 'the second turn sees what the first got back')
  assert.match(table, /## claude-opus-5-5\n[\s\S]*\| m1-1 \| \w{7} \| 4\/4 \| - \| pass \| yes \(main\) \| yes \|/)
  assert.match(table, /\| m1-2 \| \w{7} \| 2\/4 \| - \| fail \| yes \(main\) \| no \|[\s\S]*- m1-2 s1 \(user yes \(main\), current fail\)/)
  assert.equal(readFileSync(join(userDir(sd, 'uj-a'), 'compare.md'), 'utf8'), table)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'uj-a', 'user-judge-cost.json'), 'utf8')).byRole['user-agent'].toFixed(4), '0.4000')

  // One user-judge per change at a time.
  writeFileSync(join(userDir(sd, 'uj-a'), '.lock'), '1\n')
  await assert.rejects(userJudge({ changeId: 'uj-a', model: user([]), stateDir: sd, request: REQUEST }), /another user-judge holds/)
  unlinkSync(join(userDir(sd, 'uj-a'), '.lock'))

  // Again: every claimed session is skipped (no call); --sessions 2 adds one per build; the replicates are untouched.
  const again: Task[] = []
  await userJudge({ changeId: 'uj-a', model: user(again), stateDir: sd, request: REQUEST })
  assert.equal(again.length, 0)
  await userJudge({ changeId: 'uj-a', model: user(again), stateDir: sd, request: REQUEST, sessions: 2 })
  assert.equal(again.length, 4)
  assert.ok(existsSync(join(userDir(sd, 'uj-a'), 'm1-2--claude-opus-5-5--input-s2.json')))
  assert.ok(again.every((t) => t.instruction.includes(`FOCUS OF THIS TRY: ${FOCI.input}.`)))
  assert.deepEqual(readdirSync(reps).map((f) => readFileSync(join(reps, f), 'utf8')), repsBefore)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'uj-a', 'user-judge-cost.json'), 'utf8')).byRole['user-agent'].toFixed(4), '0.8000') // summed over commands

  // A user agent that never gives a verdict uses up its turns; the cap of the arm stops the next session.
  const endless: Task[] = []
  await assert.rejects(userJudge({ changeId: 'uj-a', model: user(endless, { never: true, cost: 0.4 }), stateDir: sd, request: REQUEST, sessions: 3, maxCostUsd: 3.2 }), /cost cap/)
  assert.equal(endless.length, USER_LIMITS.turns) // the next session is stopped before its first call
  const s3 = (b: string): UserRecord => JSON.parse(readFileSync(join(userDir(sd, 'uj-a'), `${b}--claude-opus-5-5--state-s3.json`), 'utf8'))
  assert.deepEqual([s3('m1-1').status, s3('m1-1').verdict, s3('m1-1').error, s3('m1-1').turns.length], ['done', null, `no verdict within ${USER_LIMITS.turns} turns`, USER_LIMITS.turns - 1])
  assert.deepEqual([s3('m1-2').status, s3('m1-2').turns.length], ['stopped', 0])
  assert.match(s3('m1-2').error, /cost cap/)
  assert.match(readFileSync(join(userDir(sd, 'uj-a'), 'compare.md'), 'utf8'), /\| m1-2 \|[^\n]*\| yes \(main\), yes \(input\), stopped \(state\) \|/) // rewritten after the stop too
})

test('a session starts the app at its first app action, so service answers set before it reach an app that reads them at startup', async () => {
  const boot = tmp('user-boot')
  writeApp(boot, `
const http = require('node:http')
fetch(process.env.SERVICE_URL + '/config').then((x) => x.status === 200 ? x.json() : { mode: 'none' }).then((cfg) =>
  http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(cfg)) }).listen(Number(process.env.PORT), '127.0.0.1'))`)
  const never = new AbortController().signal
  const seen = await withSession(boot, never, { service: true }, async (act) => [
    await act({ service: true, method: 'POST', path: '/responses', body: { method: 'GET', path: '/config', status: 200, json: { mode: 'blue' } } }),
    await act({ method: 'GET', path: '/' }),
    await act({ service: true, method: 'GET', path: '/requests' }),
  ], () => [])
  assert.deepEqual(seen.map((x) => x.status), [204, 200, 200])
  assert.equal(JSON.parse(seen[1].body!).mode, 'blue')
  assert.match(seen[2].body!, /"path":"\/config"/)
  // past the fake's limits every later result says so
  writeApp(boot, `require('node:http').createServer(async (q, r) => { for (let i = 0; i < 120; i++) await fetch(process.env.SERVICE_URL + '/x').catch(() => {}); r.end('{}') }).listen(Number(process.env.PORT), '127.0.0.1')`)
  const over = await withSession(boot, never, { service: true }, async (act) => [await act({ method: 'GET', path: '/' }), await act({ service: true, method: 'GET', path: '/requests' })], () => [])
  assert.match(over[1].error!, /more than the fake keeps/)
  // an app that never comes up: the session ends with why, not with an action error
  writeApp(boot, 'process.exit(3)')
  assert.match(await withSession(boot, never, {}, async (act) => { await act({ method: 'GET', path: '/' }); return 'went on' }, (why) => why), /^app did not start/)
})
