// Lap 8: a scenario that sets its own "Content-Type" must send exactly one media type. A plain-object merge with
// the default sent "application/json, application/json", and an app that checks the media type answered 415.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fill, runScenario, type Scenario } from '../src/scenario.ts'
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
