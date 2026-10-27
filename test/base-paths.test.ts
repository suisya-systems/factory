// --base-path shows the drafters part of a big app; the rest is listed by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { appSnapshot, checkBasePaths, main } from '../src/cli.ts'
import { hash, vaultDir } from '../src/vault.ts'
import { freshState, gitTarget, SCENARIOS, tmp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

// gitTarget() (README.md) plus extra tracked files; a value of Buffer/string is the file body.
function repoWith(files: Record<string, string | Buffer>): string {
  const d = gitTarget()
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true })
    writeFileSync(join(d, rel), body)
  }
  const g = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  g('add', '-A'); g('commit', '-q', '-m', 'more')
  return d
}
const FILES = { 'docs/a.md': 'doc a\n', 'src/a.ts': 'const a = 1\n', 'src/b/c.ts': 'const c = 3\n', 'src2/x.ts': 'const x = 9\n' }
const names = (text: string) => [...text.matchAll(/^=== (?!NOT SHOWN)(.+)$/gm)].map((m) => m[1])

test('checkBasePaths: plain repo-relative paths are normalised; everything else is refused', () => {
  assert.deepEqual(checkBasePaths(['./a/b/', 'src', '././x']), ['a/b', 'src', 'x'])
  for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a\\b', '..', '.', './']) assert.throws(() => checkBasePaths([bad]), /--base-path .*plain path/, JSON.stringify(bad))
})

test('appSnapshot without paths: every text file, "=== path\\nbody\\n", sorted, no NOT SHOWN line', async () => {
  const repo = repoWith({ ...FILES, 'bin.dat': Buffer.from([1, 0, 2]) })
  const a = await appSnapshot(repo)
  assert.deepEqual(a.paths, [])
  assert.match(a.sha, /^[0-9a-f]{40}$/)
  // Byte-exact: approvals made before --base-path must keep their drafted text.
  assert.equal(a.text, '=== docs/a.md\ndoc a\n\n=== README.md\npractice memo\n\n=== src/a.ts\nconst a = 1\n\n=== src/b/c.ts\nconst c = 3\n\n=== src2/x.ts\nconst x = 9\n\n')
  assert.ok(!a.text.includes('bin.dat'), 'a binary file was pasted')
})

test('appSnapshot with paths: only files at or under them; "src" does not match "src2"; the rest by name', async () => {
  const repo = repoWith(FILES)
  const a = await appSnapshot(repo, ['src', './docs/a.md/', 'src'])
  assert.deepEqual(a.paths, ['docs/a.md', 'src']) // duplicates collapse, normalised, sorted
  assert.deepEqual(names(a.text), ['docs/a.md', 'src/a.ts', 'src/b/c.ts'])
  const [first, ...rest] = a.text.split('\n')
  assert.equal(first, '=== NOT SHOWN (2 more text files of the app; names only, the builder sees them all): README.md, src2/x.ts')
  assert.ok(rest.join('\n').startsWith('=== docs/a.md\n'))
  assert.ok(!a.text.includes('const x = 9'), 'src2 body leaked through the "src" prefix')
  assert.ok(!a.text.includes('practice memo'))
})

test('appSnapshot: a path matching nothing (or only a binary file) is an error naming it', async () => {
  const repo = repoWith({ ...FILES, 'bin.dat': Buffer.from([1, 0, 2]) })
  await assert.rejects(appSnapshot(repo, ['src', 'nope/x']), /--base-path nope\/x: no tracked text file/)
  await assert.rejects(appSnapshot(repo, ['bin.dat']), /--base-path bin\.dat: no tracked text file/)
  await assert.rejects(appSnapshot(repo, ['sr']), /--base-path sr:/) // a prefix of a name is not a directory
})

test('appSnapshot: the cap applies to the pasted files only, and its error points at --base-path', async () => {
  const big = 'x'.repeat(99) + '\n'
  const repo = repoWith({ ...FILES, 'vendor/lib/big.txt': big.repeat(2100), 'vendor/lib/big2.txt': 'y\n' })
  const err = await appSnapshot(repo).then(() => null, (e: Error) => e.message)
  assert.match(err ?? '', /the app holds \d+ characters, more than the 200000/)
  assert.match(err ?? '', /Largest: vendor\/lib 2\d{5}/)
  assert.match(err ?? '', /--base-path/)
  // Choosing the small part works although the whole repository is over the cap.
  const ok = await appSnapshot(repo, ['src'])
  assert.deepEqual(names(ok.text), ['src/a.ts', 'src/b/c.ts'])
  // Choosing the big part is still over the cap, and says the chosen paths hold it.
  await assert.rejects(appSnapshot(repo, ['vendor']), /the chosen paths hold \d+ characters/)
})

test('appSnapshot: the NOT SHOWN list is cut at 300 names with a "... (N more)" tail', async () => {
  const many: Record<string, string> = { 'keep/k.ts': 'k\n' }
  for (let i = 0; i < 305; i++) many[`gen/f${String(i).padStart(3, '0')}.txt`] = 'g\n'
  const a = await appSnapshot(repoWith(many), ['keep'])
  const line = a.text.split('\n')[0]
  assert.match(line, /^=== NOT SHOWN \(306 more text files/) // 305 generated + README.md
  assert.ok(line.endsWith(', ... (6 more)'), line.slice(-40))
  assert.equal(line.split(': ')[1].split(', ').length, 301) // 300 names + the tail
  assert.ok(line.includes('gen/f298.txt') && !line.includes('gen/f304.txt'), 'cut in the wrong place')
})

// A fake model answering per role; records every task it saw.
const SPEC = '# Memo API\n- POST /notes creates a note and returns 201 with its id.\n- GET /notes/:id returns the note.\n\n## Undecided\n- the status code for an unknown id'
const IFACE = { endpoints: ['POST /notes', 'GET /notes/:id'], fields: { note: ['id', 'title'] } }
function fake() {
  const seen: Task[] = []
  const model: Model = async (t) => {
    seen.push(t)
    const reply = t.role === 'spec-drafter' ? { spec: SPEC, interface: IFACE, assumptions: [] }
      : t.role === 'scenario-drafter' ? { scenarios: [SCENARIOS[0]], assumptions: [] }
        : { steps: [{ status: [201], body: { id: '?' }, basis: 'spec', quote: 'returns 201 with its id' }, { status: [200], body: { title: 'alpha' }, basis: 'spec', quote: 'GET /notes/:id returns the note' }] }
    return { ok: true, costUsd: 0.1, text: '```json\n' + JSON.stringify(reply) + '\n```' }
  }
  return { model, seen }
}
const baseJson = (id: string) => JSON.parse(readFileSync(join(vaultDir(sd, id), 'base.json'), 'utf8'))

test('draft --base-path: base.json holds the sorted paths; every prompt shows the same NOT SHOWN line and only the chosen files', async () => {
  const repo = repoWith(FILES)
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'tags please')
  const { model, seen } = fake()
  assert.equal(await main(['draft', 'bp-1', '--request', req, '--base', repo, '--base-path', 'src', '--base-path', 'docs'], model), 0)
  const b = baseJson('bp-1')
  assert.deepEqual(b.paths, ['docs', 'src'])
  assert.match(b.baseSha, /^[0-9a-f]{40}$/)
  const expected = (await appSnapshot(repo, ['src', 'docs'])).text
  const hiddenLine = expected.split('\n')[0]
  assert.match(hiddenLine, /^=== NOT SHOWN \(2 more .*README\.md, src2\/x\.ts$/)
  // Both drafters and the classifier (one call per scenario step list) see the snapshot, hidden line first.
  for (const role of ['spec-drafter', 'scenario-drafter', 'classifier']) {
    const ts = seen.filter((t) => t.role === role)
    assert.ok(ts.length > 0, role)
    for (const t of ts) {
      assert.ok(t.instruction.includes(expected), `${role} did not get the same snapshot`)
      assert.ok(!t.instruction.includes('const x = 9'), `${role} saw a hidden file`)
    }
  }
  const summary = readFileSync(join(vaultDir(sd, 'bp-1'), 'approval-summary.md'), 'utf8')
  assert.match(summary, /the drafters were shown only: docs, src/)
})

test('draft without --base-path: no "paths" key in base.json, so earlier approvals keep their hash', async () => {
  const repo = repoWith(FILES)
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'tags please')
  assert.equal(await main(['draft', 'bp-none', '--request', req, '--base', repo], fake().model), 0)
  const b = baseJson('bp-none')
  assert.deepEqual(Object.keys(b).sort(), ['baseSha', 'requestSha256'])
  assert.doesNotMatch(readFileSync(join(vaultDir(sd, 'bp-none'), 'approval-summary.md'), 'utf8'), /shown only/)
})

test('draft --base-path without --base fails before any model call', async () => {
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'x')
  const { model, seen } = fake()
  await assert.rejects(main(['draft', 'bp-nobase', '--request', req, '--base-path', 'src'], model), /--base-path needs --base/)
  assert.equal(seen.length, 0)
})

test('the approved set hash changes with the paths the drafters were shown', async () => {
  const repo = repoWith(FILES)
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'tags please')
  const draftWith = async (id: string, ...paths: string[]) => {
    assert.equal(await main(['draft', id, '--request', req, '--base', repo, ...paths.flatMap((p) => ['--base-path', p])], fake().model), 0)
    return hash(vaultDir(sd, id))
  }
  const [a, b, again, order] = [await draftWith('h-a', 'src'), await draftWith('h-b', 'docs'), await draftWith('h-c', 'src'), await draftWith('h-d', 'src', 'src')]
  assert.notEqual(a, b)
  assert.equal(a, again) // same paths, same bytes
  assert.equal(a, order) // a duplicate path is not another choice
  assert.notEqual(a, await draftWith('h-e')) // no paths at all is another version too
})
