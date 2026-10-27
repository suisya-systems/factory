// a command-line program as the app. `draft --contract <file>` declares it: the factory appends a fixed
// `## Command-line program (factory)` section to the spec, with the execution contract as JSON (the command, the directories
// put on PYTHONPATH, the dependency set). Its presence is the declaration and, being in the spec, the approved version covers
// it. The hidden scenarios then have `run` steps: the program is started in a fresh empty working directory and its exit code,
// standard output, standard error and named files come back as one JSON envelope for the usual checks (scenario.ts: checkStep).
// The program runs in its own sandbox (sandbox.ts: loopback-only namespace, $HOME and /tmp hidden), the repository read-only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HOME, removeTree, SANDBOX_PATH, sandboxRun, visibleInSandbox } from './sandbox.ts'

export type Contract = { command: string[]; pythonPath?: string[]; deps?: string }

const HEAD = '## Command-line program (factory)'
export const usesRun = (spec: string) => spec.includes(`\n${HEAD}\n`)

// Names a scenario may use for the files a run reads or writes, and for the environment it sets.
export const FILE_PATH = /^[\w.-]+(\/[\w.-]+)*$/
export const okPath = (p: string) => FILE_PATH.test(p) && p.split('/').every((s) => s !== '.' && s !== '..')
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
// What a scenario may not set: the contract's own variables and the ones that load code or change where code is found.
export const RESERVED_ENV = /^(PATH|HOME|TMPDIR|VIRTUAL_ENV|PYTHON\w*|LD_\w*|DYLD_\w*|NODE_\w*|BASH_ENV|ENV|IFS)$/
// Bounds: the program is builder-written, so what it prints and writes is capped, and the run is timed.
export const RUN_LIMITS = { timeoutMs: 20_000, outChars: 200_000, files: 20, fileChars: 64_000, readChars: 200_000 }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const COMMAND_WORD = /^[\w.\/=+@:{}-]{1,200}$/

export function checkContract(x: unknown): Contract {
  const bad = (m: string) => new Error(`contract: ${m}`)
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw bad('not an object')
  const c = x as Record<string, unknown>
  for (const k of Object.keys(c)) if (!['command', 'pythonPath', 'deps'].includes(k)) throw bad(`unknown field "${k}"`)
  const list = (v: unknown, what: string, ok: (s: string) => boolean, max: number) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((s) => typeof s === 'string' && ok(s))) throw bad(what)
    return v as string[]
  }
  const command = list(c.command, 'command must be a short argv array of plain words, e.g. ["python3", "-m", "module"]', (s) => COMMAND_WORD.test(s), 8)
  if (!/^[A-Za-z][\w.+-]*$/.test(command[0])) throw bad('command[0] must be a program name looked up on PATH, not a path')
  const out: Contract = { command }
  if (c.pythonPath !== undefined) out.pythonPath = list(c.pythonPath, 'pythonPath must be a list of directories inside the repository', okPath, 8)
  if (c.deps !== undefined) {
    if (typeof c.deps !== 'string' || !/^[0-9a-f]{64}$/.test(c.deps)) throw bad('deps must be the sha256 (hex) of the lock file of a dependency set built by `deps build`')
    out.deps = c.deps
  }
  return out
}

// Appended to the spec of a change drafted with `--contract`. The contract is JSON in it, so judging reads it back from the approved spec.
const SECTION = (c: Contract) => `${HEAD}\n\n` +
  'The app is a command-line program, not an HTTP server. The factory runs it as the command below followed by the arguments of a check, ' +
  'in a fresh empty working directory (the program\'s current directory, writable; the repository itself is read-only), with no network. ' +
  'What is checked is its exit code, its standard output (read as JSON when it is JSON, else as text), its standard error and the files a check names.\n\n' +
  `\`\`\`json\n${JSON.stringify(c)}\n\`\`\`\n`
export function withRun(spec: string, c: Contract): string {
  if (!usesRun(spec)) return `${spec.trimEnd()}\n\n${SECTION(c)}`
  if (JSON.stringify(contractOf(spec)) !== JSON.stringify(c)) throw new Error('the spec already declares another command-line contract')
  return spec
}
export function contractOf(spec: string): Contract {
  const sec = spec.split(`\n${HEAD}\n`)[1]
  const json = sec?.match(/```json\n([\s\S]*?)\n```/)?.[1]
  if (!json) throw new Error('the spec declares no command-line contract')
  return checkContract(JSON.parse(json))
}

// ---- dependency sets ----
// A Python dependency set is a virtualenv made OUTSIDE $HOME from hash-pinned wheels only (no index, no network), one per lock file,
// named by the lock file's sha256. The sandboxes show / read-only, so a set outside the dirs they hide is visible to a run and to a
// builder without a mount. The contract names the set by that hash: it is part of the approved spec, so changing the set is
// a new draft. ponytail: the set is not re-hashed at judging time; whoever can write the root can change it. Lock it down on the host.
export const depsRoot = () => resolve(process.env.FACTORY_DEPS ?? '/opt/factory-deps')
export type DepsMeta = { lockSha256: string; python: string; packages: string[] }
export const depsDir = (id: string) => join(depsRoot(), id)
export function loadDeps(id: string): DepsMeta {
  const dir = depsDir(id)
  if (!visibleInSandbox(depsRoot())) throw new Error(`${depsRoot()} is hidden from the sandboxes (under $HOME, /tmp, /mnt, /run or /var/tmp); set FACTORY_DEPS to a dir elsewhere`)
  const meta = join(dir, 'meta.json')
  if (!existsSync(meta) || !existsSync(join(dir, 'venv', 'bin', 'python3'))) throw new Error(`dependency set ${id} is not built in ${depsRoot()} (npm run factory -- deps build --lock <file> --wheelhouse <dir>)`)
  const m = JSON.parse(readFileSync(meta, 'utf8')) as DepsMeta
  if (m.lockSha256 !== id) throw new Error(`${meta} is not the dependency set ${id}`)
  // venv/bin/python3 is a link to the interpreter it was made with: one under $HOME (pyenv, uv, conda) is a dangling link in a sandbox.
  const py = realpathSync(join(dir, 'venv', 'bin', 'python3'))
  if (!visibleInSandbox(py)) throw new Error(`the interpreter of dependency set ${id} (${py}) is hidden from the sandboxes; build the set with a system python (deps build --python /usr/bin/python3)`)
  return m
}

// Operator-side, outside any lap: needs a lock file in pip's `--require-hashes` form and a directory of the wheels it names.
// The host-side steps get a bare environment (no API keys or tokens of the factory's), and the set is tried once inside the run sandbox before it counts as built.
export async function buildDeps(lockFile: string, wheelhouse: string, python = 'python3'): Promise<{ id: string; dir: string }> {
  const bytes = readFileSync(lockFile), id = sha256(bytes), dir = depsDir(id)
  if (!visibleInSandbox(depsRoot())) throw new Error(`${depsRoot()} is hidden from the sandboxes; set FACTORY_DEPS to a dir outside $HOME, /tmp, /mnt, /run and /var/tmp`)
  if (existsSync(join(dir, 'meta.json'))) throw new Error(`${dir} is already built`)
  // Only pins and their hashes: a URL, an index, a find-links, a nested requirements file or an option would reach for the network or for files the lock does not cover.
  const packages: string[] = []
  for (const raw of bytes.toString('utf8').split('\n')) {
    const l = raw.replace(/\s*\\$/, '').trim()
    if (!l || l.startsWith('#') || /^--hash=sha256:[0-9a-f]{64}$/.test(l)) continue
    const pin = l.match(/^([A-Za-z0-9_.-]+==[A-Za-z0-9_.!+-]+)(\s*;[^#]*)?(\s+--hash=sha256:[0-9a-f]{64})*\s*(#.*)?$/)
    if (!pin) throw new Error(`${lockFile}: "${l.slice(0, 80)}" is not a "name==version" pin or a "--hash=sha256:..." line; a lock for a dependency set holds nothing else`)
    packages.push(pin[1])
  }
  if (!packages.length) throw new Error(`${lockFile}: no "name==version" requirement found`)
  removeTree(dir) // a build that stopped half way left no meta.json
  mkdirSync(dir, { recursive: true })
  const env = { PATH: process.env.PATH ?? SANDBOX_PATH, HOME, LANG: 'C.UTF-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' }
  try {
    const venvPython = join(dir, 'venv', 'bin', 'python3')
    execFileSync(python, ['-m', 'venv', join(dir, 'venv')], { stdio: 'inherit', env })
    if (!visibleInSandbox(realpathSync(venvPython))) throw new Error(`${python} resolves to ${realpathSync(venvPython)}, which the sandboxes hide; build with a system python (--python /usr/bin/python3)`)
    execFileSync(venvPython, ['-m', 'pip', 'install', '--no-index', '--find-links', resolve(wheelhouse), '--require-hashes', '--only-binary=:all:', '-r', resolve(lockFile)], { stdio: 'inherit', env })
    // -S: no site, so a .pth file of an installed wheel does not run on the host
    const py = execFileSync(venvPython, ['-S', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { env }).toString().trim()
    const work = mkdtempSync(join(tmpdir(), 'factory-deps-smoke-'))
    try {
      const t = await sandboxRun(venvPython, ['-c', 'import sys; print(sys.prefix)'], { workdir: work, writable: true, isolateNet: true }, { PATH: SANDBOX_PATH, HOME }, '', new AbortController().signal, { timeoutMs: 20_000, outChars: 10_000 })
      if (t.code !== 0) throw new Error(`the set does not start inside the sandbox: ${t.why ?? t.stderr.trim()}`)
    } finally { removeTree(work) }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ lockSha256: id, python: py, packages } satisfies DepsMeta, null, 2))
  } catch (e) { removeTree(dir); throw e }
  return { id, dir }
}

// ---- one run ----
export type ProgramRun = { argv: string[]; stdin?: string; files?: Record<string, string>; read?: string[]; env?: Record<string, string> }
export type Envelope = { status: number; json: { stdout: unknown; stderr: string; files: Record<string, unknown> } }

const lstatOrNull = (f: string): Stats | null => { try { return lstatSync(f) } catch { return null } }
// The working dir is written by the program: never follow a link it made, on the way in or out.
function inside(work: string, rel: string): string {
  if (!okPath(rel)) throw new Error(`"${rel}" is not a plain relative file path`)
  let cur = realpathSync(work)
  for (const seg of rel.split('/')) {
    cur = join(cur, seg)
    if (lstatOrNull(cur)?.isSymbolicLink()) throw new Error(`${rel}: the program made a link on that path`)
  }
  return cur
}
const asJson = (raw: string): unknown => { try { return raw.trim() ? JSON.parse(raw) : raw } catch { return raw } }

export async function runProgram(p: { appDir: string; work: string; contract: Contract }, r: ProgramRun, signal: AbortSignal): Promise<Envelope> {
  const c = p.contract
  const set = c.deps ? depsDir(c.deps) : undefined
  if (c.deps) loadDeps(c.deps)
  const files = Object.entries(r.files ?? {})
  if (files.length > RUN_LIMITS.files || (r.read?.length ?? 0) > RUN_LIMITS.files) throw new Error(`a run takes at most ${RUN_LIMITS.files} files in and ${RUN_LIMITS.files} out`)
  for (const [rel, text] of files) {
    if (text.length > RUN_LIMITS.fileChars) throw new Error(`${rel} is larger than ${RUN_LIMITS.fileChars} characters`)
    const f = inside(p.work, rel)
    mkdirSync(dirname(f), { recursive: true })
    // Only a missing path or a plain file: opening a FIFO the program left there for writing would block the whole factory process.
    const there = lstatOrNull(f)
    if (there && !there.isFile()) throw new Error(`${rel} is not a plain file`)
    writeFileSync(f, text)
  }
  const env: NodeJS.ProcessEnv = { PATH: [...(set ? [join(set, 'venv', 'bin')] : []), SANDBOX_PATH].join(':'), HOME, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    ...(c.pythonPath ? { PYTHONPATH: c.pythonPath.map((d) => join(p.appDir, d)).join(':') } : {}) }
  for (const [k, v] of Object.entries(r.env ?? {})) {
    if (!ENV_NAME.test(k) || RESERVED_ENV.test(k) || typeof v !== 'string' || v.includes('\0')) throw new Error(`environment variable ${k} is not allowed`)
    env[k] = v
  }
  const cmd = c.command.map((a) => a.replaceAll('{app}', p.appDir))
  const ran = await sandboxRun(cmd[0], [...cmd.slice(1), ...r.argv], { workdir: p.work, writable: true, extraRo: [p.appDir], isolateNet: true }, env, r.stdin ?? '', signal, RUN_LIMITS)
  if (signal.aborted) throw new Error('stopped')
  if (ran.why) throw new Error(`the program was stopped: ${ran.why}`)
  if (ran.code === null) throw new Error('the program was killed by a signal')
  const out: Record<string, unknown> = {}
  let total = 0
  for (const rel of r.read ?? []) {
    const f = inside(p.work, rel), st = lstatOrNull(f)
    if (!st) continue // not written: absent from the envelope, so `jsonHas` / `length` can tell
    if (!st.isFile()) throw new Error(`${rel} is not a plain file`)
    if ((total += st.size) > RUN_LIMITS.readChars) throw new Error(`the files to read are larger than ${RUN_LIMITS.readChars} characters in all`)
    out[rel] = asJson(readFileSync(f, 'utf8'))
  }
  return { status: ran.code, json: { stdout: asJson(ran.stdout), stderr: ran.stderr, files: out } }
}
