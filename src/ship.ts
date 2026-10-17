// Shipper: no model, no vault. Acts ONLY on the pass mark + the workspace git.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { exportTree, freePort, killTree, removeTree, sandboxGit, spawnApp, waitPort } from './sandbox.ts'

export type PassMark = { changeId: string; sha: string; approvedVersion: string }

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')
// ponytail: fixed ship branch (the practice repo's main); make it a run option if targets vary.
export const SHIP_BRANCH = 'main'

// Order: export + smoke-start the release (nothing visible changed yet) -> last stop check ->
// flip 'current' + restart -> fast-forward the ship target. A failed start OR a failed fast-forward
// rolls back to the previous release. The target must be clean and on SHIP_BRANCH before anything goes live.
export async function ship(mark: PassMark, workspace: string, target: string, stateDir: string, port: number, signal?: AbortSignal): Promise<{ release: string }> {
  const { sha } = mark
  const stopped = () => { if (signal?.aborted) throw new Error('stopped before the release went live') }
  // An aborted git/export reports a plain failure: name the stop instead of a misleading git error.
  const git = async (...a: Parameters<typeof sandboxGit>) => { const r = await sandboxGit(...a); stopped(); return r }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('pass mark has no valid sha')
  // Before #13 a state dir had one prod (prod/server.pid, prod/data, releases/current): refuse rather than start a
  // second, empty prod beside a live one. Not migrated: stop that server and move it to prod/<port>/ by hand.
  for (const old of [join(stateDir, 'prod', 'server.pid'), join(stateDir, 'prod', 'data'), join(stateDir, 'releases', 'current')]) {
    if (existsSync(old)) throw new Error(`${old} is the prod layout from before #13 (one prod per state dir, now $STATE/prod/<port>/); stop that server and move it by hand`)
  }
  if ((await git(workspace, ['cat-file', '-e', `${sha}^{commit}`], false, [], signal)).code !== 0) throw new Error(`sha ${sha} not in workspace`)

  const prod = prodDir(stateDir, port)
  const rel = join(prod, 'releases', sha) // per prod: two runs shipping one sha at once never write the same files
  mkdirSync(rel, { recursive: true })
  await exportTree(workspace, sha, rel, signal).finally(stopped) // same export the judge tested
  await smoke(rel, signal)
  // fetch moves no ref; it runs sandboxed because git reads the (builder-written) source repo.
  const f = await git(target, ['-c', 'transfer.fsckObjects=true', 'fetch', '-q', workspace, sha], true, [workspace], signal)
  if (f.code !== 0) throw new Error(`fetch into ship target failed: ${f.out.trim()}`)
  if ((await git(target, ['merge-base', '--is-ancestor', 'HEAD', sha], false, [], signal)).code !== 0) throw new Error('ship target cannot fast-forward to the release')
  const br = await git(target, ['symbolic-ref', '-q', '--short', 'HEAD'], false, [], signal)
  if (br.code !== 0 || br.out.trim() !== SHIP_BRANCH) throw new Error(`ship target is not on ${SHIP_BRANCH}`)
  const st = await git(target, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], false, [], signal)
  if (st.code !== 0 || st.out.trim() !== '') throw new Error('ship target has local changes or untracked files; refusing to ship')
  stopped() // last point where a stop cancels the ship; after this it runs to completion

  const cur = join(prod, 'current')
  const prev = existsSync(cur) ? readlinkSync(cur) : null
  flip(prod, rel)
  await stopServer(stateDir, port)
  try {
    await startServer(stateDir, port)
    const m = await sandboxGit(target, ['merge', '--ff-only', '-q', sha], true) // never push; no signal: past the stop point
    if (m.code !== 0) throw new Error(`fast-forward of ship target failed: ${m.out.trim()}`)
  } catch (e) {
    await stopServer(stateDir, port)
    if (prev) { flip(prod, prev); await startServer(stateDir, port).catch(() => {}) } else unlinkSync(cur)
    throw e
  }
  return { release: rel }
}

function flip(prod: string, to: string) {
  const tmp = join(prod, `.current-${process.pid}`)
  symlinkSync(to, tmp)
  renameSync(tmp, join(prod, 'current')) // atomic
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

// One prod per port (#13): runs shipping in parallel use distinct ports and never touch each other's
// server, release link or logs. $STATE/prod/<port>/: current -> releases/<sha>, server.pid, logs, data.
export const prodDir = (sd: string, port: number) => join(sd, 'prod', String(port))
const pidFile = (sd: string, port: number) => join(prodDir(sd, port), 'server.pid')

// No port: every prod of the state dir (cleanup).
export async function stopServer(stateDir: string, port?: number): Promise<void> {
  if (port === undefined) {
    for (const p of existsSync(join(stateDir, 'prod')) ? readdirSync(join(stateDir, 'prod')) : []) await stopServer(stateDir, Number(p))
    return
  }
  if (!existsSync(pidFile(stateDir, port))) return
  const pid = Number(readFileSync(pidFile(stateDir, port), 'utf8'))
  unlinkSync(pidFile(stateDir, port))
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
  mkdirSync(prodDir(stateDir, port), { recursive: true })
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'serve', '--port', String(port)], {
    detached: true, stdio: 'ignore', env: { ...process.env, FACTORY_HOME: stateDir },
  })
  c.unref()
  writeFileSync(pidFile(stateDir, port), String(c.pid))
  await waitPort(port, 20_000, c)
}
