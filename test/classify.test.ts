// Lap 2: two drafters that never share the spec, and an independent readable-from-spec classification.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { main, approvalSummary } from '../src/cli.ts'
import { classify, classifyReply, predictInstruction, withoutUndecided } from '../src/classify.ts'
import { startGuard, Stop } from '../src/limits.ts'
import { draft, extractJson } from '../src/roles.ts'
import { runScenario, type Scenario } from '../src/scenario.ts'
import { vaultDir } from '../src/vault.ts'
import { freshState, gitTarget, SCENARIOS, tmp, writeApp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

const SPEC = '# Memo API\n- POST /notes creates a note and returns 201 with its id.\n- GET /notes/:id returns the note.\n\n## Undecided\n- the status code for an unknown id'
const IFACE = { endpoints: ['POST /notes', 'GET /notes/:id'], fields: { note: ['id', 'title'] } }
const createGet = SCENARIOS[0] // POST 201 {id} capture id; GET /notes/{{id}} 200 {title: 'alpha'}

// A fake model answering per role; records every task it saw.
function fake(predict: (t: Task) => unknown = () => ({ steps: [{ status: [201], body: { id: '?' }, basis: 'spec', quote: 'returns 201 with its id' }, { status: [200], body: { title: 'alpha' }, basis: 'spec', quote: 'GET /notes/:id returns the note' }] })) {
  const seen: Task[] = []
  const model: Model = async (t) => {
    seen.push(t)
    const reply = t.role === 'spec-drafter' ? { spec: SPEC, interface: IFACE, assumptions: ['no auth'] }
      : t.role === 'scenario-drafter' ? { scenarios: [createGet], assumptions: ['titles are short'] }
        : predict(t)
    return { ok: true, costUsd: 0.1, text: '```json\n' + JSON.stringify(reply) + '\n```' }
  }
  return { model, seen }
}

test('draft: spec and scenarios come from separate sessions; the scenario writer never sees the spec', async () => {
  const { model, seen } = fake()
  const d = await draft(model, 'a memo api', { app: '=== server.js\nexisting code' })
  assert.deepEqual(seen.map((t) => t.role), ['spec-drafter', 'scenario-drafter', 'classifier'])
  assert.ok(seen.every((t) => t.access === 'none'))
  const sc = seen[1].instruction
  assert.ok(!sc.includes('POST /notes creates a note'), 'scenario writer saw the spec')
  assert.match(sc, /a memo api/)
  assert.match(sc, /existing code/)
  assert.match(sc, /INTERFACE [^\n]*\n\{"endpoints":\["POST \/notes"/) // shared vocabulary
  assert.ok(!sc.includes('no auth'), 'scenario writer saw the spec writer\'s assumptions')
  assert.match(d.spec, /## Interface/) // the builder gets the same names
  assert.deepEqual(d.assumptions.slice(1), ['no auth', '(scenario writer) titles are short'])
  assert.deepEqual(seen.map((t) => t.maxCostUsd), [1, 1, 0.5])
})

test('the classifier sees requests only: no id, title, summary, kind or expectations', () => {
  const s: Scenario = { ...SCENARIOS[3], id: 'secret-id-zz', title: 'secret title zz', summary: 'secret summary zz', kind: 'secret-kind-zz',
    steps: [{ method: 'GET', path: '/notes/x', expect: { status: 418, json: { error: 'secret-expect-zz' } } }] }
  const i = predictInstruction(SPEC, '', s)
  for (const leak of ['secret-id-zz', 'secret title zz', 'secret summary zz', 'secret-kind-zz', 'secret-expect-zz', '418']) assert.ok(!i.includes(leak), leak)
  assert.match(i, /\/notes\/x/)
})

test('classifyReply: readable / basis downgrade / contradicts / unstated', () => {
  const step = (status: number[] | null, body: unknown, basis = 'spec', quote = 'returns 201 with its id') => ({ status, body, basis, quote })
  const ok = step([200], { title: 'alpha' }, 'spec', 'GET /notes/:id returns the note')
  const r = (a: object, b: object) => classifyReply(createGet, SPEC, 'const x = 1 // existing code line', { steps: [a, b] })
  assert.deepEqual([r(step([201], { id: '?' }), ok).label, r(step([201], { id: '?' }), ok).basis], ['readable', 'spec'])
  // the captured id is a marker on both sides: a predicted '{{id}}' matches the expected one
  assert.equal(r(step([201], { id: '?' }), step([200], { title: 'alpha', id: '{{id}}' }, 'spec', 'GET /notes/:id returns the note')).label, 'readable')
  // a quote that is not in the spec does not count as the spec
  assert.equal(r(step([201], { id: '?' }, 'spec', 'invented sentence not in the spec'), ok).basis, 'convention')
  assert.equal(r(step([201], { id: '?' }, 'code', 'existing code line'), ok).basis, 'code')
  // confident mismatch on a spec basis: contradicts; on convention only: unstated
  assert.equal(r(step([400], { id: '?' }), ok).label, 'contradicts')
  assert.equal(r(step([400], { id: '?' }, 'convention', ''), ok).label, 'unstated')
  // the spec leaves things open
  assert.equal(r(step(null, null), ok).label, 'unstated')
  assert.equal(r(step([201, 200], { id: '?' }), ok).label, 'unstated') // partly allowed
  assert.equal(r(step([201], {}), ok).label, 'unstated') // jsonHas id: presence not determined
  assert.equal(r(step([201], { id: '?' }), step([200], { title: '?' })).label, 'unstated')
  assert.throws(() => classifyReply(createGet, SPEC, '', { steps: [ok] }), /one entry per step/)
})

test('classifyReply: lengths inside the body, and arrays as full claims', () => {
  const s: Scenario = { id: 'page', title: 'p', summary: 'a page holds the first items', inSpec: true, kind: 'paging',
    steps: [{ method: 'GET', path: '/notes?limit=2', expect: { status: 200, length: { items: 2 }, json: { next: null } } }] }
  const q = 'GET /notes/:id returns the note'
  const r = (body: unknown) => classifyReply(s, SPEC, '', { steps: [{ status: [200], body, basis: 'spec', quote: q }] }).label
  assert.equal(r({ items: ['?', '?'], next: null }), 'readable')
  assert.equal(r({ items: ['?', '?', '?'], next: null }), 'contradicts')
  assert.equal(r({ items: '?', next: null }), 'unstated')
  assert.equal(r({ items: ['?', '?'] }), 'unstated') // next not determined
  assert.equal(r({ items: ['?', '?'], next: 'abc' }), 'contradicts')
})

test('classify: a failed or unusable reply is unknown; a stop propagates instead of becoming unknown', async () => {
  const two = [createGet, { ...createGet, id: 'b' }]
  let n = 0
  const flaky: Model = async () => (n++ === 0 ? { ok: false, text: '', costUsd: 0.1, error: 'boom' } : { ok: true, text: 'no json here', costUsd: 0.1 })
  assert.deepEqual((await classify(flaky, SPEC, '', two, extractJson)).map((c) => c.label), ['unknown', 'unknown'])
  const stopping: Model = async () => { throw new Stop('emergency stop') }
  await assert.rejects(classify(stopping, SPEC, '', two, extractJson), Stop)
})

test('guard: a call that reports no cost is charged its own ceiling, not the whole change budget', async () => {
  const g = startGuard(10, join(sd, 'NOSTOP'))
  const m = g.model(async () => ({ ok: false, text: '', costUsd: null, error: 'timed out' }))
  await m({ role: 'classifier', instruction: 'x', workdir: tmp('c'), access: 'none', maxCostUsd: 0.5, timeoutMs: 1000 })
  g.dispose()
  assert.equal(g.ledger.totalUsd, 0.5)
})

test('draft command: --base pins the app version; all roles are charged; the summary lists discrepancies', async () => {
  const base = gitTarget()
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'tags please')
  const { model } = fake(() => ({ steps: [{ status: [400], body: null, basis: 'spec', quote: 'returns 201 with its id' }, { status: null, body: null, basis: 'convention', quote: '' }] }))
  assert.equal(await main(['draft', 'tags-1', '--request', req, '--base', base], model), 0)
  const dir = vaultDir(sd, 'tags-1')
  const b = JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8'))
  assert.match(b.baseSha, /^[0-9a-f]{40}$/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'classification.json'), 'utf8'))[0].label, 'contradicts')
  const cost = JSON.parse(readFileSync(join(sd, 'runs', 'tags-1', 'draft-cost.json'), 'utf8'))
  assert.deepEqual(Object.keys(cost.byRole).sort(), ['classifier', 'scenario-drafter', 'spec-drafter'])
  const summary = readFileSync(join(dir, 'approval-summary.md'), 'utf8')
  assert.match(summary, /### \(a\) The spec says otherwise \(1\)\n- create-get: .*step 1 POST status 201/)
  assert.match(summary, /\| contradicts \| 1 \| 0 \|/)
  assert.match(summary, new RegExp(`Extends: ${b.baseSha}`))
})

test('draft command: a STOP during classification writes nothing for approval', async () => {
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'x')
  const { model } = fake(() => { writeFileSync(process.env.FACTORY_STOP_FILE!, 'x'); return { steps: [] } })
  try {
    await assert.rejects(main(['draft', 'stopped-1', '--request', req], model), Stop)
    const dir = vaultDir(sd, 'stopped-1')
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0)
    assert.ok(JSON.parse(readFileSync(join(sd, 'runs', 'stopped-1', 'draft-cost.json'), 'utf8')).totalUsd > 0)
  } finally { unlinkSync(process.env.FACTORY_STOP_FILE!) }
})

test('approval summary: (b) lists what the spec does not determine; self-report is labelled as such', () => {
  const s = approvalSummary('x', { spec: SPEC, scenarios: [createGet], assumptions: [], classification: [{ id: 'create-get', label: 'unstated', checks: [{ step: 2, check: 'json', result: 'U', basis: 'spec' }] }] }, 'v')
  assert.match(s, /### \(b\) The scenario requires what the spec does not determine \(1\)\n- create-get: .*step 2 GET json/)
  assert.match(s, /\[stated \/ unstated\] create-get/)
})

test('scenario runner: header captures, templated headers, lengths inside the body', async () => {
  const app = tmp('hdr')
  writeApp(app, `require('node:http').createServer((q, s) => {
    if (q.method === 'POST') { s.writeHead(201, {'content-type':'application/json', etag: '"v1"'}); return s.end('{"id":"1"}') }
    const ok = q.headers['if-match'] === '"v1"'
    s.writeHead(ok ? 200 : 412, {'content-type':'application/json'}); s.end(JSON.stringify({ items: [1, 2], next: null }))
  }).listen(Number(process.env.PORT), '127.0.0.1')`)
  const sc = (n: number): Scenario => ({ id: 'h', title: 'h', summary: 'a stale version is refused', inSpec: false, kind: 'conflict', steps: [
    { method: 'POST', path: '/notes', body: { title: 'a' }, expect: { status: 201 }, capture: { v: 'header:etag' } },
    { method: 'PATCH', path: '/notes/1', headers: { 'If-Match': '{{v}}' }, body: {}, expect: { status: 200, length: { items: n } } },
  ] })
  const never = new AbortController().signal
  const ok = await runScenario(app, sc(2), never)
  assert.equal(ok.pass, true, ok.detail)
  const bad = await runScenario(app, sc(3), never)
  assert.match(bad.detail, /expected length 3 at items, got 2/)
})

test('classifyReply: wrong values contradict; captured ids; quote checks; isArray and array prefixes', () => {
  const q = 'GET /notes/:id returns the note'
  const st = (status: number[] | null, body: unknown, basis = 'spec', quote = q) => ({ status, body, basis, quote })
  const first = st([201], { id: '{{id}}' }) // echoes the value this very step captures
  const r = (b: object, s = createGet, app = '') => classifyReply(s, SPEC, app, { steps: [first, b] })
  assert.equal(r(st([200], { title: 'alpha' })).label, 'readable')
  assert.equal(r(st([200], { title: 'beta' })).label, 'contradicts')
  const both: Scenario = { ...createGet, steps: [createGet.steps[0], { ...createGet.steps[1], expect: { status: 200, json: { id: '{{id}}', title: 'alpha' } } }] }
  assert.equal(r(st([200], { id: '{{id}}', title: 'alpha' }), both).label, 'readable')
  assert.equal(r(st([200], { id: 'other', title: 'alpha' }), both).label, 'unstated') // the created id was never determined: it might be 'other'
  assert.equal(r(st([200], { id: '?', title: 'beta' }), both).label, 'contradicts') // an open leaf does not hide a wrong one
  assert.equal(r(st([200], { id: '{{nope}}', title: 'alpha' }), both).label, 'unstated') // unknown name: undetermined
  // quotes: empty, or found only in the app code, never count as the spec
  assert.equal(r(st([200], { title: 'alpha' }, 'spec', '')).basis, 'convention')
  assert.equal(r(st([200], { title: 'alpha' }, 'spec', 'app.get(notes) returns the note'), createGet, 'app.get(notes) returns the note').basis, 'convention')
  const list = SCENARIOS[1] // GET /notes: isArray true, length 0
  const one = (body: unknown) => classifyReply(list, SPEC, '', { steps: [st([200], body)] }).label
  assert.deepEqual([one([]), one({}), one(['?'])], ['readable', 'contradicts', 'contradicts'])
  const prefix: Scenario = { ...list, steps: [{ ...list.steps[0], expect: { json: [{ title: 'a' }] } }] }
  assert.equal(classifyReply(prefix, SPEC, '', { steps: [st([200], [{ title: 'a' }, { title: 'b' }])] }).label, 'readable')
})

test('spec drafter: an interface with status codes or unknown keys is refused', async () => {
  for (const iface of [{ endpoints: ['POST /notes -> 201'] }, { endpoints: ['GET /notes'], rules: 'AND' }]) {
    const m: Model = async (t) => ({ ok: true, costUsd: 0, text: JSON.stringify(t.role === 'spec-drafter' ? { spec: SPEC, interface: iface, assumptions: [] } : {}) })
    await assert.rejects(draft(m, 'x'), /interface/)
  }
})

test('approval summary (b): a convention-only mismatch is listed with its step', () => {
  const s = approvalSummary('x', { spec: SPEC, scenarios: [createGet], assumptions: [], classification: [{ id: 'create-get', label: 'unstated', checks: [{ step: 1, check: 'status 201', result: 'X', basis: 'convention' }] }] }, 'v')
  assert.match(s, /\(b\)[^\n]*\(1\)\n- create-get: .*step 1 POST status 201/)
  assert.match(s, /\(a\)[^\n]*\(0\)\n- none/)
})

test('classifyReply: a predicted null inside the body is a value; captures must be established', () => {
  const q = 'GET /notes/:id returns the note'
  const one = (s: Scenario, p: object) => classifyReply(s, SPEC, '', { steps: [{ status: [200], basis: 'spec', quote: q, ...p }] }).label
  const page: Scenario = { id: 'p', title: 'p', summary: 'the last page says so', inSpec: true, kind: 'paging', steps: [{ method: 'GET', path: '/notes', expect: { status: 200, json: { next: 'abc' } } }] }
  assert.equal(one(page, { body: { next: null } }), 'contradicts')
  const etag: Scenario = { id: 'e', title: 'e', summary: 'a version is handed out', inSpec: true, kind: 'conflict', steps: [{ method: 'GET', path: '/notes', expect: { status: 200 }, capture: { v: 'header:etag' } }] }
  assert.equal(one(etag, { body: null }), 'unstated')
  assert.equal(one(etag, { body: null, headers: { etag: '?' } }), 'readable')
})

test('classifyReply: a determined captured value is kept for later steps; an undetermined one stays open', () => {
  const s: Scenario = { id: 'v', title: 'v', summary: 'the version is echoed back', inSpec: true, kind: 'conflict', steps: [
    { method: 'POST', path: '/notes', body: {}, expect: { status: 201 }, capture: { v: 'version' } },
    { method: 'GET', path: '/notes', expect: { json: { version: 1 } } }] }
  const p = (body: object) => ({ status: [201], body, basis: 'spec', quote: 'GET /notes/:id returns the note' })
  const label = (a: object, b: object) => classifyReply(s, SPEC, '', { steps: [p(a), p(b)] }).label
  assert.equal(label({ version: 1 }, { version: '{{v}}' }), 'readable')
  assert.equal(label({ version: 2 }, { version: '{{v}}' }), 'contradicts')
  assert.equal(label({ version: '?' }, { version: '{{v}}' }), 'unstated')
})

test('a rejected drafter reply gets one repair round with the error, in a fresh call; a second rejection fails', async () => {
  const leaky = { ...createGet, summary: 'alpha comes back' } // 'alpha' is a value from its steps
  const run = async (fixed: boolean) => {
    const seen: Task[] = []
    let n = 0
    const m: Model = async (t) => {
      seen.push(t)
      const reply = t.role === 'spec-drafter' ? { spec: SPEC, interface: IFACE, assumptions: [] }
        : t.role === 'scenario-drafter' ? { scenarios: [n++ === 0 || !fixed ? leaky : createGet] }
          : { steps: [{ status: null, body: null, basis: 'convention', quote: '' }, { status: null, body: null, basis: 'convention', quote: '' }] }
      return { ok: true, costUsd: 0.1, text: JSON.stringify(reply) }
    }
    return { seen, d: await draft(m, 'x').catch((e: Error) => e) }
  }
  const good = await run(true)
  assert.deepEqual(good.seen.map((t) => t.role), ['spec-drafter', 'scenario-drafter', 'scenario-drafter', 'classifier'])
  assert.match(good.seen[2].instruction, /PREVIOUS REPLY WAS REJECTED: .*concrete value .*"alpha"/)
  assert.ok(!(good.d instanceof Error) && good.d.scenarios[0].summary === createGet.summary)
  const bad = await run(false)
  assert.ok(bad.d instanceof Error && /concrete value/.test(bad.d.message))
  assert.equal(bad.seen.filter((t) => t.role === 'scenario-drafter').length, 2)
})

test('lap 3: the spec drafter must leave open points under "## Undecided"; the builder and the approver see them', async () => {
  const noUndecided: Model = async (t) => ({ ok: true, costUsd: 0, text: JSON.stringify(t.role === 'spec-drafter' ? { spec: '# Memo API\n- all rules decided', interface: IFACE, assumptions: [] } : {}) })
  await assert.rejects(draft(noUndecided, 'x'), /Undecided/)
  const { model, seen } = fake()
  const d = await draft(model, 'a memo api')
  assert.match(seen[0].instruction, /Do NOT decide behaviour/)
  const s = approvalSummary('x', { ...d, assumptions: [] }, 'v')
  assert.match(s, /## Undecided in the spec[^\n]*\n- the status code for an unknown id\n\n/) // stops before the appended interface
})

test('classifyReply: a re-captured name keeps its earlier value for "{{name}}"; each capture gets its own marker', () => {
  const q = 'GET /notes/:id returns the note'
  const p = (body: unknown, headers?: object) => ({ status: [200], body, basis: 'spec', quote: q, ...(headers ? { headers } : {}) })
  const recap: Scenario = { id: 'r', title: 'r', summary: 'the same note keeps its id', inSpec: true, kind: 'crud', steps: [
    { method: 'POST', path: '/notes', body: {}, expect: { status: 200 }, capture: { id: 'id', v: 'version' } },
    { method: 'PUT', path: '/notes/{{id}}', body: {}, expect: { json: { id: '{{id}}' } }, capture: { id: 'id', v: 'version' } },
    { method: 'GET', path: '/notes/{{id}}', expect: { json: { version: '{{v}}' } } }] }
  const label = (b3: unknown) => classifyReply(recap, SPEC, '', { steps: [p({ id: '?', version: '?' }), p({ id: '{{id}}', version: '?' }), p(b3)] }).label
  assert.equal(label({ version: '{{v}}' }), 'readable')
  assert.equal(label({ version: '?' }), 'unstated')
  // a "{{name}}" inside a predicted header is expanded before it is captured
  const hdr: Scenario = { id: 'h', title: 'h', summary: 'the version tag is echoed', inSpec: true, kind: 'conflict', steps: [
    { method: 'POST', path: '/notes', body: {}, expect: { status: 200 }, capture: { id: 'id' } },
    { method: 'GET', path: '/notes/{{id}}', expect: { status: 200 }, capture: { e: 'header:etag' } },
    { method: 'GET', path: '/notes/{{id}}', expect: { json: { tag: '{{e}}' } } }] }
  assert.equal(classifyReply(hdr, SPEC, '', { steps: [p({ id: '?' }), p(null, { etag: '{{id}}' }), p({ tag: '{{id}}' })] }).label, 'readable')
})

test('classifyReply (lap 3 review): "?" inside a captured object, header name case and type, quotes from Undecided', () => {
  const q = 'GET /notes/:id returns the note'
  const p = (body: unknown, headers?: object) => ({ status: [200], body, basis: 'spec', quote: q, ...(headers ? { headers } : {}) })
  const obj: Scenario = { id: 'o', title: 'o', summary: 'an old version is returned', inSpec: true, kind: 'history', steps: [
    { method: 'POST', path: '/notes', body: {}, expect: { status: 200 }, capture: { m: 'memo' } },
    { method: 'GET', path: '/notes', expect: { json: { memo: '{{m}}' } } }] }
  // the prediction never determined the title: open, not a contradiction
  assert.equal(classifyReply(obj, SPEC, '', { steps: [p({ memo: { title: '?' } }), p({ memo: { title: 'z' } })] }).label, 'unstated')
  assert.equal(classifyReply(obj, SPEC, '', { steps: [p({ memo: { title: '?' } }), p({ memo: '{{m}}' })] }).label, 'readable')
  const hdr: Scenario = { id: 'h', title: 'h', summary: 'the tag is echoed', inSpec: true, kind: 'conflict', steps: [
    { method: 'GET', path: '/notes', expect: { status: 200 }, capture: { e: 'header:ETag' } },
    { method: 'GET', path: '/notes', expect: { json: { tag: '{{e}}' } } }] }
  assert.equal(classifyReply(hdr, SPEC, '', { steps: [p(null, { ETag: 7 }), p({ tag: '7' })] }).label, 'readable') // any case; a header is a string
  assert.equal(classifyReply(hdr, SPEC, '', { steps: [p(null, { ETag: 7 }), p({ tag: 7 })] }).label, 'contradicts')
  // a quote from the Undecided section is not spec evidence
  assert.equal(withoutUndecided(SPEC + '\n\n## Interface\nx'), SPEC.split('## Undecided')[0] + '## Interface\nx')
  const r = classifyReply(SCENARIOS[3], SPEC, '', { steps: [{ status: [404], body: null, basis: 'spec', quote: 'the status code for an unknown id' }] })
  assert.equal(r.basis, 'convention')
})
