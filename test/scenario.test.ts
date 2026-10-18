// Lap 8: a scenario that sets its own "Content-Type" must send exactly one media type. A plain-object merge with
// the default sent "application/json, application/json", and an app that checks the media type answered 415.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, type Scenario } from '../src/scenario.ts'
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
