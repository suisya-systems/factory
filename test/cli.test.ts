// CLI paths that spend money must record it, and approval binds to the version the owner read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'd1', 'draft-cost.json'), 'utf8')).totalUsd, 6) // the reply and its two repair rounds
  const kept = readdirSync(join(sd, 'runs', 'd1')).filter((f) => f.startsWith('rejected-'))
  assert.equal(kept.length, 1) // every rejected reply, kept for the experimenter
  assert.deepEqual(JSON.parse(readFileSync(join(sd, 'runs', 'd1', kept[0]), 'utf8')).map((r: { role: string; reply: string }) => [r.role, r.reply]), [['spec-drafter', 'sorry'], ['spec-drafter', 'sorry'], ['spec-drafter', 'sorry']])
})

test('--minority-brief needs --minority, before any model call', async () => {
  const req = join(tmp('req'), 'req.txt')
  writeFileSync(req, 'a memo api')
  let calls = 0
  await assert.rejects(main(['draft', 'd2', '--request', req, '--minority-brief', 'pick 4'], async () => { calls++; return { ok: true, text: '', costUsd: 0 } }), /--minority-brief needs --minority/)
  assert.equal(calls, 0)
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
  assert.equal(l.totalUsd, 15) // (2 + 3), each with its two repair rounds
  assert.deepEqual(l.byRole, { 'spec-drafter': 15 })
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

test('lap-wide cap: once the lap ledger reaches it, no command starts another model call (also a pre-#13 lap-ledger.json)', async () => {
  for (const [f, full] of [['lap-ledger.jsonl', `${JSON.stringify({ call: 'c', role: 'builder', usd: CAPS.lapCostUsd })}\n`], ['lap-ledger.json', JSON.stringify({ totalUsd: CAPS.lapCostUsd })]]) {
    const lap = join(sd, f)
    const saved = existsSync(lap) ? readFileSync(lap, 'utf8') : ''
    writeFileSync(lap, full)
    let calls = 0
    const m = async () => { calls++; return { ok: true, text: '', costUsd: 0.1 } }
    try {
      assert.equal(await main(['probe-isolation', 'p3'], m), 3)
      const req = join(tmp('req3'), 'req.txt')
      writeFileSync(req, 'x')
      await assert.rejects(main(['draft', 'd3', '--request', req], m), /lap cost cap/)
      assert.equal(calls, 0, f)
    } finally { saved ? writeFileSync(lap, saved) : unlinkSync(lap) }
  }
})

test('with the STOP file present every command but stop, serve (internal) and help refuses before doing anything', async () => {
  const f = process.env.FACTORY_STOP_FILE!
  writeFileSync(f, 'x')
  try {
    for (const argv of [['approve', 'v1', '--by', 'o', '--version', 'x'], ['observe'], ['probe-isolation', 'p9']]) {
      assert.equal(await main(argv, async () => { throw new Error('model called') }), 1, argv[0])
    }
    assert.ok(!existsSync(join(sd, 'prod', '8787', 'signals.json')), 'observe ran')
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

// Lap 8: drafters on the second family. The record shows, per call, which model each role was asked for,
// the counted calls apart from USD, and where a reused spec came from.
test('draft with the second family: per-call models, counted calls apart from USD, spec lineage', async () => {
  const req = join(tmp('req'), 'req.txt')
  writeFileSync(req, 'a memo api')
  const seen: [string, string | undefined][] = []
  const m = async (t: { role: string; model?: string }) => {
    seen.push([t.role, t.model])
    if (t.role === 'spec-drafter') return { ok: true, text: JSON.stringify({ spec: '# Memo\n\n## Undecided\n- status codes\n', interface: { endpoints: ['POST /notes'] }, assumptions: [] }), costUsd: null }
    if (t.role === 'scenario-drafter') return { ok: true, text: JSON.stringify({ scenarios: SCENARIOS, assumptions: [] }), costUsd: null }
    return { ok: false, text: '', costUsd: 0.1, error: 'classifier down', model: 'claude-opus-5-5' }
  }
  assert.equal(await main(['draft', 'xx-1', '--request', req, '--model', 'spec-drafter=gpt-6-astra', '--model', 'scenario-drafter=gpt-6-astra'], m), 0)
  assert.deepEqual(seen.slice(0, 3), [['spec-drafter', 'gpt-6-astra'], ['scenario-drafter', 'gpt-6-astra'], ['classifier', undefined]])
  const c = JSON.parse(readFileSync(join(sd, 'runs', 'xx-1', 'draft-cost.json'), 'utf8'))
  assert.equal(c.countedCalls, 2)
  assert.ok(Math.abs(c.totalUsd - 0.1 * SCENARIOS.length) < 1e-9) // the classifier only: the counted calls are $0, not a ceiling
  assert.deepEqual(c.uncounted, [])
  assert.deepEqual(c.calls.slice(0, 3).map((x: { role: string; requested: string }) => [x.role, x.requested]), [['spec-drafter', 'gpt-6-astra'], ['scenario-drafter', 'gpt-6-astra'], ['classifier', 'claude-opus-5-5']])
  assert.equal(c.specFrom, null)
  approve(sd, 'xx-1', { by: 't', version: hash(vaultDir(sd, 'xx-1')) })
  assert.equal(await main(['draft', 'xc-1', '--request', req, '--spec-from', 'xx-1'], m), 0)
  const r = JSON.parse(readFileSync(join(sd, 'runs', 'xc-1', 'draft-cost.json'), 'utf8'))
  assert.equal(r.specFrom, 'xx-1')
  assert.equal(r.countedCalls, 0)
  assert.equal(r.calls[0].requested, 'claude-opus-5-5')
  let calls = 0
  for (const argv of [['replicate', 'xx-1', '--k', '1', '--model', 'builder=gpt-6-astra'], ['probe-isolation', 'xx-1', '--model', 'judge=gpt-6-astra']]) {
    assert.equal(await main(argv, async () => { calls++; return { ok: true, text: '', costUsd: 0 } }), 2)
  }
  assert.equal(calls, 0)
})
