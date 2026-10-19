// #38: the approval summary shows each step's request as the runner builds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalSummary, requestLines } from '../src/cli.ts'
import { buildRequest, type Scenario } from '../src/scenario.ts'

const sc = (steps: Scenario['steps'], id = 's'): Scenario => ({ id, title: 't', summary: 'x', inSpec: true, kind: 'k', steps })
const ex = { expect: { status: 200 } }

test('substituted path, headers and body keys; captured values show as <name>', () => {
  const l = requestLines(sc([
    { method: 'POST', path: '/notes', body: { title: 'a', tags: [{ k: 1 }] }, capture: { id: 'id' }, ...ex },
    { method: 'PUT', path: '/notes/{{id}}', body: { '{{id}}': 1 }, headers: { 'X-Mode': 'fast', Authorization: 'Bearer sekrit', 'X-Api-Key': 'k1' }, ...ex },
  ])).join('\n')
  assert.match(l, /1\. POST \/notes\n  headers: content-type: application\/json\n  body: \{.*\} \(keys: title, tags, k\)/)
  assert.match(l, /2\. PUT \/notes\/<id>/)
  assert.match(l, /x-mode: fast/)
  assert.match(l, /authorization: <hidden>/)
  assert.match(l, /x-api-key: <hidden>/)
  assert.doesNotMatch(l, /sekrit|k1/)
  assert.match(l, /keys: <id>/)
})

test('same code path as the runner; long body truncated; uncaptured variable reported', () => {
  const st = { method: 'POST', path: '/a', body: { big: 'z'.repeat(2000) }, headers: { 'Content-Type': 'text/plain' } }
  assert.equal(buildRequest(st, {}).headers.get('content-type'), 'text/plain')
  assert.match(requestLines(sc([{ ...st, ...ex }])).join('\n'), /text\/plain[\s\S]*truncated, \d+ chars/)
  assert.match(requestLines(sc([{ method: 'GET', path: '/n/{{nope}}', ...ex }])).join('\n'), /cannot build: variable nope was never captured/)
})

test('approval summary carries the section', () => {
  const s = approvalSummary('x', { spec: '# S', scenarios: [sc([{ method: 'GET', path: '/n', ...ex }], 'one')], assumptions: [] }, 'v')
  assert.match(s, /## Requests as the factory will send them[\s\S]*### one\n```\n1\. GET \/n/)
})
