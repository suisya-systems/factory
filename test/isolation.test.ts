// The hidden-scenario guarantee: nothing the factory runs sandboxed can read the vault.
// These tests attack with exact absolute paths (the strongest position a builder could have).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIN, CONFIG_KEEP, cliSandbox, runCli, type Task } from '../src/adapter.ts'
import { protect, sandboxCommand, sandboxExec, SANDBOX_PATH } from '../src/sandbox.ts'
import { runScenario } from '../src/scenario.ts'
import { vaultDir } from '../src/vault.ts'
import { freshState, MEMO_SERVER, tmp, writeApp } from './helpers.ts'

const sd = freshState()
const CANARY = `vault-canary-${process.pid}-${Date.now()}`
const vdir = vaultDir(sd, 'iso')
mkdirSync(vdir, { recursive: true })
const vfile = join(vdir, 'scenarios.json')
writeFileSync(vfile, JSON.stringify({ secret: CANARY }))
const runsFile = join(sd, 'runs', 'secret-run.json')
writeFileSync(runsFile, CANARY)
const tmpCanary = join(tmpdir(), `factory-tmp-canary-${process.pid}`)
writeFileSync(tmpCanary, CANARY)
const env = { PATH: SANDBOX_PATH, HOME: homedir() }

const sh = (script: string, workdir: string, writable = false) => sandboxExec('sh', ['-c', script], { workdir, writable }, env)

test('host can read the canaries (control: the attacks below are not vacuous)', () => {
  assert.equal(JSON.parse(readFileSync(vfile, 'utf8')).secret, CANARY)
  assert.equal(readFileSync(runsFile, 'utf8'), CANARY)
})

test('sandboxed child cannot cat / ls / node-read the vault, run records, or host /tmp', async () => {
  const w = tmp('iso-w')
  for (const script of [`cat ${vfile}`, `ls -la ${vdir}`, `cat ${runsFile}`, `cat ${tmpCanary}`, `ls -la ${sd}`,
    `node -e 'process.stdout.write(require("fs").readFileSync(${JSON.stringify(vfile)},"utf8"))'`,
    `grep -rs ${CANARY} ${homedir()} /tmp 2>/dev/null; true`]) {
    const r = await sh(script, w)
    assert.ok(!r.out.includes(CANARY), `leak via: ${script}`)
    if (!script.endsWith('true')) assert.notEqual(r.code, 0, `should fail: ${script}`)
  }
})

test('sandbox view: empty home, no other sessions, fresh /tmp, own pid namespace', async () => {
  const w = tmp('iso-view')
  const r = await sh(`ls -A ${homedir()}/.claude/projects 2>/dev/null | wc -l; echo ---; ls -A ${homedir()}; echo ---; ls -A /tmp; echo ---; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '`, w)
  const [projects, home, tmpls, procs] = r.out.split('---\n')
  assert.equal(projects.trim(), '0')
  assert.ok(!home.includes('work') && !home.includes('.claude'), `home exposes: ${home}`)
  // /tmp only holds the parent of our own bound workdir
  for (const e of tmpls.trim().split('\n').filter(Boolean)) assert.ok(w.startsWith(join('/tmp', e)), `unexpected /tmp entry ${e}`)
  assert.ok(!procs.includes('isolation.test'), 'factory process visible from sandbox')
})

test('writable workdir is writable; read workdir is not', async () => {
  const w = tmp('iso-rw'), r = tmp('iso-ro')
  assert.equal((await sh('touch ok && echo yes', w, true)).code, 0)
  assert.ok(existsSync(join(w, 'ok')))
  assert.notEqual((await sh('touch nope', r, false)).code, 0)
  assert.ok(!existsSync(join(r, 'nope')))
})

test('sandbox refuses mounts that would expose protected paths, and state outside $HOME', () => {
  assert.throws(() => sandboxCommand('true', [], { workdir: vdir, writable: false }), /protected/)
  assert.throws(() => sandboxCommand('true', [], { workdir: tmp('x'), writable: false, extraRo: [sd] }), /protected/)
  assert.throws(() => sandboxCommand('true', [], { workdir: tmp('x'), writable: false, copies: { '/tmp/x': vfile } }), /protected/)
  assert.throws(() => protect(tmp('outside-home')), /not under/)
})

test('model-session sandbox: CLI starts, sees no config history, cannot read the vault', async () => {
  const w = tmp('iso-model')
  const task: Task = { role: 'builder', instruction: '', workdir: w, access: 'write', maxCostUsd: 1, timeoutMs: 30_000 }
  const v = await sandboxExec(BIN, ['--version'], cliSandbox(task), { ...process.env, PATH: SANDBOX_PATH })
  assert.equal(v.code, 0, v.out)
  assert.match(v.out, /\d+\.\d+\.\d+/)
  assert.equal((await sandboxExec('node', ['--version'], cliSandbox(task), env)).code, 0)
  // Same mounts through the real adapter path, with a fake CLI that snoops instead of thinking.
  const fake = join(w, 'snoop')
  writeFileSync(fake, `#!/bin/sh\ncat ${vfile} > snoop.out 2>&1; ls -A ${homedir()}/.claude >> snoop.out 2>&1; ls -A ${homedir()}/.claude/projects >> snoop.out 2>&1\ncat > /dev/null\necho '{"result":"done","total_cost_usd":0}'\n`)
  chmodSync(fake, 0o755)
  const res = await runCli(task, fake)
  assert.equal(res.ok, true, res.error)
  const seen = readFileSync(join(w, 'snoop.out'), 'utf8')
  assert.ok(!seen.includes(CANARY))
  for (const leak of ['history.jsonl', 'file-history', 'projects', 'paste-cache']) assert.ok(!seen.split('\n').includes(leak), `config dir exposes ${leak}`)
})

const LEAK_APP = (path: string) => `
const http = require('node:http'); const fs = require('node:fs')
let secret = null; try { secret = fs.readFileSync(${JSON.stringify(path)}, 'utf8') } catch (e) { secret = 'ERR ' + e.code }
http.createServer((q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end(JSON.stringify({ secret })) }).listen(Number(process.env.PORT), '127.0.0.1')
`
const leakScenario = (expected: string) => ({ id: 'leak', title: 'leak', summary: 'leak probe', inSpec: false, kind: 'attack',
  steps: [{ method: 'GET', path: '/', expect: { status: 200, json: { secret: expected } } }] })

test('builder-written app code cannot read the vault at runtime (judge/prod app runs)', async () => {
  const app = tmp('iso-app')
  writeApp(app, LEAK_APP(vfile))
  const r = await runScenario(app, leakScenario(JSON.stringify({ secret: CANARY })), new AbortController().signal)
  assert.equal(r.failedStep, 1, r.detail) // the app ran and answered, but without the secret
  assert.equal(r.pass, false)
})

test('control: same app reading a file inside its own dir DOES pass (detection path works)', async () => {
  const app = tmp('iso-app-ctl')
  writeFileSync(join(app, 'local.txt'), CANARY)
  writeApp(app, LEAK_APP(join(app, 'local.txt')))
  const r = await runScenario(app, leakScenario(CANARY), new AbortController().signal)
  assert.equal(r.pass, true, r.detail)
})

test('host runtime sockets (/run/user, $XDG_RUNTIME_DIR) are hidden', async () => {
  const dirs = ['/run/user', process.env.XDG_RUNTIME_DIR].filter((d): d is string => !!d && existsSync(d))
  const r = await sh(dirs.map((d) => `ls -A ${d} 2>/dev/null`).join('; ') + '; true', tmp('iso-run'))
  assert.equal(r.out.trim(), '', `visible: ${r.out}`)
})

test('model sandbox: ~/.claude.json holds only allowlisted keys; ~/.local/bin is not mounted', async () => {
  const w = tmp('iso-cfg')
  const task: Task = { role: 'builder', instruction: '', workdir: w, access: 'write', maxCostUsd: 1, timeoutMs: 30_000 }
  const fake = join(w, 'snoop')
  writeFileSync(fake, `#!/bin/sh\ncat ${homedir()}/.claude.json > cfg.out 2>&1; ls -A ${homedir()}/.local/bin > bin.out 2>&1\ncat > /dev/null\necho '{"result":"done","total_cost_usd":0}'\n`)
  chmodSync(fake, 0o755)
  assert.equal((await runCli(task, fake)).ok, true)
  const keys = Object.keys(JSON.parse(readFileSync(join(w, 'cfg.out'), 'utf8')))
  for (const k of keys) assert.ok(CONFIG_KEEP.includes(k), `config exposes ${k}`)
  assert.match(readFileSync(join(w, 'bin.out'), 'utf8'), /No such file/)
})

test('sandboxExec keeps only the tail of builder-controlled output', async () => {
  const r = await sh('head -c 3000000 /dev/zero | tr "\\0" a; echo END', tmp('iso-out'))
  assert.ok(r.out.length <= 64_000, String(r.out.length))
  assert.ok(r.out.endsWith('END\n'))
})

test('an app listening on a non-loopback address fails its scenario; the same app on 127.0.0.1 passes', async () => {
  const sc = { id: 'lo', title: 't', summary: 'the app answers', inSpec: true, kind: 'net', steps: [{ method: 'GET', path: '/notes', expect: { status: 200 } }] }
  for (const [addr, pass] of [['0.0.0.0', false], ['::', false], ['127.0.0.1', true]] as const) {
    const app = tmp('lo')
    writeApp(app, MEMO_SERVER.replace(".listen(Number(process.env.PORT), '127.0.0.1')", `.listen(Number(process.env.PORT), '${addr}')`))
    const r = await runScenario(app, sc, new AbortController().signal)
    assert.equal(r.pass, pass, `${addr}: ${r.detail}`)
    if (!pass) assert.match(r.detail, /app listens on a non-loopback address/)
  }
})

test('sandboxExec kills a hanging child on abort and on timeout', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  let t0 = Date.now()
  const r1 = await sandboxExec('sleep', ['60'], { workdir: tmp('hang'), writable: false }, env, ac.signal)
  assert.ok(Date.now() - t0 < 5000, `abort took ${Date.now() - t0}ms`)
  assert.equal(r1.code, null)
  t0 = Date.now()
  const r2 = await sandboxExec('sleep', ['60'], { workdir: tmp('hang'), writable: false }, env, undefined, 300)
  assert.ok(Date.now() - t0 < 5000, `timeout took ${Date.now() - t0}ms`)
  assert.equal(r2.code, null)
  assert.match(r2.out, /timeout/)
})
