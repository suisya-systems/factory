// Lap 8: a scenario that sets its own "Content-Type" must send exactly one media type. A plain-object merge with
// the default sent "application/json, application/json", and an app that checks the media type answered 415.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStep, fill, runScenario, validateScenarios, type Scenario } from '../src/scenario.ts'
import { tmp, writeApp } from './helpers.ts'

const STRICT_APP = `
const http = require('node:http')
http.createServer((q, r) => {
  let b = ''
  q.on('data', (c) => (b += c)).on('end', () => {
    const ok = q.headers['content-type'] === 'application/json'
    r.writeHead(ok ? 201 : 415, { 'content-type': 'application/json' })
    r.end(JSON.stringify({ seen: q.headers['content-type'] ?? null }))
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
`

test('a scenario\'s own Content-Type replaces the default (any case), never joins it', async () => {
  const app = tmp('ctype')
  writeApp(app, STRICT_APP)
  for (const headers of [undefined, { 'Content-Type': 'application/json' }, { 'content-type': 'application/json' }]) {
    const sc: Scenario = { id: 'c', title: 't', summary: 's', inSpec: true, kind: 'k', steps: [{ method: 'POST', path: '/x', body: { a: 1 }, ...(headers ? { headers } : {}), expect: { status: 201 } }] }
    const r = await runScenario(app, sc, new AbortController().signal)
    assert.equal(r.pass, true, `${JSON.stringify(headers)}: ${r.detail}`)
  }
})

// Lap 9: a body or expectation keyed by captured ids ({"shares": {"{{a}}": 1}}) sent and matched the key unfilled,
// so every build failed those scenarios.
const ECHO_APP = `
const http = require('node:http')
http.createServer((q, r) => {
  let b = ''
  q.on('data', (c) => (b += c)).on('end', () => {
    r.writeHead(q.method === 'GET' ? 200 : 201, { 'content-type': 'application/json' })
    r.end(q.method === 'GET' ? JSON.stringify({ id: 'm1' }) : b)
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
`

test('captured values fill object keys as well as values', async () => {
  assert.deepEqual(fill({ shares: { '{{a}}': 1, 'x-{{a}}': '{{a}}' } }, { a: 'm1' }), { shares: { m1: 1, 'x-m1': 'm1' } })
  assert.throws(() => fill({ '{{b}}': 1 }, {}), /variable b was never captured/)
  const app = tmp('keys')
  writeApp(app, ECHO_APP)
  const sc: Scenario = { id: 'k', title: 't', summary: 's', inSpec: true, kind: 'k', steps: [
    { method: 'GET', path: '/m', expect: { status: 200 }, capture: { a: 'id' } },
    { method: 'POST', path: '/x', body: { owed: { '{{a}}': 2 } }, expect: { status: 201, json: { owed: { m1: 2 } } } },
    { method: 'POST', path: '/x', body: { owed: { m1: 3 } }, expect: { status: 201, json: { owed: { '{{a}}': 3 } } } },
  ] }
  const r = await runScenario(app, sc, new AbortController().signal)
  assert.equal(r.pass, true, r.detail)
})

test('expect.jsonAbsent: fails when the path exists (any value, null included), passes when it does not', () => {
  const step = (jsonAbsent: string[]) => ({ method: 'GET' as const, path: '/x', expect: { jsonAbsent } })
  assert.equal(checkStep(step(['a']), 200, { b: 1 }, {}), null)
  assert.equal(checkStep(step(['a.b']), 200, { a: {} }, {}), null)
  assert.match(checkStep(step(['a']), 200, { a: null }, {})!, /response has a, expected it absent/)
  assert.match(checkStep(step(['x', 'a.b']), 200, { a: { b: 0 } }, {})!, /response has a\.b/)
  // the envelope of a run step: a file not written is not there, one written is (a dotted name too)
  assert.equal(checkStep(step(['files.out/plan.json']), 0, { files: {} }, {}), null)
  assert.match(checkStep(step(['files.out/plan.json']), 0, { files: { 'out/plan.json': { n: 1 } } }, {})!, /expected it absent/)
  assert.match(checkStep(step(['files.missing.json']), 0, { files: { 'missing.json': '' } }, {})!, /expected it absent/)
  // a path naming a captured file is looked up as captured, not as the placeholder
  assert.match(checkStep(step(['files.{{f}}']), 0, { files: { 'a.json': 1 } }, { f: 'a.json' })!, /response has files\.a\.json/)
  assert.equal(checkStep(step(['files.{{f}}']), 0, { files: { 'a.json': 1 } }, { f: 'b.json' }), null)
})

test('expect.jsonAbsent is validated: a non-empty list of strings; in a run step a files.* path must be in "read"', () => {
  const sc = (st: object) => [{ id: 's', title: 't', summary: 'one line', inSpec: true, kind: 'k', steps: [st] }]
  const get = { method: 'GET', path: '/x' }
  assert.doesNotThrow(() => validateScenarios(sc({ ...get, expect: { jsonAbsent: ['a'] } })))
  for (const bad of [[], 'a', [1], [null]]) assert.throws(() => validateScenarios(sc({ ...get, expect: { jsonAbsent: bad } })), /bad expect\.jsonAbsent/)
  const run = (read: string[] | undefined, p: string) => sc({ run: ['go'], ...(read ? { read } : {}), expect: { status: 0, jsonAbsent: [p] } })
  assert.doesNotThrow(() => validateScenarios(run(['out/plan.json'], 'files.out/plan.json')))
  assert.doesNotThrow(() => validateScenarios(run(['out/plan.json'], 'files.out/plan.json.n')))
  assert.doesNotThrow(() => validateScenarios(run(undefined, 'stdout.warning')))
  assert.throws(() => validateScenarios(run(['other.json'], 'files.out/plan.json')), /not in "read"/)
  assert.throws(() => validateScenarios(run(undefined, 'files.out/plan.json')), /not in "read"/)
})
