// OS sandbox (bubblewrap) for everything the factory runs that it does not trust:
// model sessions AND builder-written app code. The hidden-scenario guarantee lives here:
// the child sees / read-only, but $HOME (where the vault must live) is an empty tmpfs,
// /tmp is fresh, /mnt is hidden, and it has its own pid namespace.
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
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
  const cand = ['/mnt', '/run/user', '/var/tmp', xdg].filter((d) => d && existsSync(d) && !within(d, HOME) && !within(d, '/tmp'))
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
  a.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', real(o.workdir), '--', cmd, ...args)
  return { cmd: 'bwrap', args: a, fds: copies.map(([, s]) => s) }
}

// Spawns in its own process group so killTree() takes the whole sandbox down.
export function sandboxSpawn(cmd: string, args: string[], o: SandboxOpts, so: SpawnOptions = {}): ChildProcess {
  const s = sandboxCommand(cmd, args, o)
  const base = (so.stdio as any[] | undefined) ?? ['ignore', 'pipe', 'pipe']
  const stdio = [...base.slice(0, 3), ...s.fds.map((f) => openSync(f, 'r'))]
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
export function appEnv(port: number, dataDir: string): NodeJS.ProcessEnv {
  return { PATH: SANDBOX_PATH, HOME, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', npm_config_update_notifier: 'false', npm_config_fund: 'false' }
}

// Runs the app (`npm start` in appDir) sandboxed: appDir read-only, dataDir writable.
export function spawnApp(appDir: string, port: number, dataDir: string, stdio: SpawnOptions['stdio'] = ['ignore', 'ignore', 'pipe']): ChildProcess {
  return sandboxSpawn('npm', ['start', '--silent'], { workdir: appDir, writable: false, extraRw: [dataDir] }, { env: appEnv(port, dataDir), stdio })
}

// TCP listeners of the app's process tree (rootPid = the bwrap child) on a non-loopback address,
// e.g. ['0.0.0.0:8080']. The app shares the host network, so such a listener is reachable from outside.
// --unshare-pid / --new-session rule out pgid, but host /proc lists the inner processes by ppid.
// ponytail: checked at readiness only (a later bind is not caught); a network namespace + forwarding is the upgrade path.
export function publicListeners(rootPid: number): string[] {
  const ppid = new Map<number, number>()
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue
    try { const st = readFileSync(`/proc/${p}/stat`, 'utf8'); ppid.set(Number(p), Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1])) } catch { /* exited */ }
  }
  const inTree = (pid: number) => { for (let p = pid, n = 0; p > 1 && n < 1000; p = ppid.get(p) ?? 0, n++) if (p === rootPid) return true; return false }
  const inodes = new Set<string>()
  for (const pid of ppid.keys()) {
    if (!inTree(pid)) continue
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]) } catch { /* closed */ }
      }
    } catch { /* exited */ }
  }
  const out: string[] = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string[] = []
    try { rows = readFileSync(file, 'utf8').trim().split('\n').slice(1) } catch { continue }
    for (const r of rows) {
      const c = r.trim().split(/\s+/)
      const [hex, port] = c[1].split(':')
      if (c[3] !== '0A' || !inodes.has(c[9]) || isLoopbackHex(hex)) continue
      out.push(`${hexAddr(hex)}:${parseInt(port, 16)}`)
    }
  }
  return out
}

// Throws unless the app (just reported ready) listens on loopback only.
export function assertLoopbackOnly(app: ChildProcess): void {
  const l = app.pid ? publicListeners(app.pid) : []
  if (l.length) throw new Error(`app listens on a non-loopback address (${l.join(', ')})`)
}

// /proc/net/tcp{,6} print each 32-bit word of the address in host (little-endian) byte order.
const wordBytes = (w: string) => [6, 4, 2, 0].map((i) => parseInt(w.slice(i, i + 2), 16))
function isLoopbackHex(hex: string): boolean {
  if (hex.length === 8) return wordBytes(hex)[0] === 127
  const words = hex.toUpperCase().match(/.{8}/g)!
  if (words.join('') === '00000000000000000000000001000000') return true // ::1
  return words.slice(0, 3).join('') === '0000000000000000FFFF0000' && wordBytes(words[3])[0] === 127 // ::ffff:127.x
}
function hexAddr(hex: string): string {
  if (hex.length === 8) return wordBytes(hex).join('.')
  const b = hex.match(/.{8}/g)!.flatMap(wordBytes)
  return `[${Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16)).join(':')}]`
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
    const up = await new Promise<boolean>((ok) => {
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
