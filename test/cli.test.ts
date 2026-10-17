// CLI paths that spend money must record it, and approval binds to the version the owner read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { approve, hash, writeDraft } from '../src/vault.ts'
import { freshState, SCENARIOS, tmp } from './helpers.ts'

const sd = freshState()
process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')

test('a failed drafter still records its spend', async () => {
  const req = join(tmp('req'), 'req.txt')
  writeFileSync(req, 'a memo api')
  await assert.rejects(main(['draft', 'd1', '--request', req], async () => ({ ok: true, text: 'sorry', costUsd: 2 })), /no parseable JSON/)
  assert.equal(JSON.parse(readFileSync(join(sd, 'runs', 'd1', 'draft-cost.json'), 'utf8')).totalUsd, 2)
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
