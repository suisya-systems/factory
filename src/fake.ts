// factory#17: a fake of the external service an app calls, for judging. It lives in the factory process and
// has NO listener of its own: builder sessions share the host network, so a port (even on loopback) would let
// a concurrent builder read or set it. The app reaches it only through its own bridge pipe (sandbox.ts:
// spawnApp's `service`), and scenario steps drive it through control(), a direct call. Fresh per scenario.
import http from 'node:http'
import { duplexPair, type Duplex } from 'node:stream'

// The factory appends this section to a spec drafted with `draft --service`; its presence is the declaration
// (it is part of the approved spec, so the approved version covers it). It carries no scenario data.
const SERVICE_HEAD = '## External service (factory)'
export const usesService = (spec: string) => spec.includes(`\n${SERVICE_HEAD}\n`)
// program: the app is a command-line program (it reads the variable from its environment, in any language, and a check can write it into a file).
export const withService = (spec: string, program = false) => (usesService(spec) ? spec : `${spec.trimEnd()}\n\n${SERVICE_HEAD}\n\n` +
  (program ? 'The external service the request names is reachable at the base URL in the environment variable SERVICE_URL of the program, of the form http://127.0.0.1:<port>; ' +
    'a check that has to give the program that address in a file or an argument writes {{SERVICE_URL}} there. '
    : 'The external service the request names is reachable at process.env.SERVICE_URL, a base URL of the form http://127.0.0.1:<port>. ') +
  'It is the only address on the network the app can reach.\n')

// Bounds on what the app can make the factory hold, counted as bytes and requests arrive (an unfinished
// request counts too); going past one cuts that connection and fails the scenario.
export const FAKE_LIMITS = { requests: 100, connections: 20, bodyBytes: 64_000, totalBytes: 512_000 }
export const CONTROL = { set: 'POST /responses', list: 'GET /requests' }
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

type Canned = { status: number; json?: unknown; headers?: Record<string, string> }
type Received = { method: string; path: string; headers: Record<string, unknown>; body: unknown }
export type Fake = { connect(): Duplex; control(method: string, path: string, body: unknown): { status: number; json: unknown }; overflow(): boolean; close(): void }

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x)
// Checked when the answer is set: an invalid header would otherwise throw in writeHead, in the factory process.
const headersOk = (x: unknown) => isObj(x) && Object.entries(x).every(([k, v]) => {
  try { http.validateHeaderName(k); http.validateHeaderValue(k, v); return typeof v === 'string' } catch { return false }
})

export function startFake(): Fake {
  const canned = new Map<string, Canned>()
  const log: Received[] = []
  const socks = new Set<Duplex>()
  let total = 0, requests = 0, over = false
  // Everything here is app-sent (builder-written code) and runs in the factory process: nothing may throw out of it.
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0, dropped = false
    const cut = () => { over = dropped = true; chunks.length = 0; req.socket.destroy() }
    if (++requests > FAKE_LIMITS.requests) return cut()
    req.on('data', (d: Buffer) => {
      size += d.length; total += d.length
      if (size > FAKE_LIMITS.bodyBytes || total > FAKE_LIMITS.totalBytes) cut()
      else chunks.push(d)
    })
    req.on('end', () => {
      try {
        if (dropped) return
        const raw = Buffer.concat(chunks).toString('utf8') // decoded once: a character split across chunks stays whole
        let body: unknown = raw || undefined
        try { body = raw ? JSON.parse(raw) : undefined } catch { /* kept as text */ }
        const path = req.url ?? ''
        log.push({ method: req.method ?? '', path, headers: { ...req.headers }, body })
        const c = canned.get(`${req.method} ${path.split('?')[0]}`)
        if (!c) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no canned response' })); return }
        res.writeHead(c.status, { ...(c.json === undefined ? {} : { 'content-type': 'application/json' }), ...c.headers })
        res.end(c.json === undefined ? undefined : JSON.stringify(c.json))
      } catch { res.destroy() }
    })
  })
  server.on('clientError', (_e, s) => s.destroy())
  return {
    connect() {
      const [ours, theirs] = duplexPair()
      if (socks.size >= FAKE_LIMITS.connections) { over = true; theirs.destroy(); return theirs }
      socks.add(ours)
      ours.on('close', () => socks.delete(ours)).on('error', () => {})
      server.emit('connection', ours)
      return theirs
    },
    // Answers like an HTTP endpoint so scenario checks apply unchanged. Values are copied both ways: the
    // scenario's captures and the fake's state never alias.
    control(method, path, body) {
      const at = `${method} ${path.split('?')[0]}`
      if (at === CONTROL.list) return { status: 200, json: structuredClone(log) }
      if (at !== CONTROL.set) return { status: 404, json: { error: 'unknown control endpoint' } }
      const b = body as any
      if (!isObj(b) || !METHODS.includes(b.method) || typeof b.path !== 'string' || !b.path.startsWith('/') || !(Number.isInteger(b.status) && b.status >= 200 && b.status <= 599)
        || (b.headers !== undefined && !headersOk(b.headers))) return { status: 400, json: { error: 'needs {method, path, status (200-599), json?, headers?}' } }
      canned.set(`${b.method} ${b.path.split('?')[0]}`, structuredClone({ status: b.status, json: b.json, headers: b.headers }))
      return { status: 204, json: undefined }
    },
    overflow: () => over,
    close() { for (const s of socks) s.destroy(); server.close() },
  }
}
