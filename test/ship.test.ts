// What was judged is what ships; ship changes nothing visible unless the release really serves.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import type { Model } from '../src/adapter.ts'
import { build, judge } from '../src/roles.ts'
import { exportTree, freePort, removeTree } from '../src/sandbox.ts'
import { runScenario, type Scenario } from '../src/scenario.ts'
import { prodDir, ship, stopServer } from '../src/ship.ts'
import { freshState, gitTarget, MEMO_SERVER, SCENARIOS, tmp, writeApp } from './helpers.ts'

const sd = freshState()
after(() => stopServer(sd))
const never = new AbortController().signal
const head = (d: string) => execFileSync('git', ['-C', d, 'rev-parse', 'HEAD']).toString().trim()
const pass: Model = async () => ({ ok: true, text: '{"pass":true}', costUsd: 0 })
const builder = (write: (dir: string) => void): Model => async (t) => { write(t.workdir); return { ok: true, text: '', costUsd: 0 } }

test('a commit that silently fails (builder-set gpgsign) fails the build instead of reusing the old sha', async () => {
  const ws = gitTarget()
  await build(builder((d) => writeApp(d, 'process.exit(1)')), ws, 'spec', '')
  await assert.rejects(build(builder((d) => { writeApp(d, MEMO_SERVER); appendFileSync(join(d, '.git', 'config'), '[commit]\n\tgpgsign = true\n') }), ws, 'spec', ''), /could not commit/)
})

test('judge tests the exported commit: files git ignores do not count', async () => {
  const ws = gitTarget()
  const { sha } = await build(builder((d) => {
    writeApp(d, "require('./node_modules/impl/index.cjs')")
    mkdirSync(join(d, 'node_modules', 'impl'), { recursive: true })
    writeFileSync(join(d, 'node_modules', 'impl', 'index.cjs'), MEMO_SERVER)
    writeFileSync(join(d, '.gitignore'), 'node_modules/\n')
  }), ws, 'spec', '')
  const v = await judge(pass, ws, sha, 'spec', SCENARIOS.slice(1, 2), 'v', never)
  assert.equal(v.testsAllPass, false, 'the live workspace would pass; the shipped commit cannot start')
})

test('ship: a release that cannot start changes nothing (target, current)', async () => {
  const target = gitTarget()
  const ws = tmp('ws')
  execFileSync('git', ['clone', '-q', target, ws])
  const { sha } = await build(builder((d) => writeApp(d, 'process.exit(1)')), ws, 'spec', '')
  const h0 = head(target), port = await freePort()
  await assert.rejects(ship({ changeId: 'c', sha, approvedVersion: 'v' }, ws, target, sd, port), /exited before listening/)
  assert.equal(head(target), h0)
  assert.ok(!existsSync(join(prodDir(sd, port), 'current')))
})

test('ship: refuses when something else already listens on the port, and when stopped', async () => {
  const target = gitTarget()
  const ws = tmp('ws')
  execFileSync('git', ['clone', '-q', target, ws])
  const { sha } = await build(builder((d) => writeApp(d, MEMO_SERVER)), ws, 'spec', '')
  const h0 = head(target)
  const port = await freePort()
  const squatter = net.createServer().listen(port, '127.0.0.1')
  await new Promise((r) => squatter.once('listening', r))
  try {
    await assert.rejects(ship({ changeId: 'c', sha, approvedVersion: 'v' }, ws, target, sd, port), /already in use/)
  } finally { squatter.close() }
  assert.equal(head(target), h0)
  assert.ok(!existsSync(join(prodDir(sd, port), 'current')))
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(ship({ changeId: 'c', sha, approvedVersion: 'v' }, ws, target, sd, port, ac.signal), /stopped/)
  assert.equal(head(target), h0)
})

test('scenario runner: captured values keep their type; a missing capture fails the step', async () => {
  const ok = tmp('numeric')
  writeApp(ok, MEMO_SERVER.replace('const note = { id: String(++n),', 'const note = { id: ++n,').replace('notes.set(note.id, note)', 'notes.set(String(note.id), note)'))
  const typed: Scenario = { id: 'typed', title: 't', summary: 'a created note echoes its own id', inSpec: true, kind: 'crud', steps: [
    { method: 'POST', path: '/notes', body: { title: 'a' }, expect: { status: 201 }, capture: { id: 'id' } },
    { method: 'GET', path: '/notes/{{id}}', expect: { status: 200, json: { id: '{{id}}' } } },
  ] }
  const r1 = await runScenario(ok, typed, never)
  assert.equal(r1.pass, true, r1.detail)

  const broken = tmp('broken')
  writeApp(broken, `require('node:http').createServer((q, s) => { s.writeHead(q.method === 'POST' ? 201 : 404, {'content-type':'application/json'}); s.end('{}') }).listen(Number(process.env.PORT), '127.0.0.1')`)
  const del: Scenario = { id: 'del', title: 'd', summary: 'a deleted note is gone', inSpec: true, kind: 'crud', steps: [
    { method: 'POST', path: '/notes', body: { title: 'a' }, expect: { status: 201 }, capture: { id: 'id' } },
    { method: 'DELETE', path: '/notes/{{id}}', expect: { status: [204, 404] } },
    { method: 'GET', path: '/notes/{{id}}', expect: { status: 404 } },
  ] }
  const r2 = await runScenario(broken, del, never)
  assert.equal(r2.pass, false)
  assert.match(r2.detail, /capture id missing/)
  const proto: Scenario = { ...del, id: 'proto', steps: [{ method: 'POST', path: '/notes', body: {}, expect: { jsonHas: ['constructor'] } }] }
  assert.equal((await runScenario(broken, proto, never)).pass, false)
})

test('export ignores builder-written .git/config filters: the exported bytes are the committed bytes', async () => {
  const ws = gitTarget()
  const { sha } = await build(builder((d) => {
    writeFileSync(join(d, 'package.json'), '{"scripts":{"start":"node x.js"}}')
    writeFileSync(join(d, '.gitattributes'), '* filter=evil\n')
  }), ws, 'spec', '')
  appendFileSync(join(ws, '.git', 'config'), '[filter "evil"]\n\tsmudge = echo SHIPPED-NOT-JUDGED\n\tclean = cat\n')
  const dest = tmp('export')
  await exportTree(ws, sha, dest)
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"scripts":{"start":"node x.js"}}')
})

test('export refuses malformed objects (fsck on fetch out of the builder repo)', async () => {
  const ws = gitTarget()
  const g = (...a: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { input: '' }).toString().trim()
  const blob = execFileSync('git', ['-C', ws, 'hash-object', '-w', '--stdin'], { input: 'x' }).toString().trim()
  const sub = execFileSync('git', ['-C', ws, 'mktree'], { input: `100644 blob ${blob}\tconfig\n` }).toString().trim()
  const tree = execFileSync('git', ['-C', ws, 'hash-object', '-w', '-t', 'tree', '--literally', '--stdin'],
    { input: Buffer.concat([Buffer.from('40000 .git\0'), Buffer.from(sub, 'hex')]) }).toString().trim()
  const sha = g('commit-tree', tree, '-m', 'bad')
  await assert.rejects(exportTree(ws, sha, tmp('export-bad')), /hasDotgit|fsck|dotgit/i)
})

test('removeTree deletes a tree holding a mode-000 dir instead of throwing', () => {
  const d = tmp('locked')
  mkdirSync(join(d, 'data', 'locked', 'deep'), { recursive: true })
  chmodSync(join(d, 'data', 'locked'), 0o000)
  removeTree(d)
  assert.ok(!existsSync(d))
})

test('ship: a dirty ship target puts nothing live; the previous release keeps serving', async () => {
  const target = gitTarget()
  const ws = tmp('ws')
  execFileSync('git', ['clone', '-q', target, ws])
  const port = await freePort()
  const v1 = await build(builder((d) => writeApp(d, MEMO_SERVER)), ws, 'spec', '')
  await ship({ changeId: 'c', sha: v1.sha, approvedVersion: 'v' }, ws, target, sd, port)
  const v2 = await build(builder((d) => writeApp(d, MEMO_SERVER.replace("'not found'", "'gone'"))), ws, 'spec', '')
  writeFileSync(join(target, 'stray.txt'), 'local edit')
  await assert.rejects(ship({ changeId: 'c', sha: v2.sha, approvedVersion: 'v' }, ws, target, sd, port), /local changes/)
  assert.equal(head(target), v1.sha)
  assert.equal(readlinkSync(join(prodDir(sd, port), 'current')), join(prodDir(sd, port), 'releases', v1.sha))
  assert.equal((await fetch(`http://127.0.0.1:${port}/notes`)).status, 200)
  await stopServer(sd)
})

test('scenario runner: a redirect is judged as the redirect, not its target', async () => {
  const dir = tmp('redirect')
  writeApp(dir, `require('node:http').createServer((q, s) => { if (q.url === '/r') { s.writeHead(302, { location: '/ok' }); return s.end() } s.writeHead(200, {'content-type':'application/json'}); s.end('{"ok":true}') }).listen(Number(process.env.PORT), '127.0.0.1')`)
  const sc = (status: number): Scenario => ({ id: `r${status}`, title: 'r', summary: 'redirect handling', inSpec: true, kind: 'edge', steps: [{ method: 'GET', path: '/r', expect: { status } }] })
  assert.equal((await runScenario(dir, sc(200), never)).pass, false)
  const r = await runScenario(dir, sc(302), never)
  assert.equal(r.pass, true, r.detail)
})
