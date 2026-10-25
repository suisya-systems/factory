// #30: the user-agent arm. A fake model stands in for the user agent (no spend); the app is the test's memo server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { replicate } from '../src/replicate.ts'
import { checkAction, compareTable, userDir, userInstruction, userJudge, USER_LIMITS, type UserRecord } from '../src/user.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { withSession } from '../src/scenario.ts'
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
  assert.match(t, /## m1[\s\S]*Sessions: both pass 0, both fail 1, user only fails 1, current only fails 1, no verdict 1\. Builds whose sessions disagree with each other: 1\./)
  assert.match(t, /- attempt-1 s1 \(user yes, current fail\): reason attempt-1 1\n {2}- failed scenarios: missing-404/)
  assert.match(t, /- attempt-2 s1 \(user no, current pass\): reason attempt-2 1\n {2}- lists nothing/)
  assert.match(t, /## m2[\s\S]*\| attempt-2 \| bbbbbbb \| 4\/4 \| pass \| pass \| yes \| yes \|[\s\S]*both pass 1,/)
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
  }
  const recs: UserRecord[] = readdirSync(userDir(sd, 'uj-a')).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(userDir(sd, 'uj-a'), f), 'utf8')))
  assert.deepEqual(recs.map((r) => [r.build, r.session, r.model, r.status, r.verdict?.satisfied, r.costUsd]), [['m1-1', 1, 'claude-opus-5-5', 'done', true, 0.2], ['m1-2', 1, 'claude-opus-5-5', 'done', true, 0.2]])
  const [created, listed, bad] = recs[0].turns[0].seen
  assert.equal(created.status, 201)
  assert.equal(created.headers?.['content-type'], 'application/json')
  assert.equal(JSON.parse(created.body!).title, 'shopping')
  assert.match(listed.body!, /shopping/) // one app for the whole session: the note is still there
  assert.match(recs[1].turns[0].seen[1].body!, /^\[\]$/) // the second build lists nothing (and answers create with 200)
  assert.match(bad.error!, /^not sent: needs a method/)
  assert.ok(seen[1].instruction.includes('"title":"shopping"'), 'the second turn sees what the first got back')
  assert.match(table, /\| m1-1 \| \w{7} \| 4\/4 \| - \| pass \| yes \| yes \|/)
  assert.match(table, /\| m1-2 \| \w{7} \| 2\/4 \| - \| fail \| yes \| no \|[\s\S]*- m1-2 s1 \(user yes, current fail\)/)
  assert.equal(readFileSync(join(userDir(sd, 'uj-a'), 'compare.md'), 'utf8'), table)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'uj-a', 'user-judge-cost.json'), 'utf8')).byRole['user-agent'].toFixed(4), '0.4000')

  // Again: every claimed session is skipped (no call); --sessions 2 adds one per build; the replicates are untouched.
  const again: Task[] = []
  await userJudge({ changeId: 'uj-a', model: user(again), stateDir: sd, request: REQUEST })
  assert.equal(again.length, 0)
  await userJudge({ changeId: 'uj-a', model: user(again), stateDir: sd, request: REQUEST, sessions: 2 })
  assert.equal(again.length, 4)
  assert.ok(existsSync(join(userDir(sd, 'uj-a'), 'm1-2--claude-opus-5-5--s2.json')))
  assert.deepEqual(readdirSync(reps).map((f) => readFileSync(join(reps, f), 'utf8')), repsBefore)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'uj-a', 'user-judge-cost.json'), 'utf8')).byRole['user-agent'].toFixed(4), '0.8000') // summed over commands

  // A user agent that never gives a verdict uses up its turns; the cap of the arm stops the next session.
  const endless: Task[] = []
  await assert.rejects(userJudge({ changeId: 'uj-a', model: user(endless, { never: true, cost: 0.4 }), stateDir: sd, request: REQUEST, sessions: 3, maxCostUsd: 3.2 }), /cost cap/)
  assert.equal(endless.length, USER_LIMITS.turns) // the next session is stopped before its first call
  const s3 = (b: string): UserRecord => JSON.parse(readFileSync(join(userDir(sd, 'uj-a'), `${b}--claude-opus-5-5--s3.json`), 'utf8'))
  assert.deepEqual([s3('m1-1').status, s3('m1-1').verdict, s3('m1-1').error, s3('m1-1').turns.length], ['done', null, `no verdict within ${USER_LIMITS.turns} turns`, USER_LIMITS.turns - 1])
  assert.deepEqual([s3('m1-2').status, s3('m1-2').turns.length], ['stopped', 0])
  assert.match(s3('m1-2').error, /cost cap/)
  assert.match(readFileSync(join(userDir(sd, 'uj-a'), 'compare.md'), 'utf8'), /\| m1-2 \|[^\n]*\| yes, yes, stopped \|/) // rewritten after the stop too
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
  // an app that never comes up: the session ends with why, not with an action error
  writeApp(boot, 'process.exit(3)')
  assert.match(await withSession(boot, never, {}, async (act) => { await act({ method: 'GET', path: '/' }); return 'went on' }, (why) => why), /^app did not start/)
})
