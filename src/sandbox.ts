// OS sandbox (bubblewrap) for everything the factory runs that it does not trust:
// model sessions AND builder-written app code. The hidden-scenario guarantee lives here:
// the child sees / read-only, but $HOME (where the vault must live) is an empty tmpfs,
// /tmp is fresh, /mnt is hidden, and it has its own pid namespace. App code also gets its own
// network namespace (loopback only): it cannot reach out, and the host reaches it through a bridge.
import { existsSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import net from 'node:net'

export const HOME = realpathSync(homedir())
const NODE_DIR = dirname(dirname(realpathSync(process.execPath)))
export const SANDBOX_PATH = [`${NODE_DIR}/bin`, '/usr/local/bin', '/usr/bin', '/bin'].join(':')

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p))
const within = (p: string, dir: string) => p === dir || p.startsWith(dir + sep)

// Paths no sandboxed child may ever see (vault, run records). Registered once at startup.
const protectedPaths: string[] = []

// Refuses (throws) unless `dir` is strictly under $HOME, i.e. guaranteed to be covered by
// the $HOME tmpfs. Then registers it so every later sandboxCommand refuses to mount it.
export function protect(dir: string): void {
  const p = real(dir)
  if (!within(p, HOME) || p === HOME) throw new Error(`refusing to start: ${p} is not under ${HOME}, so the sandbox cannot hide it`)
  if (within(p, NODE_DIR)) throw new Error(`refusing to start: ${p} is inside a path the sandbox re-exposes`)
  if (!protectedPaths.includes(p)) protectedPaths.push(p)
}

export type SandboxOpts = {
  workdir: string
  writable: boolean
  extraRw?: string[]
  extraRo?: string[]
  // dest (inside the sandbox) -> host source; the content is COPIED into a fresh writable file.
  copies?: Record<string, string>
  // Own network namespace with loopback only. Also hides /run, whose host control sockets
  // (e.g. docker.sock) would be a way out that no network namespace closes.
  isolateNet?: boolean
}

const RESOLVER_FILES = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf']

export function sandboxCommand(cmd: string, args: string[], o: SandboxOpts): { cmd: string; args: string[]; fds: string[] } {
  const ro = [NODE_DIR, ...(o.extraRo ?? [])]
  const copies = Object.entries(o.copies ?? {}).filter(([, src]) => existsSync(src))
  for (const m of [o.workdir, ...(o.extraRw ?? []), ...ro, ...copies.map(([, s]) => s)]) {
    const p = real(m)
    const hit = protectedPaths.find((x) => within(p, x) || within(x, p))
    if (hit) throw new Error(`sandbox refused: mount ${p} would expose protected ${hit}`)
  }
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', HOME, '--tmpfs', '/tmp']
  // Host runtime sockets (systemd --user, D-Bus session bus, gpg/ssh agent) would let a child run
  // commands OUTSIDE the sandbox (e.g. systemd-run --user) and so reach the vault.
  const xdg = process.env.XDG_RUNTIME_DIR ? real(process.env.XDG_RUNTIME_DIR) : ''
  const cand = ['/mnt', '/run/user', '/var/tmp', xdg, o.isolateNet ? '/run' : ''].filter((d) => d && existsSync(d) && !within(d, HOME) && !within(d, '/tmp'))
  // A dir under another hidden one (e.g. XDG=/run/user/<uid>) is already hidden; a nested --tmpfs
  // would recreate its mountpoint inside the parent tmpfs and so reveal it.
  const hidden = cand.filter((d) => !cand.some((o) => o !== d && within(d, o)))
  for (const d of hidden) a.push('--tmpfs', d)
  // Name resolution must survive the hiding: on WSL /etc/resolv.conf -> /mnt/wsl/resolv.conf.
  for (const f of RESOLVER_FILES) { const r = real(f); if (existsSync(r) && hidden.some((d) => within(r, d))) a.push('--ro-bind', r, r) }
  for (const p of ro) a.push('--ro-bind', real(p), real(p))
  a.push(o.writable ? '--bind' : '--ro-bind', real(o.workdir), real(o.workdir))
  for (const p of o.extraRw ?? []) a.push('--bind', real(p), real(p))
  copies.forEach(([dest], i) => a.push('--file', String(3 + i), dest))
  if (o.isolateNet) a.push('--unshare-net')
  a.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', real(o.workdir), '--', cmd, ...args)
  return { cmd: 'bwrap', args: a, fds: copies.map(([, s]) => s) }
}

// Spawns in its own process group so killTree() takes the whole sandbox down.
export function sandboxSpawn(cmd: string, args: string[], o: SandboxOpts, so: SpawnOptions = {}): ChildProcess {
  const s = sandboxCommand(cmd, args, o)
  const base = (so.stdio as any[] | undefined) ?? ['ignore', 'pipe', 'pipe']
  // fds 3.. are the copies; extra stdio entries the caller passes come after them
  const stdio = [...base.slice(0, 3), ...s.fds.map((f) => openSync(f, 'r')), ...base.slice(3)]
  return spawn(s.cmd, s.args, { ...so, stdio, detached: true })
}

export function killTree(child: ChildProcess, graceMs = 2000): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const kill = (sig: NodeJS.Signals) => {
    try { process.kill(-child.pid!, sig) } catch { /* already gone */ }
  }
  kill('SIGTERM')
  const t = setTimeout(() => kill('SIGKILL'), graceMs)
  t.unref()
  child.once('exit', () => clearTimeout(t))
}

// Minimal env for builder-written app code: nothing from the factory's environment leaks in.
export function appEnv(port: number, dataDir: string, servicePort?: number): NodeJS.ProcessEnv {
  return { PATH: SANDBOX_PATH, HOME, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', npm_config_update_notifier: 'false', npm_config_fund: 'false',
    ...(servicePort ? { SERVICE_URL: `http://127.0.0.1:${servicePort}` } : {}) }
}

// The bridge between host and app is one pipe (fd 3 inside the sandbox) carrying frames:
// [id u32][len u32][payload]. len 0 closes connection id; id 0 with len 0 means "the app accepts".
// Ids below REVERSE are connections the host opens to the app; ids from REVERSE up are connections the app
// opens to the service port (#17), which the host hands to the fake. Only the side that opened an id opens it.
const REVERSE = 0x80000000
const RELAY_READY = '/tmp/.factory-relay-ready'
export function frame(id: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(id); h.writeUInt32BE(data.length, 4)
  return Buffer.concat([h, data])
}
export function frameReader(on: (id: number, data: Buffer) => void, onBad: () => void) {
  let buf = Buffer.alloc(0)
  return (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 8) {
      const len = buf.readUInt32BE(4)
      if (len > 1 << 20) return onBad() // never buffer an unbounded frame
      if (buf.length < 8 + len) return
      const id = buf.readUInt32BE(0), data = buf.subarray(8, 8 + len)
      buf = buf.subarray(8 + len)
      on(id, data)
    }
  }
}

// Runs inside the app's namespace (the app itself gets fd 3 closed). Each new id opens a fresh
// connection to the app on its loopback. The functions above are inlined (type-stripped source).
// With a service port (argv 2) it also listens there, on the app's loopback, and sends each connection to
// the host; the ready file (in the sandbox's own /tmp) lets the app start only once that listener is up.
const RELAY = `const net = require('node:net'); const port = Number(process.argv[1]), sport = Number(process.argv[2]), REVERSE = ${REVERSE}
${frame}
${frameReader}
const pipe = new net.Socket({ fd: 3 }), conns = new Map()
pipe.on('error', () => process.exit(1)).on('close', () => process.exit(1))
pipe.on('data', frameReader((id, d) => {
  let c = conns.get(id)
  if (!d.length) return c?.end()
  if (!c) {
    if (id >= REVERSE || !port) return
    c = net.connect(port, '127.0.0.1'); conns.set(id, c)
    c.on('data', (x) => pipe.write(frame(id, x))).on('error', () => {}).on('close', () => { conns.delete(id); pipe.write(frame(id)) })
  }
  c.write(d)
}, () => process.exit(1)))
const wait = () => { const c = net.connect(port, '127.0.0.1').on('connect', () => { c.destroy(); pipe.write(frame(0)) }).on('error', () => setTimeout(wait, 100)) }
if (port) wait()
let rid = REVERSE
if (sport) net.createServer((c) => {
  const id = rid++; conns.set(id, c)
  c.on('data', (x) => pipe.write(frame(id, x))).on('error', () => {}).on('close', () => { if (conns.delete(id)) pipe.write(frame(id)) })
}).listen(sport, '127.0.0.1', () => require('node:fs').writeFileSync(${JSON.stringify(RELAY_READY)}, ''))`

// The host side of the service direction alone (a program has nothing listening that the host connects to): each connection the
// program opens to its service port is handed to the fake. Returns the function that ends them all.
function serviceBridge(pipe: net.Socket, connect: () => Duplex): () => void {
  const conns = new Map<number, Duplex>()
  const opened = new Set<number>() // reverse ids already handed to the fake: a late frame never reopens one
  pipe.on('error', () => {}).on('data', frameReader((id, d) => {
    if (id < REVERSE) return
    if (d.length && !opened.has(id)) {
      opened.add(id)
      const s = connect()
      conns.set(id, s)
      const done = () => { s.end(); if (conns.delete(id)) pipe.write(frame(id)) }
      s.on('data', (x: Buffer) => pipe.write(frame(id, x))).on('error', () => {}).on('end', done).on('close', done)
    }
    const c = conns.get(id)
    if (!c) return
    if (d.length) c.write(d)
    else { conns.delete(id); c.end() }
  }, () => pipe.destroy()))
  return () => { for (const c of conns.values()) c.destroy(); pipe.destroy() }
}

// App child -> "its host-side port is bound", for waitPort. Readiness is this bridge's own bind,
// never whatever else might be listening on the port.
const bridged = new WeakMap<ChildProcess, () => boolean>()

// Runs the app (`npm start` in appDir) sandboxed: appDir read-only, dataDir writable, no network but
// loopback. Host 127.0.0.1:port is bridged to the app's 127.0.0.1:port over an inherited pipe: no
// path, address or socket the app could reach out through.
// service (#17): the app's 127.0.0.1:service.port (SERVICE_URL) is bridged back to service.connect(), so
// the app reaches the fake and nothing else; the host never connects anywhere for it.
// ponytail: no backpressure on the bridge; fine for judge/prod HTTP, add pause/resume if bodies get big.
export function spawnApp(appDir: string, port: number, dataDir: string, stdio: SpawnOptions['stdio'] = ['ignore', 'ignore', 'pipe'], service?: { port: number; connect: () => Duplex }): ChildProcess {
  const base = (stdio as any[]).slice(0, 3)
  const start = service ? `until [ -e ${RELAY_READY} ]; do sleep 0.05; done; exec npm start --silent 3>&-` : 'exec npm start --silent 3>&-'
  const app = sandboxSpawn('sh', ['-c', `node -e "$0" "$1" "$2" & ${start}`, RELAY, String(port), String(service?.port ?? 0)],
    { workdir: appDir, writable: false, extraRw: [dataDir], isolateNet: true }, { env: appEnv(port, dataDir, service?.port), stdio: [...base, 'pipe'] })
  const pipe = app.stdio[3] as net.Socket
  const conns = new Map<number, Duplex>()
  const opened = new Set<number>() // reverse ids already handed to the fake: a late frame never reopens one
  let next = 1, listening = false, bindFailed = false
  const tcp = net.createServer((c) => {
    if (!listening) return void c.destroy() // bound early to hold the port; the app does not accept yet
    const id = next++
    conns.set(id, c)
    c.on('data', (d) => pipe.write(frame(id, d))).on('error', () => {}).on('close', () => { if (conns.delete(id)) pipe.write(frame(id)) })
  })
  pipe.on('error', () => {}).on('data', frameReader((id, d) => {
    if (id === 0) {
      if (bindFailed) killTree(app, 500)
      else listening = true
      return
    }
    if (id >= REVERSE && service && d.length && !opened.has(id)) {
      opened.add(id)
      const s = service.connect()
      conns.set(id, s)
      // The fake finished: end our half too, so its side closes and leaves its open-connection count.
      const done = () => { s.end(); if (conns.delete(id)) pipe.write(frame(id)) }
      s.on('data', (x: Buffer) => pipe.write(frame(id, x))).on('error', () => {}).on('end', done).on('close', done)
    }
    const c = conns.get(id)
    if (!c) return
    if (d.length) c.write(d)
    else { conns.delete(id); c.end() }
  }, () => killTree(app, 500)))
  const close = () => {
    listening = false
    tcp.close()
    for (const c of conns.values()) c.destroy()
    pipe.destroy()
  }
  app.once('exit', close).once('error', close)
  // Port taken: the app is stopped once it signals ready, not on the spot. Killing the sandbox while bwrap is still
  // setting up can orphan its inner process, which then holds the stderr pipe and keeps the factory process alive.
  // waitPort then sees the app exit.
  tcp.on('error', () => { bindFailed = true })
  // Bind now, not when the app is ready: freePort() only found the port free, and the app takes seconds to start,
  // long enough for another run's freePort() to be handed the same port (the bridge then lost the bind and killed the app).
  tcp.listen(port, '127.0.0.1')
  bridged.set(app, () => listening)
  return app
}

// ponytail: bind-to-0-then-close has a tiny race window; fine for a local prototype.
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => ok(port))
    })
    s.on('error', fail)
  })
}

export async function waitPort(port: number, timeoutMs: number, child?: ChildProcess, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('stopped')
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('app exited before listening')
    const isUp = child && bridged.get(child)
    const up = isUp ? isUp() : await new Promise<boolean>((ok) => {
      const c = net.connect(port, '127.0.0.1', () => { c.destroy(); ok(true) })
      c.on('error', () => ok(false))
    })
    if (up) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`app did not listen on port within ${timeoutMs}ms`)
}

// Runs git inside the sandbox: the workspace is builder-written, and git honours repo-local
// hooks / fsmonitor / filters, which would otherwise execute on the host next to the vault.
// Those can hang: on abort or timeout the whole sandbox is killed and the result is a failure (code null).
export function sandboxExec(cmd: string, args: string[], o: SandboxOpts, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 120_000): Promise<{ code: number | null; out: string }> {
  const c = sandboxSpawn(cmd, args, o, { env, cwd: o.workdir })
  let out = '' // tail only: the output is builder-controlled and could exhaust factory memory
  const add = (d: Buffer | string) => { out = (out + d).slice(-64_000) }
  c.stdout!.on('data', add)
  c.stderr!.on('data', add)
  const kill = (why: string) => { add(`\n[factory] killed: ${why}`); killTree(c, 500) }
  const timer = setTimeout(() => kill(`timeout after ${timeoutMs}ms`), timeoutMs)
  const onAbort = () => kill('stopped')
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return new Promise((ok) => {
    const done = (code: number | null) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); ok({ code: signal?.aborted ? null : code, out }) }
    c.on('error', () => done(null))
    c.on('close', done)
  })
}

// A program of the builder's (a `run` step) run to its end: stdin in, stdout and stderr out apart, bounded in time and size.
// why: set when the factory stopped it (timeout, too much output, abort); code is then meaningless.
export type Ran = { code: number | null; stdout: string; stderr: string; why?: string }
// service (a program that calls the fake external service): as spawnApp's, the program's 127.0.0.1:service.port is bridged over fd 3 to
// service.connect() by a relay started in the same sandbox before the program; the program itself gets fd 3 closed.
export function sandboxRun(cmd: string, args: string[], o: SandboxOpts, env: NodeJS.ProcessEnv, input: string, signal: AbortSignal, lim: { timeoutMs: number; outChars: number }, service?: { port: number; connect: () => Duplex }): Promise<Ran> {
  const via = service
    ? ['sh', ['-c', `node -e "$0" 0 "$1" & shift; until [ -e ${RELAY_READY} ]; do sleep 0.05; done; "$@" 3>&-; c=$?; kill $! 2>/dev/null; exit $c`, RELAY, String(service.port), cmd, ...args]] as const
    : [cmd, args] as const
  const c = sandboxSpawn(via[0], [...via[1]], o, { env, cwd: o.workdir, stdio: ['pipe', 'pipe', 'pipe', ...(service ? ['pipe' as const] : [])] })
  const closeBridge = service ? serviceBridge(c.stdio[3] as net.Socket, service.connect) : () => {}
  let stdout = '', stderr = '', why: string | undefined
  const kill = (w: string) => { why ??= w; killTree(c, 500) }
  const add = (which: 'stdout' | 'stderr') => (d: string) => {
    if (why) return // being stopped: keep nothing more, and stop it once
    if (which === 'stdout') stdout += d; else stderr += d
    if (stdout.length > lim.outChars || stderr.length > lim.outChars) kill(`more than ${lim.outChars} characters of output`) // builder-written: never buffer without a bound
  }
  c.stdout!.setEncoding('utf8').on('data', add('stdout')) // decoded as a stream: a character split between two chunks stays whole
  c.stderr!.setEncoding('utf8').on('data', add('stderr'))
  c.stdin!.on('error', () => {}) // the program may exit without reading its input
  c.stdin!.end(input)
  const timer = setTimeout(() => kill(`timeout after ${lim.timeoutMs}ms`), lim.timeoutMs)
  const onAbort = () => kill('stopped')
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return new Promise((ok) => {
    const done = (code: number | null) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); closeBridge(); ok({ code, stdout: stdout.slice(0, lim.outChars), stderr: stderr.slice(0, lim.outChars), why }) }
    c.on('error', () => { why ??= 'the program could not be started'; done(null) })
    c.on('close', done)
  })
}

// A dir the sandbox shows as is (not $HOME, /tmp, /mnt, /run, /var/tmp or the XDG runtime dir: sandboxCommand hides those).
export function visibleInSandbox(dir: string): boolean {
  const p = real(dir)
  const xdg = process.env.XDG_RUNTIME_DIR ? [real(process.env.XDG_RUNTIME_DIR)] : []
  return ![HOME, '/tmp', '/mnt', '/run', '/var/tmp', ...xdg].some((h) => within(p, h))
}

const GIT_ENV = { PATH: '/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1' }
export function sandboxGit(workdir: string, args: string[], writable: boolean, extraRo: string[] = [], signal?: AbortSignal) {
  return sandboxExec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=factory', '-c', 'user.email=factory@localhost', ...args], { workdir, writable, extraRo }, GIT_ENV, signal)
}

// The ONE way a commit becomes runnable files. The judge tests and the shipper ships the output of
// this same export, so what was judged and what ships are the same bytes (ignored files and
// export-ignore paths are absent from both). The archive runs from a bare repo the factory creates,
// never against the builder-written .git/config: its smudge/process filters would otherwise rewrite
// the exported bytes (and could make the judge's copy differ from the shipped one).
// ponytail: exports twice (judge, ship); export once + hash if that ever needs proving.
export async function exportTree(repo: string, sha: string, dest: string, signal?: AbortSignal): Promise<void> {
  const bare = mkdtempSync(join(tmpdir(), 'factory-export-'))
  try {
    const script = 'git init -q --bare . && git -c core.hooksPath=/dev/null -c transfer.fsckObjects=true fetch -q "$1" "$2" && git -c core.attributesFile=/dev/null archive --format=tar "$2" | tar -x -C "$3"'
    const a = await sandboxExec('sh', ['-c', script, 'sh', repo, sha, dest], { workdir: bare, writable: true, extraRo: [repo], extraRw: [dest] }, GIT_ENV, signal)
    if (a.code !== 0) throw new Error(`export of ${sha} failed: ${a.out.trim()}`)
  } finally { removeTree(bare) }
}

// Host-side cleanup of trees sandboxed code wrote: a mode-000 dir must not abort the run. chmod -R
// does not follow symlinks met during traversal; failures are swallowed (a leftover temp dir only).
export function removeTree(dir: string): void {
  try {
    spawnSync('chmod', ['-R', 'u+rwx', '--', dir])
    rmSync(dir, { recursive: true, force: true })
  } catch { /* leftover temp dir; never replaces the real result */ }
}
