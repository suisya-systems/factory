// #17: an app that calls an external service is judged against a fake of it. The fake must be reachable by the
// app (over its loopback only), and by nothing else: no builder, no other process, never with the scenario side.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { classifyReply, predictInstruction } from '../src/classify.ts'
import { FAKE_LIMITS, startFake, usesService, withService } from '../src/fake.ts'
import { draft, RUN_CONTRACT, runContract } from '../src/roles.ts'
import { runChange } from '../src/run.ts'
import { freePort } from '../src/sandbox.ts'
import { runScenario, runScenarios, validateScenarios, type Scenario, type Step } from '../src/scenario.ts'
import { stopServer } from '../src/ship.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { CLASSIFICATION, freshState, gitTarget, tmp, writeApp } from './helpers.ts'

const sd = freshState()
after(() => stopServer(sd))
const never = new AbortController().signal

// Stands in for the builder: converts an amount with the rate the service returns.
const RATES_APP = `
const http = require('node:http')
const S = process.env.SERVICE_URL
http.createServer(async (q, r) => {
  const send = (s, b) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(b)) }
  if (q.url === '/env') return send(200, { url: S ?? null })
  const m = q.url.match(/^\\/convert\\/(\\w+)\\?amount=(\\d+)$/)
  if (m) {
    try {
      const x = await fetch(S + '/rates/' + m[1], { headers: { 'x-api-key': 'k1' } })
      if (x.status !== 200) return send(502, { upstream: x.status })
      return send(200, { amount: Number(m[2]) * (await x.json()).rate })
    } catch (e) { return send(502, { error: String(e) }) }
  }
  if (q.url === '/peek') { const x = await fetch(S + '/requests'); return send(200, { status: x.status, body: await x.text() }) }
  if (q.url === '/burst') { for (let i = 0; i < ${FAKE_LIMITS.requests + 5}; i++) await fetch(S + '/ping').catch(() => {}); return send(200, {}) }
  send(404, {})
}).listen(Number(process.env.PORT), '127.0.0.1')
`
const app = tmp('rates')
writeApp(app, RATES_APP)

const setRate = (rate: number): Step => ({ service: true, method: 'POST', path: '/responses', body: { method: 'GET', path: '/rates/eur', status: 200, json: { rate } }, expect: { status: 204 } })
const sc = (id: string, steps: Step[]): Scenario => ({ id, title: id, summary: 'the converted amount follows the service', inSpec: true, kind: 'service', steps })
const CONVERT = sc('convert', [
  setRate(3),
  { method: 'GET', path: '/convert/eur?amount=5', expect: { status: 200, json: { amount: 15 } } },
  { service: true, method: 'GET', path: '/requests', expect: { status: 200, length: 1, json: [{ method: 'GET', path: '/rates/eur', headers: { 'x-api-key': 'k1' } }] } },
])

test('the app reaches the fake over its loopback: canned answer in, its own request recorded', async () => {
  const r = await runScenario(app, CONVERT, never, { service: true })
  assert.equal(r.pass, true, r.detail)
})

test('the fake has no listener: no other process (a builder shares the host network) can reach it', async () => {
  // Our own listening TCP sockets: inodes of our fds that /proc/net/tcp{,6} lists in state LISTEN (0A).
  const listening = () => {
    const ours = new Set(readdirSync('/proc/self/fd').map((f) => { try { return readlinkSync(`/proc/self/fd/${f}`) } catch { return '' } })
      .map((l) => l.match(/^socket:\[(\d+)\]$/)?.[1]).filter(Boolean))
    return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((f) => readFileSync(f, 'utf8').split('\n').slice(1))
      .map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === '0A' && ours.has(c[9])).length
  }
  const before = listening()
  const fake = startFake()
  try {
    assert.equal(fake.control('POST', '/responses', { method: 'GET', path: '/x', status: 200, json: { ok: 1 } }).status, 204)
    const c = fake.connect() // the only way in: the app's bridge hands its connections here
    let got = ''
    c.on('data', (d) => { got += d })
    c.write('GET /x HTTP/1.1\r\nHost: s\r\nConnection: close\r\n\r\n')
    await new Promise((ok) => c.on('end', ok))
    assert.match(got, /^HTTP\/1.1 200/)
    assert.equal(listening(), before)
  } finally { fake.close() }
})

test('the app cannot read the scenario side: /requests on the service is an unknown path, not the log', async () => {
  const r = await runScenario(app, sc('peek', [setRate(7), { method: 'GET', path: '/peek', expect: { status: 200, json: { status: 404 } } }]), never, { service: true })
  assert.equal(r.pass, true, r.detail)
})

test('a fresh fake per scenario: nothing set or recorded in one is seen by the next', async () => {
  const second = sc('second', [
    { method: 'GET', path: '/convert/eur?amount=5', expect: { status: 502, json: { upstream: 404 } } },
    { service: true, method: 'GET', path: '/requests', expect: { length: 1 } },
  ])
  const rs = await runScenarios(app, [CONVERT, second], never, { service: true })
  assert.deepEqual(rs.map((r) => [r.pass, r.detail]), [[true, 'ok'], [true, 'ok']])
})

test('leading service steps run before the app starts (an app may call the service at startup)', async () => {
  const boot = tmp('boot')
  writeApp(boot, `
const http = require('node:http')
fetch(process.env.SERVICE_URL + '/config').then((x) => x.status === 200 ? x.json() : { mode: 'none' }).then((cfg) =>
  http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(cfg)) }).listen(Number(process.env.PORT), '127.0.0.1'))`)
  const get = (mode: string): Step => ({ method: 'GET', path: '/', expect: { json: { mode } } })
  const set: Step = { service: true, method: 'POST', path: '/responses', body: { method: 'GET', path: '/config', status: 200, json: { mode: 'blue' } }, expect: { status: 204 } }
  assert.equal((await runScenario(boot, sc('boot', [set, get('blue')]), never, { service: true })).pass, true)
  assert.equal((await runScenario(boot, sc('boot-unset', [get('none')]), never, { service: true })).pass, true)
})

test('no declared service: no SERVICE_URL, no fake, and a service step fails', async () => {
  assert.equal((await runScenario(app, sc('env', [{ method: 'GET', path: '/env', expect: { json: { url: null } } }]), never)).pass, true)
  const r = await runScenario(app, CONVERT, never)
  assert.equal(r.pass, false)
  assert.match(r.detail, /step 1: the spec declares no external service/)
})

test('the app cannot make the factory hold unbounded data: past the fake limits the scenario fails', async () => {
  const r = await runScenario(app, sc('burst', [{ method: 'GET', path: '/burst', expect: { status: 200 } }]), never, { service: true })
  assert.equal(r.pass, false)
  assert.match(r.detail, /more than the fake keeps/)
  const fake = startFake()
  assert.equal(fake.control('POST', '/responses', { method: 'GET', path: 'no-slash', status: 200 }).status, 400)
  assert.equal(fake.control('GET', '/other', undefined).status, 404)
  fake.close()
})

test('service steps: only the two control forms, and the summary must not carry the canned data (keys included)', () => {
  const one = (st: Step, summary = 'the converted amount follows the service') => validateScenarios([{ ...sc('v', [st]), summary }])
  assert.doesNotThrow(() => one(setRate(3)))
  assert.throws(() => one({ ...setRate(3), path: '/elsewhere' }), /a service step is/)
  assert.throws(() => one({ ...setRate(3), headers: { a: 'b' } }), /a service step is/)
  assert.throws(() => one({ ...setRate(3), service: false as unknown as true }), /a service step is/)
  const keyed: Step = { ...setRate(3), body: { method: 'GET', path: '/x', status: 200, json: { 'secret-canary-key': true } } }
  assert.throws(() => one(keyed, 'secret-canary-key is passed on'), /summary contains a concrete value/)
})

test('the declaration lives in the spec: idempotent, and it lifts "no network" for SERVICE_URL only', () => {
  const s = withService('# Rates\n\n## Undecided\n- rounding\n')
  assert.ok(usesService(s) && !usesService('# Rates\n'))
  assert.equal(withService(s), s)
  assert.match(runContract(s), /no network at runtime except the external service at process\.env\.SERVICE_URL/)
  assert.equal(runContract('# Rates\n'), RUN_CONTRACT)
})

test('draft --service: the spec declares it and the scenario writer learns the service steps; a reused declared spec keeps both', async () => {
  const prompts: Record<string, string[]> = {}
  const spec = '# Rates\nconvert with the rates service\n\n## Undecided\n- rounding\n'
  const model: Model = async (t) => {
    (prompts[t.role] ??= []).push(t.instruction)
    const text = t.role === 'spec-drafter' ? JSON.stringify({ spec, interface: { endpoints: ['GET /convert/{currency}'] }, assumptions: [] })
      : t.role === 'scenario-drafter' ? JSON.stringify({ scenarios: [CONVERT] }) : JSON.stringify({ steps: CONVERT.steps.map(() => ({ status: null, body: null, basis: 'convention', quote: '' })) })
    return { ok: true, text, costUsd: 0 }
  }
  const d = await draft(model, 'convert amounts with the rates service', { service: true })
  assert.ok(usesService(d.spec))
  assert.match(prompts['scenario-drafter'][0], /"service": true/)
  assert.match(prompts.classifier[0], /control endpoint of a fake/)
  const plain = await draft(model, 'convert amounts', {})
  assert.ok(!usesService(plain.spec))
  assert.doesNotMatch(prompts['scenario-drafter'][1], /"service": true/)
  const reused = await draft(model, 'convert amounts with the rates service', { reuse: { body: d.spec.split('\n\n## Interface')[0], iface: '{}' } })
  assert.ok(usesService(reused.spec))
  assert.match(prompts['scenario-drafter'][2], /"service": true/)
})

test('classifier: setting the canned answer is setup and never counts; what the app sent does', () => {
  const pred = (status: number[] | null, body: unknown = null) => ({ status, body, basis: 'convention', quote: '' })
  const ok = classifyReply(CONVERT, '# s', '', { steps: [pred([500]), pred([200], { amount: 15 }), pred([200], [{ method: 'GET', path: '/rates/eur', headers: { 'x-api-key': 'k1' } }])] })
  assert.equal(ok.label, 'readable')
  assert.ok(ok.checks.every((c) => c.step !== 1))
  const wrong = classifyReply(CONVERT, '# s', '', { steps: [pred([204]), pred([200], { amount: 15 }), pred([200], [{ method: 'POST' }])] })
  assert.notEqual(wrong.label, 'readable')
  assert.doesNotMatch(predictInstruction('# s', '', { ...CONVERT, steps: [CONVERT.steps[1]] }), /control endpoint/)
})

test('run end to end with a fake model: judged against the fake, builder sees the contract, never the canned data', async () => {
  const dir = writeDraft(sd, 'rates-1', { spec: withService('# Rates\n- GET /convert/{currency}?amount=N\n'), scenarios: [CONVERT], assumptions: [], classification: [{ ...CLASSIFICATION[0], id: 'convert' }] })
  approve(sd, 'rates-1', { by: 'test', version: hash(dir) })
  const seen: string[] = []
  const model: Model = async (t) => {
    if (t.role === 'builder') { seen.push(t.instruction); writeApp(t.workdir, RATES_APP); return { ok: true, text: 'built', costUsd: 0.1 } }
    return { ok: true, text: '{"pass": true, "reason": "ok"}', costUsd: 0.1 }
  }
  const r = await runChange({ changeId: 'rates-1', shipTarget: gitTarget(), model, stateDir: sd, port: await freePort(), stopFile: join(sd, 'NOSTOP'), trafficBase: '/env' })
  assert.equal(r.status, 'shipped', r.stopReason)
  assert.equal(r.attempts[0].testsAllPass, true, JSON.stringify(r.attempts[0].results))
  assert.match(seen[0], /SERVICE_URL/)
  for (const lit of ['/rates/eur', '/responses', '"rate"', 'x-api-key']) assert.ok(!seen.join('\n').includes(lit), `builder saw ${lit}`)
})
