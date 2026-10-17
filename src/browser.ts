// factory#4: a headless browser for UI scenario steps. Chromium runs in its OWN sandbox (sandbox.ts: own network
// namespace with loopback only, $HOME and /tmp hidden, own pid namespace), never in the app's: the app can neither see
// nor signal it. Playwright (in the factory process) drives it over --remote-debugging-pipe (fds 3/4 through bwrap), so
// there is no debugging port anywhere. The only address the browser can reach is the app: a relay inside its sandbox
// listens on 127.0.0.1:<app port> and carries each connection over a FIFO pair (frames as in the app's bridge) to the
// factory, which connects it to the app's host bridge port (the one HTTP steps use, so the FIFOs grant nothing a builder
// could not already reach). FIFOs, not a unix socket: Playwright spawns the browser, so no pipe of ours can be inherited.
// What a step expects never enters the browser: actions send target ids and typed text only, the page is read in a
// fresh isolated world (page JS cannot patch our DOM accessors), and the checks run here.
import { constants, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { frame, frameReader, HOME, removeTree, SANDBOX_PATH, sandboxCommand } from './sandbox.ts'

// The factory appends this section to a spec drafted with `draft --ui`; its presence is the declaration (part of the
// approved spec, so the approved version covers it). It carries no scenario data.
const UI_HEAD = '## Browser UI (factory)'
export const usesUi = (spec: string) => spec.includes(`\n${UI_HEAD}\n`)
export const withUi = (spec: string) => (usesUi(spec) ? spec : `${spec.trimEnd()}\n\n${UI_HEAD}\n\n` +
  'The app serves its pages itself (HTML from its own server; scripts and styles inline or served by the app, nothing from the network). ' +
  'Every name the interface lists under "testIds" is the data-testid attribute of the element(s) it names (several elements, such as list items, may share one). ' +
  'The pages are judged in a headless Chromium.\n')

// A test id is a bare identifier (no "."): "<id>.<n>" is the n-th (0-based) visible element with that id, as in a dot path.
export const TEST_ID = /^[A-Za-z_]\w*$/
export const TARGET = /^[A-Za-z_]\w*(\.\d+)?$/
export const UI_ACTIONS = ['goto', 'click', 'fill']
// Bounds: what the page shows is app-made, so the snapshot is capped in the browser; a page past a cap fails the step
// (a cut snapshot could make a wrong page pass a length or text check).
export const UI_LIMITS = { elements: 500, chars: 64_000, actionMs: 5_000, settleMs: 5_000, launchMs: 30_000, opMs: 10_000 }

// ponytail: linux x64 layout of the pinned Playwright's headless shell; resolve via Playwright's registry if other platforms matter.
const require = createRequire(import.meta.url)
const REV = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'))
  .browsers.find((b: { name: string }) => b.name === 'chromium-headless-shell').revision as string
export const BROWSER_DIR = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(HOME, '.cache', 'ms-playwright'), `chromium_headless_shell-${REV}`)
const EXE = join(BROWSER_DIR, 'chrome-headless-shell-linux64', 'chrome-headless-shell')

// Inside the browser's sandbox: 127.0.0.1:<port> -> frames on fd 6, frames from fd 5 -> those connections (len 0 closes
// an id). The ready file (in the sandbox's own /tmp) lets Chromium start only once the listener is up.
const READY = '/tmp/.factory-browser-relay-ready'
const RELAY = `const net = require('node:net'); const port = Number(process.argv[1])
${frame}
${frameReader}
const out = new net.Socket({ fd: 6, readable: false }), conns = new Map(); let next = 1
new net.Socket({ fd: 5, writable: false }).on('data', frameReader((id, d) => { const c = conns.get(id); if (c) d.length ? c.write(d) : c.end() }, () => process.exit(1)))
net.createServer((c) => {
  const id = next++; conns.set(id, c)
  c.on('data', (x) => out.write(frame(id, x))).on('error', () => {}).on('close', () => { if (conns.delete(id)) out.write(frame(id)) })
}).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(${JSON.stringify(READY)}, ''))`
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Runs in the isolated world: visible elements carrying a test id (Playwright's notion of visible, and its order:
// each tree's matches, then open shadow roots, so "<id>.<n>" names the same element for actions and checks), their
// text (an input's value; textContent for non-HTML elements such as SVG).
const SNAPSHOT = `(() => {
  const out = Object.create(null), els = []; let n = 0, size = 0 // no prototype: a test id "__proto__" is a key like any other
  const walk = (root) => { const all = root.querySelectorAll('*'); for (const e of all) if (e.hasAttribute('data-testid')) els.push(e); for (const e of all) if (e.shadowRoot) walk(e.shadowRoot) }
  walk(document)
  const box = (r) => r.width > 0 && r.height > 0
  const visible = (e) => { // Playwright's isElementVisible: display:contents is visible through its children
    const s = getComputedStyle(e)
    if (s.display === 'contents') {
      for (let c = e.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && visible(c)) return true
        if (c.nodeType === 3) { const g = document.createRange(); g.selectNodeContents(c); if ([...g.getClientRects()].some(box)) return true }
      }
      return false
    }
    return e.checkVisibility() && s.visibility === 'visible' && box(e.getBoundingClientRect())
  }
  for (const e of els) {
    if (!visible(e)) continue
    const id = e.getAttribute('data-testid'), t = (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) ? e.value : e.innerText ?? e.textContent).replace(/\\s+/g, ' ').trim()
    if (++n > ${UI_LIMITS.elements} || (size += id.length + t.length) > ${UI_LIMITS.chars}) return null
    if (!out[id]) out[id] = []
    out[id].push(t)
  }
  return JSON.stringify(out)
})()`

export type UiStep = { ui: string; path?: string; target?: string; text?: string }
export type Browser = { act(st: UiStep, port: number): Promise<number>; snapshot(): Promise<Record<string, string[]>>; close(): Promise<void> }

// One browser per scenario (fresh profile = fresh storage), opened against the app on host 127.0.0.1:<port>.
// Every operation is bounded and aborts with the signal: on either, the browser's sandbox is killed outright.
export async function openBrowser(port: number, signal: AbortSignal): Promise<Browser> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-browser-'))
  const toHost = join(dir, 'up'), toBrowser = join(dir, 'down'), profile = join(dir, 'profile'), pidFile = join(dir, 'pid')
  mkdirSync(profile)
  execFileSync('mkfifo', ['-m', '600', toHost, toBrowser])
  // O_RDWR: opening never blocks waiting for the other side, and the browser sandbox dying is handled by close().
  const up = new net.Socket({ fd: openSync(toHost, constants.O_RDWR | constants.O_NONBLOCK), writable: false })
  const down = new net.Socket({ fd: openSync(toBrowser, constants.O_RDWR | constants.O_NONBLOCK), readable: false })
  const conns = new Map<number, net.Socket>()
  up.on('error', () => {}).on('data', frameReader((id, d) => {
    let c = conns.get(id)
    if (!d.length) return void c?.end()
    if (!c) {
      const a = net.connect(port, '127.0.0.1')
      conns.set(id, c = a)
      a.on('data', (x) => down.write(frame(id, x))).on('error', () => {}).on('close', () => { if (conns.delete(id)) down.write(frame(id)) })
    }
    c.write(d)
  }, () => kill()))
  down.on('error', () => {})
  const inner = `node -e "$0" "$1" 3>&- 4>&- & until [ -e ${READY} ]; do sleep 0.05; done; shift; exec "$@" 5<&- 6>&-`
  const s = sandboxCommand('sh', ['-c', inner, RELAY, String(port), EXE], { workdir: dir, writable: true, extraRo: [BROWSER_DIR], isolateNet: true })
  const wrapper = join(dir, 'chrome.sh')
  writeFileSync(wrapper, `#!/bin/sh\necho $$ > ${q(pidFile)}\nexec ${[s.cmd, ...s.args].map(q).join(' ')} "$@" 5<${q(toBrowser)} 6>${q(toHost)}\n`, { mode: 0o700 })
  // Playwright spawns the wrapper detached, so its pid is the browser sandbox's process group.
  const kill = () => { try { process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch { /* not started or gone */ } }
  let ctx: BrowserContext | undefined
  const bounded = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let t: NodeJS.Timeout | undefined, onAbort = () => {}
    try {
      return await Promise.race([p, new Promise<never>((_, fail) => {
        t = setTimeout(() => { kill(); fail(new Error(`browser ${what} timed out after ${ms}ms`)) }, ms)
        onAbort = () => { kill(); fail(new Error('stopped')) }
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
      })])
    } finally { clearTimeout(t); signal.removeEventListener('abort', onAbort) }
  }
  const close = async () => {
    try { await bounded(ctx?.close() ?? Promise.resolve(), UI_LIMITS.opMs, 'close') } catch { /* killed below */ }
    kill()
    for (const c of conns.values()) c.destroy()
    up.destroy(); down.destroy()
    removeTree(dir)
  }
  let page: Page
  try {
    // env: nothing from the factory's environment reaches the browser.
    ctx = await bounded(chromium.launchPersistentContext(profile, { executablePath: wrapper, env: { PATH: SANDBOX_PATH, HOME }, timeout: UI_LIMITS.launchMs, headless: true }), UI_LIMITS.launchMs + 1000, 'launch')
    page = ctx.pages()[0] ?? await bounded(ctx.newPage(), UI_LIMITS.opMs, 'launch')
  } catch (e) { await close(); throw e }
  const cdp = await bounded(ctx.newCDPSession(page), UI_LIMITS.opMs, 'launch').catch(async (e) => { await close(); throw e })
  const nth = (target: string) => {
    const [id, n] = target.split('.')
    const l = page.getByTestId(id).filter({ visible: true })
    return n === undefined ? l : l.nth(Number(n)) // a bare id must name exactly one visible element (Playwright's strictness)
  }
  return {
    // Returns the navigation's HTTP status (goto), else 0.
    async act(st, port) {
      if (st.ui === 'goto') return (await bounded(page.goto(`http://127.0.0.1:${port}${st.path}`, { timeout: UI_LIMITS.opMs }), UI_LIMITS.opMs + 1000, 'navigation'))?.status() ?? 0
      const l = nth(st.target!)
      await bounded(st.ui === 'click' ? l.click({ timeout: UI_LIMITS.actionMs }) : l.fill(st.text!, { timeout: UI_LIMITS.actionMs }), UI_LIMITS.actionMs + 1000, st.ui)
      return 0
    },
    async snapshot() {
      const read = async () => {
        const { frameTree } = await cdp.send('Page.getFrameTree')
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'factory-judge' })
        const r = await cdp.send('Runtime.evaluate', { expression: SNAPSHOT, contextId: executionContextId, returnByValue: true })
        if (r.exceptionDetails) throw new Error('page could not be read')
        if (typeof r.result.value !== 'string') throw new Error(`page shows more than the judge reads (${UI_LIMITS.elements} elements, ${UI_LIMITS.chars} chars)`)
        return JSON.parse(r.result.value) as Record<string, string[]>
      }
      return bounded(read(), UI_LIMITS.opMs, 'read')
    },
    close,
  }
}
