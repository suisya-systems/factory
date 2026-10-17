// Production: a tiny supervisor + reverse proxy that logs every request itself, so the
// signals do not depend on whatever logging the builder wrote. Then observe() reads them.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { freePort, killTree, spawnApp, waitPort } from './sandbox.ts'

export async function serve(stateDir: string, port: number): Promise<void> {
  const prod = join(stateDir, 'prod')
  const dataDir = join(prod, 'data')
  mkdirSync(dataDir, { recursive: true })
  const appDir = realpathSync(join(stateDir, 'releases', 'current'))
  const accessLog = join(prod, 'access.log')
  const errorLog = join(prod, 'error.log')
  const internal = await freePort()
  const app = spawnApp(appDir, internal, dataDir, ['ignore', 'ignore', openSync(errorLog, 'a')])
  app.on('exit', (code) => {
    appendFileSync(errorLog, `${new Date().toISOString()} [supervisor] app exited with code ${code}\n`)
    process.exit(1)
  })
  await waitPort(internal, 15_000, app)

  const server = http.createServer((req, res) => {
    const t0 = performance.now()
    const log = (status: number) => appendFileSync(accessLog, `${new Date().toISOString()} ${req.method} ${req.url} ${status} ${Math.round(performance.now() - t0)}\n`)
    const up = http.request({ host: '127.0.0.1', port: internal, path: req.url, method: req.method, headers: req.headers }, (pr) => {
      res.writeHead(pr.statusCode ?? 502, pr.headers)
      pr.pipe(res)
      pr.on('end', () => log(pr.statusCode ?? 502))
    })
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); log(502) })
    req.pipe(up)
  })
  server.on('error', (e) => { appendFileSync(errorLog, `${new Date().toISOString()} [supervisor] ${e.message}\n`); killTree(app, 500); process.exit(1) })
  server.listen(port, '127.0.0.1')
  const shutdown = () => { app.removeAllListeners('exit'); killTree(app, 500); server.close(); setTimeout(() => process.exit(0), 600) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Reads prod logs into signals.json and stops there: turning a signal into the next job goes
// through the drafter + human approval at the entrance (decision 2), never automatically.
export function observe(stateDir: string) {
  const prod = join(stateDir, 'prod')
  const read = (f: string) => (existsSync(join(prod, f)) ? readFileSync(join(prod, f), 'utf8').split('\n').filter(Boolean) : [])
  const access = read('access.log').map((l) => {
    const [time, method, path, status, ms] = l.split(' ')
    return { time, method, path, status: Number(status), ms: Number(ms), line: l }
  })
  const stderr = read('error.log')
  const byStatus: Record<string, number> = {}
  for (const a of access) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
  const ms = access.map((a) => a.ms).sort((x, y) => x - y)
  const pct = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null)
  const e5 = access.filter((a) => a.status >= 500)
  const signals = {
    at: new Date().toISOString(),
    requests: access.length,
    byStatus,
    errors5xx: e5.length,
    stderrErrors: stderr.filter((l) => /error|exception|unhandled|exited/i.test(l)).length,
    latencyMs: { p50: pct(0.5), p95: pct(0.95) },
    samples: { errors5xx: e5.slice(-5).map((a) => a.line), stderr: stderr.slice(-5) },
  }
  mkdirSync(prod, { recursive: true })
  writeFileSync(join(prod, 'signals.json'), JSON.stringify(signals, null, 2))
  return signals
}
