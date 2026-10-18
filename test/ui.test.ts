// #4: UI scenarios drive the app's pages in a headless browser. The browser must be as isolated as the app (loopback
// only, own sandbox), reachable by nothing a builder could touch, and its reading of the page must not be the app's to bend.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { EXE, openBrowser, UI_LIMITS, usesUi, withUi } from '../src/browser.ts'
import { classifyReply, predictInstruction } from '../src/classify.ts'
import { checkWithin, draft, RUN_CONTRACT, runContract } from '../src/roles.ts'
import { runChange } from '../src/run.ts'
import { freePort } from '../src/sandbox.ts'
import { runScenario, validateScenarios, type Scenario, type Step } from '../src/scenario.ts'
import { stopServer } from '../src/ship.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { CLASSIFICATION, freshState, gitTarget, tmp, writeApp } from './helpers.ts'

const sd = freshState()
after(() => stopServer(sd))
const never = new AbortController().signal
// Without the pinned browser, launching it fails and the servers the tests opened keep the process alive: skip instead.
const browserTest: typeof test = (name: string, fn: any) => test(name, { skip: existsSync(EXE) ? false : 'headless Chromium is not installed: npx playwright-core install --with-deps --only-shell chromium (see README)' }, fn)

// Stands in for the builder: a memo page (form + list) over the app's own JSON API, plus pages that probe the isolation.
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const MEMO_PAGE = page(`<input data-testid="titleInput"><button data-testid="addButton">Add</button>
<li data-testid="memoItem" style="display:none">template</li><ul id="list"></ul>
<script>
const list = document.getElementById('list'), input = document.querySelector('[data-testid=titleInput]')
const show = async () => { list.innerHTML = ''; for (const m of await (await fetch('/api/memos')).json()) { const li = document.createElement('li'); li.dataset.testid = 'memoItem'; li.textContent = m.title; list.append(li) } }
document.querySelector('[data-testid=addButton]').onclick = async () => {
  await new Promise((r) => setTimeout(r, 300)) // the list updates after the click returns
  await fetch('/api/memos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: input.value }) })
  input.value = ''; show()
}
show()
</script>`)
const UI_APP = (bug = false) => `
const http = require('node:http'), fs = require('node:fs')
const memos = []
const html = (r, s, b) => { r.writeHead(s, { 'content-type': 'text/html' }); r.end(b) }
const json = (r, s, b) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(b)) }
http.createServer((q, r) => {
  let raw = ''; q.on('data', (d) => raw += d); q.on('end', () => {
    const u = new URL(q.url, 'http://x')
    if (u.pathname === '/') return html(r, 200, ${JSON.stringify(MEMO_PAGE)})
    if (u.pathname === '/api/memos' && q.method === 'GET') return json(r, 200, memos)
    if (u.pathname === '/api/memos' && q.method === 'POST') { ${bug ? '' : 'memos.push({ title: JSON.parse(raw).title }); '}return json(r, 201, {}) }
    // page JS tries every way out to a host listener, then says it is done
    if (u.pathname === '/leak') return html(r, 200, '<p data-testid="state">trying</p><script>const t = "http://127.0.0.1:' + u.searchParams.get('port') + '/x";' +
      'Promise.allSettled([fetch(t), fetch(t, { mode: "no-cors" }), new Promise((ok) => { const i = new Image(); i.onload = i.onerror = ok; i.src = t + "i" }),' +
      'new Promise((ok) => { const f = document.createElement("iframe"); f.onload = ok; f.src = t + "f"; document.body.append(f); setTimeout(ok, 2000) })])' +
      '.then(() => { document.querySelector("p").textContent = "done" })</script>')
    // the app looks for the browser among the processes it can see
    if (u.pathname === '/procs') return json(r, 200, fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p)).map((p) => { try { return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8') } catch { return '' } }).filter((c) => /chrom/i.test(c)))
    // page JS bends everything a main-world reader would use
    if (u.pathname === '/liar') return html(r, 200, '<p data-testid="real">truth</p><script>Element.prototype.getAttribute = () => "real"; document.querySelectorAll = () => [];' +
      'String.prototype.trim = () => "lie"; JSON.stringify = () => "{}"; Object.defineProperty(HTMLElement.prototype, "innerText", { get: () => "lie" })</script>')
    if (u.pathname === '/many') return html(r, 200, '<ul>' + '<li data-testid="row">r</li>'.repeat(Number(u.searchParams.get('n'))) + '</ul>')
    // a tagged SVG and a web component: read like any element, in the order actions count them
    if (u.pathname === '/odd') return html(r, 200, '<svg data-testid="icon" width="10" height="10"><text y="9">s</text></svg><p data-testid="item">light</p><x-c></x-c>' +
      '<div data-testid="__proto__" style="display: contents">wrapped</div><div data-testid="hid" style="display: contents"><span hidden>h</span></div>' +
      '<script>customElements.define("x-c", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p data-testid=item>shadow</p><button data-testid=b onclick=this.textContent=1>0</button>" } })</script>')
    if (u.pathname === '/stall') return html(r, 200, '<p data-testid="x">x</p><script>for (;;) {}</script>')
    json(r, 404, {})
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
`
const app = tmp('ui')
writeApp(app, UI_APP())

const sc = (id: string, steps: Step[]): Scenario => ({ id, title: id, summary: 'a memo typed into the page shows up in its list', inSpec: true, kind: 'ui', steps })
const ui = (x: Omit<Step, 'method' | 'path' | 'expect'> & { path?: string; expect?: Step['expect'] }) => x as unknown as Step
const ADD = sc('add', [
  ui({ ui: 'goto', path: '/', expect: { status: 200, length: { memoItem: 0 } } }),
  ui({ ui: 'fill', target: 'titleInput', text: 'buy kiwis' }),
  ui({ ui: 'click', target: 'addButton', expect: { json: { memoItem: ['buy kiwis'], titleInput: [''] }, length: { memoItem: 1 } }, capture: { first: 'memoItem.0' } }),
  { method: 'GET', path: '/api/memos', expect: { status: 200, json: [{ title: '{{first}}' }] } },
])

browserTest('a ui scenario drives the page in the browser: fill, click, the list updates later, mixed with HTTP steps', async () => {
  const r = await runScenario(app, ADD, never, { ui: true })
  assert.equal(r.pass, true, r.detail)
  const bad = tmp('ui-bug')
  writeApp(bad, UI_APP(true))
  const f = await runScenario(bad, ADD, never, { ui: true })
  assert.equal(f.pass, false)
  assert.equal(f.failedStep, 3, f.detail)
})

test('no declared UI: a ui step fails instead of running', async () => {
  const r = await runScenario(app, ADD, never)
  assert.equal(r.pass, false)
  assert.match(r.detail, /step 1: the spec declares no browser UI/)
})

browserTest('the browser reaches the app and nothing else: page JS gets no connection to a host listener', async () => {
  let hits = 0
  const host = http.createServer((_q, r) => { hits++; r.end('x') }).listen(0, '127.0.0.1')
  await new Promise((ok) => host.once('listening', ok))
  try {
    const port = (host.address() as { port: number }).port
    const r = await runScenario(app, sc('leak', [ui({ ui: 'goto', path: `/leak?port=${port}`, expect: { json: { state: ['done'] } } })]), never, { ui: true })
    assert.equal(r.pass, true, r.detail)
    assert.equal(hits, 0)
  } finally { host.close() }
})

browserTest('the app cannot see the browser: they are in separate sandboxes', async () => {
  const r = await runScenario(app, sc('procs', [
    ui({ ui: 'goto', path: '/', expect: { status: 200 } }), // the browser is up from here on
    { method: 'GET', path: '/procs', expect: { status: 200, length: 0 } },
  ]), never, { ui: true })
  assert.equal(r.pass, true, r.detail)
})

// This process and its descendants (the browser's sandbox among them).
function ourPids(): string[] {
  const ppid = (p: string) => { try { return readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1] } catch { return '' } }
  const pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p))
  const ours = new Set([String(process.pid)])
  for (let grew = true; grew;) { grew = false; for (const p of pids) if (!ours.has(p) && ours.has(ppid(p))) { ours.add(p); grew = true } }
  return [...ours]
}
// Listening TCP sockets in the host network namespace held by them.
function hostListeners(): number {
  const inodes = new Set(ourPids().flatMap((p) => { try { return readdirSync(`/proc/${p}/fd`).map((f) => { try { return readlinkSync(`/proc/${p}/fd/${f}`) } catch { return '' } }) } catch { return [] } })
    .map((l) => l.match(/^socket:\[(\d+)\]$/)?.[1]).filter(Boolean))
  return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((f) => readFileSync(f, 'utf8').split('\n').slice(1))
    .map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === '0A' && inodes.has(c[9])).length
}
const chromes = () => ourPids().filter((p) => { try { return readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0')[0].endsWith('/chrome-headless-shell') } catch { return false } })
// The sandbox goes down with its bwrap (die-with-parent, pid namespace): give it a moment.
async function gone() {
  for (let i = 0; i < 30 && chromes().length; i++) await new Promise((r) => setTimeout(r, 100))
  return chromes().length === 0
}

browserTest('the browser has no port a builder could reach, none of the factory environment, and no view of the state dir', async () => {
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<p data-testid="hi">hi</p>') }).listen(0, '127.0.0.1')
  await new Promise((ok) => srv.once('listening', ok))
  process.env.FACTORY_TEST_CANARY = 'canary-4f1d'
  const before = hostListeners()
  const b = await openBrowser((srv.address() as { port: number }).port, never)
  try {
    assert.equal(await b.act({ ui: 'goto', path: '/' }, (srv.address() as { port: number }).port), 200)
    assert.deepEqual(await b.snapshot(), { hi: ['hi'] })
    assert.equal(hostListeners(), before) // the debugging channel is a pipe; the relay listens in the browser's own namespace
    const chrome = chromes()
    assert.ok(chrome.length > 0)
    for (const p of chrome) {
      assert.doesNotMatch(readFileSync(`/proc/${p}/environ`, 'utf8'), /canary-4f1d/)
      assert.ok(existsSync(`/proc/${p}/root/usr`) && !existsSync(`/proc/${p}/root${sd}`)) // its $HOME is a tmpfs: no vault
    }
  } finally { delete process.env.FACTORY_TEST_CANARY; await b.close(); srv.close() }
  assert.ok(await gone(), 'close() leaves nothing running')
})

browserTest('the page is read in an isolated world: page JS that bends DOM and builtins cannot change what the judge reads', async () => {
  const r = await runScenario(app, sc('liar', [ui({ ui: 'goto', path: '/liar', expect: { json: { real: ['truth'] }, length: { real: 1 } } })]), never, { ui: true })
  assert.equal(r.pass, true, r.detail)
})

browserTest('tagged SVG, open shadow roots, display:contents and odd ids are read as actions see them', async () => {
  const r = await runScenario(app, sc('odd', [
    ui({ ui: 'goto', path: '/odd', expect: { json: { icon: ['s'], item: ['light', 'shadow'], b: ['0'], ['__proto__']: ['wrapped'] }, length: { hid: 0 } } }),
    ui({ ui: 'click', target: 'b', expect: { json: { b: ['1'] } } }),
  ]), never, { ui: true })
  assert.equal(r.pass, true, r.detail)
})

browserTest('a page past the snapshot cap fails the step, even where a cut snapshot would have passed', async () => {
  const n = UI_LIMITS.elements
  const at = (k: number, len: number) => runScenario(app, sc('many', [ui({ ui: 'goto', path: `/many?n=${k}`, expect: { length: { row: len } } })]), never, { ui: true })
  assert.equal((await at(n, n)).pass, true)
  const over = await at(n + 1, n)
  assert.equal(over.pass, false)
  assert.match(over.detail, /more than the judge reads/)
})

browserTest('a page that hangs is bounded: the step fails, the scenario ends, an emergency stop stops it', async () => {
  const t0 = Date.now()
  const r = await runScenario(app, sc('stall', [ui({ ui: 'goto', path: '/stall', expect: { length: { x: 1 } } })]), never, { ui: true })
  assert.equal(r.pass, false)
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0}ms`)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 1500)
  await assert.rejects(runScenario(app, sc('stall-stop', [ui({ ui: 'goto', path: '/stall', expect: { length: { x: 1 } } })]), ac.signal, { ui: true }))
  assert.ok(await gone())
})

test('ui steps: the right fields per action, test ids as targets, and the summary must not carry the typed text', () => {
  const one = (st: Step, summary = 'a memo typed into the page shows up in its list') => validateScenarios([{ ...sc('v', [st]), summary }])
  assert.doesNotThrow(() => one(ADD.steps[1]))
  assert.doesNotThrow(() => one(ui({ ui: 'click', target: 'memoItem.2' })))
  assert.throws(() => one(ui({ ui: 'goto' })), /a "goto" step has a path/)
  assert.throws(() => one(ui({ ui: 'click', target: 'addButton', text: 'x' })), /a "goto" step has a path/)
  assert.throws(() => one(ui({ ui: 'click', target: 'a.b' })), /target must be/)
  assert.throws(() => one(ui({ ui: 'hover', target: 'a' } as never)), /ui must be one of/)
  assert.throws(() => one(ui({ ui: 'click', target: 'a', expect: { status: 200 } })), /only a "goto" step has a status/)
  assert.throws(() => one({ ...ADD.steps[1], method: 'GET' } as Step), /unknown field "method"/)
  assert.throws(() => one(ADD.steps[1], 'buy kiwis is listed'), /summary contains a concrete value/)
  assert.throws(() => validateScenarios([sc('h', [{ method: 'GET', path: '/' } as Step])]), /expect must be an object/) // HTTP steps still need one
})

test('the declaration lives in the spec: idempotent, the contract allows pages, the interface carries test ids', () => {
  const s = withUi('# Memos\n\n## Undecided\n- order\n')
  assert.ok(usesUi(s) && !usesUi('# Memos\n'))
  assert.equal(withUi(s), s)
  assert.match(runContract(s), /pages are HTML served by the app/)
  assert.equal(runContract('# Memos\n'), RUN_CONTRACT)
  assert.throws(() => checkWithin({ testIds: ['other'] }, { testIds: ['titleInput'] }), /outside the plan's interface: testId:other/)
  assert.doesNotThrow(() => checkWithin({ testIds: ['titleInput'] }, { testIds: ['titleInput', 'addButton'] }))
})

const IFACE = { endpoints: ['GET /', 'GET /api/memos', 'POST /api/memos'], fields: { memo: ['title'] }, testIds: ['titleInput', 'addButton', 'memoItem'] }
const pred = (status: number[] | null, body: unknown = null) => ({ status, body, basis: 'convention', quote: '' })
const drafting = (prompts: Record<string, string[]>, iface: unknown = IFACE): Model => async (t) => {
  (prompts[t.role] ??= []).push(t.instruction)
  const text = t.role === 'spec-drafter' ? JSON.stringify({ spec: '# Memo page\nAdd memos from a page.\n\n## Undecided\n- order\n', interface: iface, assumptions: [] })
    : t.role === 'scenario-drafter' ? JSON.stringify({ scenarios: [ADD] }) : JSON.stringify({ steps: ADD.steps.map(() => pred(null)) })
  return { ok: true, text, costUsd: 0 }
}

test('draft --ui: the spec drafter names test ids, the scenario writer learns ui steps from names only, the classifier the page shape', async () => {
  const prompts: Record<string, string[]> = {}
  const d = await draft(drafting(prompts), 'a memo page: type a title, add it, see it listed', { ui: true })
  assert.ok(usesUi(d.spec))
  assert.match(prompts['spec-drafter'][0], /"testIds"/)
  assert.match(prompts['scenario-drafter'][0], /"ui": "fill", "target"/)
  assert.match(prompts['scenario-drafter'][0], /"testIds":\["titleInput","addButton","memoItem"\]/)
  assert.match(prompts.classifier[0], /browser action on the app's pages/)
  const plain = await draft(drafting(prompts, { endpoints: ['GET /memos'] }), 'a memo API', {})
  assert.ok(!usesUi(plain.spec))
  assert.doesNotMatch(prompts['spec-drafter'][1], /"testIds"/)
  assert.doesNotMatch(prompts['scenario-drafter'][1], /"ui": "fill"/)
  await assert.rejects(draft(drafting(prompts, { testIds: ['memo.item'] }), 'x', { ui: true }), /testIds must be a list of bare names/)
})

test('classifier: a ui step is compared like any response: the page object, status for goto only', () => {
  const ok = classifyReply(ADD, '# s', '', { steps: [pred([200], { memoItem: [] }), pred(null), pred(null, { memoItem: ['buy kiwis'], titleInput: [''] }), pred([200], [{ title: '{{first}}' }])] })
  assert.equal(ok.label, 'readable', JSON.stringify(ok.checks))
  const open = classifyReply(ADD, '# s', '', { steps: [pred([200], { memoItem: [] }), pred(null), pred(null), pred([200], null)] })
  assert.equal(open.label, 'unstated')
  assert.doesNotMatch(predictInstruction('# s', '', { ...ADD, steps: [ADD.steps[3]] }), /browser action/)
})

browserTest('practice change end to end with a fake model: drafted with --ui, judged in the browser, retried once, shipped', async () => {
  const d = await draft(drafting({}), 'a memo page: type a title, add it, see it listed', { ui: true })
  const dir = writeDraft(sd, 'memo-ui-1', { ...d, classification: [{ ...CLASSIFICATION[0], id: 'add' }] })
  approve(sd, 'memo-ui-1', { by: 'test', version: hash(dir) })
  const seen: string[] = []
  const model: Model = async (t) => {
    if (t.role === 'builder') { seen.push(t.instruction); writeApp(t.workdir, UI_APP(seen.length === 1)); return { ok: true, text: 'built', costUsd: 0.1 } }
    return { ok: true, text: '{"pass": true, "reason": "ok"}', costUsd: 0.1 }
  }
  const r = await runChange({ changeId: 'memo-ui-1', shipTarget: gitTarget(), model, stateDir: sd, port: await freePort(), stopFile: join(sd, 'NOSTOP'), trafficBase: '/api/memos' })
  assert.equal(r.status, 'shipped', r.stopReason)
  assert.deepEqual(r.attempts.map((a) => a.testsAllPass), [false, true], JSON.stringify(r.attempts.map((a) => a.results)))
  assert.match(seen[0], /data-testid/)
  assert.match(seen[0], /pages are HTML served by the app/)
  assert.match(seen[1], /a memo typed into the page shows up in its list/) // the summary is the feedback
  for (const lit of ['buy kiwis', '"fill"', 'memoItem.0']) assert.ok(!seen.join('\n').includes(lit), `builder saw ${lit}`)
})
