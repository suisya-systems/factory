// CLI paths that spend money must record it, and approval binds to the version the owner read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { CAPS } from '../src/limits.ts'
import { approve, hash, vaultDir, writeDraft } from '../src/vault.ts'
import { freshState, SCENARIOS, tmp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

test('a failed drafter still records its spend', async () => {
  const req = join(tmp('req'), 'req.txt')
  writeFileSync(req, 'a memo api')
  await assert.rejects(main(['draft', 'd1', '--request', req], async () => ({ ok: true, text: 'sorry', costUsd: 2 })), /no parseable JSON/)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'd1', 'draft-cost.json'), 'utf8')).totalUsd, 4) // the reply and its one repair round
})

test('probe-isolation over the cap still writes its result, with its own exit code', async () => {
  writeDraft(sd, 'p1', { spec: 's', scenarios: SCENARIOS, assumptions: [] })
  const code = await main(['probe-isolation', 'p1'], async () => ({ ok: true, text: 'could not read anything', costUsd: 1.5 }))
  assert.equal(code, 3)
  const out = JSON.parse(readFileSync(join(sd, 'runs', 'p1', 'isolation-probe.json'), 'utf8'))
  assert.equal(out.costUsd, 1.5)
  assert.equal(out.overCap, true)
  assert.equal(out.canaryFound, false)
})

test('run refuses a malformed --max-cost / --max-attempts instead of running uncapped', async () => {
  let calls = 0
  const m = async () => { calls++; return { ok: true, text: '', costUsd: 50 } }
  await assert.rejects(main(['run', 'x1', '--ship-target', sd, '--max-cost', '10usd'], m), /max cost/)
  await assert.rejects(main(['run', 'x1', '--ship-target', sd, '--max-attempts', 'abc'], m), /max attempts/)
  assert.equal(calls, 0)
})

test('approval binds to the version shown in the summary', async () => {
  const dir = writeDraft(sd, 'v1', { spec: 's', scenarios: SCENARIOS, assumptions: [] })
  const reviewed = hash(dir)
  writeDraft(sd, 'v1', { spec: 's', scenarios: SCENARIOS.slice(0, 1), assumptions: [] }) // re-draft after the owner read it
  assert.throws(() => approve(sd, 'v1', { by: 'owner', version: reviewed }), /not the version you reviewed/)
  assert.ok(!existsSync(join(dir, 'approval.json')))
  assert.equal(await main(['approve', 'v1', '--by', 'owner']), 2) // --version is required
  assert.equal(approve(sd, 'v1', { by: 'owner', version: hash(dir) }), hash(dir))
})

test('--help / -h print usage and exit 0; bad options and unknown commands exit 2 without touching state', async () => {
  assert.equal(await main(['--help']), 0)
  assert.equal(await main(['-h']), 0)
  const prev = process.env.FACTORY_HOME
  process.env.FACTORY_HOME = '/nonexistent-outside-home' // stateDir() would throw here
  try {
    assert.equal(await main(['--bogus']), 2)
    assert.equal(await main(['help']), 2)
    assert.equal(await main([]), 2)
  } finally { process.env.FACTORY_HOME = prev }
})

test('a re-draft adds to the earlier drafter spend instead of overwriting it', async () => {
  const req = join(tmp('req2'), 'req.txt')
  writeFileSync(req, 'a memo api')
  const m = (c: number) => async () => ({ ok: true, text: 'sorry', costUsd: c })
  await assert.rejects(main(['draft', 'd2', '--request', req], m(2)))
  await assert.rejects(main(['draft', 'd2', '--request', req], m(3)))
  const l = JSON.parse(readFileSync(join(sd, 'runs', 'd2', 'draft-cost.json'), 'utf8'))
  assert.equal(l.totalUsd, 10) // (2 + 3), each with its repair round
  assert.deepEqual(l.byRole, { 'spec-drafter': 10 })
})

test('probe-isolation: a canary the model wrote into its workdir counts as found; the canary file is removed', async () => {
  const code = await main(['probe-isolation', 'p2'], async (t) => {
    const file = t.instruction.split('\n').find((l) => l.endsWith('probe-canary.txt'))!.replace(/^- cat /, '')
    mkdirSync(join(t.workdir, 'sub'), { recursive: true })
    writeFileSync(join(t.workdir, 'sub', 'loot'), readFileSync(file, 'utf8'))
    return { ok: true, text: 'nothing to see', costUsd: 0.1 }
  })
  assert.equal(code, 1)
  const out = JSON.parse(readFileSync(join(sd, 'runs', 'p2', 'isolation-probe.json'), 'utf8'))
  assert.deepEqual([out.canaryFound, out.canaryInReply, out.canaryInWorkdir], [true, false, true])
  assert.ok(!existsSync(join(vaultDir(sd, 'p2'), 'probe-canary.txt')))
})

test('lap-wide cap: once the lap ledger reaches it, no command starts another model call', async () => {
  const lap = join(sd, 'lap-ledger.json')
  const saved = existsSync(lap) ? readFileSync(lap, 'utf8') : null
  writeFileSync(lap, JSON.stringify({ totalUsd: CAPS.lapCostUsd }))
  let calls = 0
  const m = async () => { calls++; return { ok: true, text: '', costUsd: 0.1 } }
  try {
    assert.equal(await main(['probe-isolation', 'p3'], m), 3)
    const req = join(tmp('req3'), 'req.txt')
    writeFileSync(req, 'x')
    await assert.rejects(main(['draft', 'd3', '--request', req], m), /lap cost cap/)
    assert.equal(calls, 0)
  } finally { saved === null ? writeFileSync(lap, '{"totalUsd":0}') : writeFileSync(lap, saved) }
})

test('with the STOP file present every command but stop, serve (internal) and help refuses before doing anything', async () => {
  const f = process.env.FACTORY_STOP_FILE!
  writeFileSync(f, 'x')
  try {
    for (const argv of [['approve', 'v1', '--by', 'o', '--version', 'x'], ['observe'], ['probe-isolation', 'p9']]) {
      assert.equal(await main(argv, async () => { throw new Error('model called') }), 1, argv[0])
    }
    assert.ok(!existsSync(join(sd, 'prod', 'signals.json')), 'observe ran')
    await assert.rejects(main(['serve', '--port', '1']), /ENOENT/) // got past the stop check (no release to serve)
    assert.equal(await main(['--help']), 0)
    assert.equal(await main(['stop']), 0)
  } finally { unlinkSync(f) }
})

test('draft of an already-approved id is refused before any model call', async () => {
  const dir = writeDraft(sd, 'fixed1', { spec: 's', scenarios: SCENARIOS, assumptions: [] })
  approve(sd, 'fixed1', { by: 'owner', version: hash(dir) })
  const req = join(tmp('req'), 'r.md'); writeFileSync(req, 'x')
  let calls = 0
  assert.equal(await main(['draft', 'fixed1', '--request', req], async () => { calls++; return { ok: true, text: '{}', costUsd: 1 } }), 1)
  assert.equal(calls, 0)
})
