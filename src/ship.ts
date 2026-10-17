// Shipper: no model, no vault. Acts ONLY on the pass mark + the workspace git.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { exportTree, freePort, killTree, removeTree, sandboxGit, spawnApp, waitPort } from './sandbox.ts'

export type PassMark = { changeId: string; sha: string; approvedVersion: string }

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')

// Order: export + smoke-start the release (nothing visible changed yet) -> last stop check ->
// flip 'current' + restart (rolled back if the start fails) -> fast-forward the ship target.
// The target only moves once the new release is actually serving.
export async function ship(mark: PassMark, workspace: string, target: string, stateDir: string, port: number, signal?: AbortSignal): Promise<{ release: string }> {
  const { sha } = mark
  const stopped = () => { if (signal?.aborted) throw new Error('stopped before the release went live') }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('pass mark has no valid sha')
  if ((await sandboxGit(workspace, ['cat-file', '-e', `${sha}^{commit}`], false)).code !== 0) throw new Error(`sha ${sha} not in workspace`)

  const releases = join(stateDir, 'releases')
  const rel = join(releases, sha)
  mkdirSync(rel, { recursive: true })
  await exportTree(workspace, sha, rel) // same export the judge tested
  await smoke(rel, signal)
  // fetch moves no ref; it runs sandboxed because git reads the (builder-written) source repo.
  const f = await sandboxGit(target, ['-c', 'transfer.fsckObjects=true', 'fetch', '-q', workspace, sha], true, [workspace])
  if (f.code !== 0) throw new Error(`fetch into ship target failed: ${f.out.trim()}`)
  if ((await sandboxGit(target, ['merge-base', '--is-ancestor', 'HEAD', sha], false)).code !== 0) throw new Error('ship target cannot fast-forward to the release')
  stopped() // last point where a stop cancels the ship; after this it runs to completion

  const cur = join(releases, 'current')
  const prev = existsSync(cur) ? readlinkSync(cur) : null
  flip(releases, rel)
  await stopServer(stateDir)
  try {
    await startServer(stateDir, port)
  } catch (e) {
    if (prev) { flip(releases, prev); await startServer(stateDir, port).catch(() => {}) } else unlinkSync(cur)
    throw e
  }
  const m = await sandboxGit(target, ['merge', '--ff-only', '-q', sha], true) // never push
  if (m.code !== 0) throw new Error(`fast-forward of ship target failed: ${m.out.trim()}`)
  return { release: rel }
}

function flip(releases: string, to: string) {
  const tmp = join(releases, `.current-${process.pid}`)
  symlinkSync(to, tmp)
  renameSync(tmp, join(releases, 'current')) // atomic
}

// The release starts and listens on a private port, before anything visible changes.
async function smoke(rel: string, signal?: AbortSignal) {
  const data = mkdtempSync(join(tmpdir(), 'factory-smoke-'))
  const port = await freePort()
  const app = spawnApp(rel, port, data)
  try {
    await waitPort(port, 15_000, app, signal)
  } finally {
    killTree(app, 500)
    removeTree(data)
  }
}

const pidFile = (sd: string) => join(sd, 'prod', 'server.pid')

export async function stopServer(stateDir: string): Promise<void> {
  if (!existsSync(pidFile(stateDir))) return
  const pid = Number(readFileSync(pidFile(stateDir), 'utf8'))
  unlinkSync(pidFile(stateDir))
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise((r) => setTimeout(r, 100))
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

const listening = (port: number) => new Promise<boolean>((ok) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); ok(true) })
  c.on('error', () => ok(false))
})

export async function startServer(stateDir: string, port: number): Promise<void> {
  // Otherwise waitPort would succeed against whatever already listens there (an unstopped old server).
  // ponytail: check-then-start race window; a ready handshake from serve if that ever bites.
  if (await listening(port)) throw new Error(`port ${port} is already in use; refusing to report a ship nobody serves`)
  mkdirSync(join(stateDir, 'prod'), { recursive: true })
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'serve', '--port', String(port)], {
    detached: true, stdio: 'ignore', env: { ...process.env, FACTORY_HOME: stateDir },
  })
  c.unref()
  writeFileSync(pidFile(stateDir), String(c.pid))
  await waitPort(port, 20_000, c)
}
