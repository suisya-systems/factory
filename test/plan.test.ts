// #18: a request too big for one change, split into approved parts, built in order, and checked as a whole. Fake model only.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Model, Task } from '../src/adapter.ts'
import { main } from '../src/cli.ts'
import { checkWithin } from '../src/roles.ts'
import { MAX_PARTS, validateParts } from '../src/plan.ts'
import { freePort } from '../src/sandbox.ts'
import { stopServer } from '../src/ship.ts'
import { hash, vaultDir, writeDraft } from '../src/vault.ts'
import { freshState, gitTarget, MEMO_SERVER, SCENARIOS, tmp, writeApp } from './helpers.ts'

const homes: string[] = []
after(() => homes.forEach((h) => stopServer(h)))

const PARTS = [{ id: 'create', title: 'create notes', request: 'part one request' }, { id: 'edit', title: 'edit notes', request: 'part two request' }, { id: 'list', title: 'list notes', request: 'part three request' }]
const IFACE = { endpoints: ['POST /notes', 'GET /notes', 'PUT /notes/{id}'] }
// A scenario no memo server satisfies: the whole request fails although every part passes its own scenarios.
const IMPOSSIBLE = { id: 'whole-only', title: 'whole only', summary: 'a check only the whole request makes', inSpec: true, kind: 'crud', steps: [{ method: 'GET', path: '/notes/never-there', expect: { status: 200 } }] }

// server: the app a builder writes for a change id (default: a correct memo server); builderOk: whether its call succeeds
type Opts = { parts?: unknown; wholeScenarios?: typeof SCENARIOS; specIface?: unknown; server?: (id: string) => string; builderOk?: (id: string) => boolean }
async function harness(o: Opts = {}) {
  const sd = freshState()
  homes.push(sd)
  process.env.FACTORY_STOP_FILE = join(sd, 'NOSTOP')
  const target = gitTarget(), port = await freePort(), plan = 'pl'
  const req = join(tmp('req'), 'req.md')
  writeFileSync(req, 'WHOLE REQUEST: a memo api')
  const log: { role: string; instruction: string; workdir: string }[] = []
  const model: Model = async (t) => {
    log.push({ role: t.role, instruction: t.instruction, workdir: t.workdir })
    if (t.role === 'splitter') return { ok: true, text: JSON.stringify({ parts: o.parts ?? PARTS }), costUsd: 0.1 }
    if (t.role === 'spec-drafter') return { ok: true, text: JSON.stringify({ spec: '# Memo\n\n## Undecided\n- status codes\n', interface: t.instruction.includes('PLAN INTERFACE') ? (o.specIface ?? { endpoints: ['POST /notes'] }) : IFACE, assumptions: [] }), costUsd: 0.1 }
    if (t.role === 'scenario-drafter') return { ok: true, text: JSON.stringify({ scenarios: t.instruction.includes('WHOLE REQUEST') ? (o.wholeScenarios ?? SCENARIOS) : SCENARIOS, assumptions: [] }), costUsd: 0.1 }
    if (t.role === 'classifier') return { ok: false, text: '', costUsd: 0.01, error: 'down' }
    if (t.role === 'builder') {
      const id = t.workdir.split('/').pop()!
      const ok = o.builderOk?.(id) ?? true
      if (ok) writeApp(t.workdir, o.server?.(id) ?? MEMO_SERVER)
      return { ok, text: 'built', costUsd: 0.1, ...(ok ? {} : { error: 'builder down' }) }
    }
    return { ok: true, text: '{"pass": true, "reason": "fine"}', costUsd: 0.05 }
  }
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await f() } finally { console.log = l; console.error = e } }
  const cli = (argv: string[]) => quiet(() => main(argv, model))
  const planArgs = (extra: string[] = []) => ['plan', plan, '--ship-target', target, '--port', String(port), '--max-attempts', '2', ...extra]
  const result = () => JSON.parse(readFileSync(join(sd, 'runs', `${plan}.plan`, 'result.json'), 'utf8'))
  const approveWaiting = async () => { const id = result().reason.replace('approve ', ''); assert.equal(await cli(['approve', id, '--by', 't', '--version', hash(vaultDir(sd, id))]), 0); return id }
  const split = async () => { assert.equal(await cli(['split', plan, '--request', req]), 0) }
  const approvePlan = () => cli(['approve', plan, '--by', 't', '--version', readFileSync(join(sd, 'runs', `${plan}.plan`, 'plan-summary.md'), 'utf8').match(/Version: (\w+)/)![1]])
  const count = (role: string) => log.filter((l) => l.role === role).length
  const head = () => execFileSync('git', ['-C', target, 'rev-parse', 'HEAD']).toString().trim()
  const builds = (id: string) => log.filter((l) => l.role === 'builder' && l.workdir.endsWith(`/${id}`)).length
  return { sd, target, builds, port, plan, req, log, model, cli, planArgs, result, approveWaiting, split, approvePlan, count, head }
}
// plan -> approve the part it waits for -> plan ... until it stops for something else. Returns the last exit code.
async function drive(h: Awaited<ReturnType<typeof harness>>, extra: string[] = []): Promise<number> {
  for (;;) {
    const code = await h.cli(h.planArgs(extra))
    if (code !== 3) return code
    await h.approveWaiting()
  }
}

test('validateParts: the splitter cannot name parts that clash with the plan\'s own change ids', () => {
  const p = (...ids: string[]) => ids.map((id) => ({ id, title: 't', request: 'r' }))
  assert.equal(validateParts(p('a', 'b'), 'pl').length, 2)
  assert.throws(() => validateParts(p('a'), 'pl'), /needs 2 to 6 parts/)
  assert.throws(() => validateParts(p(...Array.from({ length: MAX_PARTS + 1 }, (_, i) => `p${i}`)), 'pl'), /needs 2 to 6 parts/)
  assert.throws(() => validateParts(p('a', 'whole'), 'pl'), /not "whole"/)
  assert.throws(() => validateParts(p('a', 'b-r2'), 'pl'), /end in "-r<number>"/)
  assert.throws(() => validateParts(p('a', 'a'), 'pl'), /appears twice/)
  assert.throws(() => validateParts(p('a', 'B_x'), 'pl'), /lower-case words/)
  assert.throws(() => validateParts([{ id: 'a', title: 't', request: ' ' }, ...p('b')], 'pl'), /empty title or request/)
  assert.throws(() => validateParts(p('a', 'x'.repeat(59)), 'pl'), /bad change id/) // 'pl-' + 58 + '-r4' is longer than 64
})

test('checkWithin: a part may use fewer names than the plan interface, never more or different', () => {
  const plan = { endpoints: ['POST /notes', 'GET /notes'], fields: { note: ['title'] }, listShape: 'bare array' }
  checkWithin({ endpoints: ['POST /notes'] }, plan)
  checkWithin({ fields: { note: ['title'] }, listShape: 'bare array' }, plan)
  assert.throws(() => checkWithin({ endpoints: ['DELETE /notes'] }, plan), /outside the plan's interface: DELETE \/notes/)
  assert.throws(() => checkWithin({ fields: { note: ['body'] } }, plan), /note\.body/)
  assert.throws(() => checkWithin({ listShape: ['items'] }, plan), /list:/)
  checkWithin({ conflictToken: { name: 'ETag', in: 'header' } }, { conflictToken: { in: 'header', name: 'ETag' } }) // key order is not a difference
  assert.throws(() => checkWithin({ conflictToken: { in: 'body', name: 'ETag' } }, { conflictToken: { in: 'header', name: 'ETag' } }), /token:/)
})

test('a split request is approved once, built part by part on the shipped app, and verified as a whole', async () => {
  const h = await harness()
  await h.split()
  assert.deepEqual(h.log.map((l) => l.role).slice(0, 2), ['splitter', 'spec-drafter']) // the whole is drafted after the split, as an ordinary change
  assert.ok(existsSync(join(vaultDir(h.sd, 'pl-whole'), 'spec.md')))
  await assert.rejects(h.cli(h.planArgs()), /plan pl is not approved/)
  assert.equal(h.count('builder'), 0)
  await assert.rejects(h.cli(['approve', 'pl', '--by', 't', '--version', '0'.repeat(64)]), /not the version you reviewed/)
  assert.equal(await h.approvePlan(), 0)
  assert.ok(existsSync(join(vaultDir(h.sd, 'pl-whole'), 'approval.json'))) // one act approved the whole draft too

  const head0 = h.head()
  assert.equal(await h.cli(h.planArgs()), 3) // part 1 drafted, waiting
  assert.equal(h.count('builder'), 0)
  assert.equal(h.head(), head0)
  assert.equal(await h.approveWaiting(), 'pl-create')
  assert.equal(await h.cli(h.planArgs()), 3) // part 1 shipped, part 2 drafted against it
  assert.notEqual(h.head(), head0)
  const spec2 = h.log.filter((l) => l.role === 'spec-drafter').at(-1)!.instruction
  assert.match(spec2, /PLAN INTERFACE/)
  assert.match(spec2, /EXISTING APP[\s\S]*server\.cjs/) // part 2 is drafted against what part 1 shipped
  assert.equal(await h.approveWaiting(), 'pl-edit')
  assert.equal(await h.cli(h.planArgs()), 3)
  assert.equal(await h.approveWaiting(), 'pl-list')
  const buildsBefore = h.count('builder')
  assert.equal(await h.cli(h.planArgs()), 0)
  assert.equal(h.count('builder'), buildsBefore + 1)
  const r = h.result()
  assert.equal(r.status, 'done')
  assert.deepEqual(r.parts.map((p: { status: string }) => p.status), ['shipped', 'shipped', 'shipped'])
  assert.deepEqual(r.whole, { sha: h.head(), pass: true, passed: SCENARIOS.length, total: SCENARIOS.length })
  // finished: calling again changes nothing
  const calls = h.log.length
  assert.equal(await h.cli(h.planArgs()), 0)
  assert.equal(h.log.length, calls)
  execFileSync('git', ['-C', h.target, 'merge-base', '--is-ancestor', head0, h.head()]) // the parts built on one history
})

test('approval binds to what was read: a changed whole draft or plan after the summary is refused', async () => {
  const h = await harness()
  await h.split()
  const version = readFileSync(join(h.sd, 'runs', 'pl.plan', 'plan-summary.md'), 'utf8').match(/Version: (\w+)/)![1]
  writeDraft(h.sd, 'pl-whole', { spec: 'swapped', scenarios: SCENARIOS.slice(0, 1), assumptions: [] }) // re-drafted after the owner read it
  await assert.rejects(h.cli(['approve', 'pl', '--by', 't', '--version', version]), /not the version you reviewed/)
  assert.ok(!existsSync(join(vaultDir(h.sd, 'pl-whole'), 'approval.json')))
  assert.ok(!existsSync(join(h.sd, 'runs', 'pl.plan', 'plan-approval.json')))
  // a plan edited after its approval stops the build
  const h2 = await harness()
  await h2.split()
  assert.equal(await h2.approvePlan(), 0)
  const f = join(h2.sd, 'runs', 'pl.plan', 'plan.json')
  chmodSync(f, 0o644)
  writeFileSync(f, readFileSync(f, 'utf8').replace('part two request', 'something else'))
  await assert.rejects(h2.cli(h2.planArgs()), /modified after approval/)
  assert.equal(h2.count('builder'), 0)
})

test('a part whose interface goes beyond the plan\'s is refused at its draft', async () => {
  const h = await harness({ specIface: { endpoints: ['POST /notes', 'GET /secret'] } })
  await h.split()
  assert.equal(await h.approvePlan(), 0)
  await assert.rejects(h.cli(h.planArgs()), /outside the plan's interface: GET \/secret/)
  assert.equal(h.result().status, 'failed')
  assert.equal(h.count('builder'), 0)
})

// plan name taken: a plan `a-b` with part `c` and a plan `a` with part `b-c` would both own the change `a-b-c`
test('a split whose change ids are already used is refused before the whole is drafted', async () => {
  const h = await harness()
  writeDraft(h.sd, 'pl-create', { spec: 's', scenarios: SCENARIOS, assumptions: [] }) // an ordinary change with the name of part 1
  assert.equal(await h.cli(['split', 'pl', '--request', h.req]).catch((e) => e.message), 'plan pl: change id pl-create is already used; choose another plan name')
  assert.equal(h.count('spec-drafter'), 0)
})

// A server that fails the scenarios (no update, wrong not-found): a real verdict, not an error.
const BROKEN = MEMO_SERVER.replace("if (req.method === 'PUT')", 'if (false)')
const ready = async (o: Opts) => { const h = await harness(o); await h.split(); assert.equal(await h.approvePlan(), 0); return h }

test('a rejected middle part is retried once as a new change with the same approved version, then the plan stops; part 3 never starts', async () => {
  const h = await ready({ server: (id) => (id.startsWith('pl-edit') ? BROKEN : MEMO_SERVER) })
  assert.equal(await drive(h), 1)
  const r = h.result()
  assert.match(r.reason, /part edit rejected in 2 tries; the later parts were not started/)
  assert.deepEqual(r.parts.map((p: { status: string }) => p.status), ['shipped', 'failed', 'pending'])
  assert.deepEqual(r.parts[1].changeIds, ['pl-edit', 'pl-edit-r2'])
  assert.equal(h.builds('pl-edit'), 2) // --max-attempts 2
  assert.equal(h.builds('pl-edit-r2'), 2)
  assert.equal(h.builds('pl-list'), 0)
  assert.ok(!existsSync(vaultDir(h.sd, 'pl-list')), 'part 3 was not even drafted')
  const rec = (id: string) => JSON.parse(readFileSync(join(h.sd, 'runs', id, 'run.json'), 'utf8'))
  assert.equal(rec('pl-edit-r2').approvedVersion, rec('pl-edit').approvedVersion)
  assert.equal(rec('pl-edit-r2').status, 'failed')
})

test('the retry that passes ships; --retries 0 stops at the first rejection', async () => {
  const h = await ready({ server: (id) => (id === 'pl-edit' ? BROKEN : MEMO_SERVER) })
  assert.equal(await drive(h), 0)
  assert.deepEqual(h.result().parts[1].changeIds, ['pl-edit', 'pl-edit-r2'])
  assert.equal(h.result().whole.pass, true)
  const z = await ready({ server: (id) => (id === 'pl-edit' ? BROKEN : MEMO_SERVER) })
  assert.equal(await drive(z, ['--retries', '0']), 1)
  assert.equal(z.builds('pl-edit-r2'), 0)
})

test('a failure that is not a verdict (the builder call itself fails) is not retried', async () => {
  const h = await ready({ builderOk: (id) => id !== 'pl-create' }) // part 1 starts from nothing: no app, a real failure
  assert.equal(await drive(h), 1)
  assert.match(h.result().reason, /not a verdict: not retried/)
  assert.equal(h.builds('pl-create-r2'), 0)
  assert.equal(h.builds('pl-create'), 2)
})

test('a run left "running" (the process died, maybe after the deploy) halts the plan instead of building again', async () => {
  const h = await ready({})
  assert.equal(await h.cli(h.planArgs()), 3)
  await h.approveWaiting()
  mkdirSync(join(h.sd, 'runs', 'pl-create'), { recursive: true })
  writeFileSync(join(h.sd, 'runs', 'pl-create', 'run.json'), JSON.stringify({ status: 'running', stopReason: '', shipped: null, attempts: [] }))
  assert.equal(await h.cli(h.planArgs()), 1)
  assert.match(h.result().reason, /pl-create was interrupted/)
  assert.equal(h.count('builder'), 0)
})

test('the ship target moving between parts stops the plan', async () => {
  const h = await ready({})
  assert.equal(await h.cli(h.planArgs()), 3)
  await h.approveWaiting() // part 1
  assert.equal(await h.cli(h.planArgs()), 3) // part 1 shipped, part 2 drafted
  await h.approveWaiting() // part 2
  const g = (...a: string[]) => execFileSync('git', ['-C', h.target, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  g('commit', '-q', '--allow-empty', '-m', 'someone else')
  const builds = h.count('builder')
  assert.equal(await h.cli(h.planArgs()), 1)
  assert.match(h.result().reason, /the ship target is not at/)
  assert.equal(h.count('builder'), builds)
})

test('resuming with another ship target or port is refused', async () => {
  const h = await ready({})
  assert.equal(await h.cli(h.planArgs()), 3)
  await assert.rejects(h.cli(['plan', 'pl', '--ship-target', gitTarget(), '--port', String(h.port)]), /resume with the same/)
  await assert.rejects(h.cli(['plan', 'pl', '--ship-target', h.target, '--port', String(h.port + 1)]), /resume with the same/)
})

test('the whole request failing after every part passed fails the plan, and is not re-run', async () => {
  const h = await ready({ wholeScenarios: [...SCENARIOS, IMPOSSIBLE] })
  assert.equal(await drive(h), 1)
  const r = h.result()
  assert.match(r.reason, /all parts shipped but the whole request fails: whole-only/)
  assert.deepEqual(r.parts.map((p: { status: string }) => p.status), ['shipped', 'shipped', 'shipped'])
  assert.deepEqual([r.whole.passed, r.whole.total], [SCENARIOS.length, SCENARIOS.length + 1])
  const calls = h.log.length
  assert.equal(await h.cli(h.planArgs()), 1) // the verdict stands
  assert.equal(h.log.length, calls)
})

test('--retries outside 0..3 is refused before any build', async () => {
  const h = await ready({})
  await assert.rejects(h.cli(h.planArgs(['--retries', '9'])), /--retries must be an integer from 0 to 3/)
  assert.equal(h.count('builder'), 0)
})

test('invalid --max-cost / --max-attempts are refused before any draft, never replaced by the default', async () => {
  const h = await ready({})
  const calls = h.log.length
  await assert.rejects(h.cli(h.planArgs(['--max-cost', '0'])), /max cost must be a positive number/)
  await assert.rejects(h.cli(h.planArgs(['--max-cost', '10usd'])), /max cost must be a positive number/)
  await assert.rejects(h.cli(h.planArgs(['--max-attempts', '0'])), /max attempts must be an integer >= 1/)
  assert.equal(h.log.length, calls)
})

test('an ordinary draft that took a reserved part id is not built', async () => {
  const h = await ready({})
  const other = join(tmp('req'), 'other.md')
  writeFileSync(other, 'a different request')
  assert.equal(await h.cli(['draft', 'pl-create', '--request', other]), 0) // no --iface-from, not the plan's request
  assert.equal(await h.cli(h.planArgs()), 3) // an unapproved draft: waiting
  assert.equal(await h.approveWaiting(), 'pl-create')
  assert.equal(await h.cli(h.planArgs()), 1)
  assert.match(h.result().reason, /was not drafted from the plan's request for part create/)
  assert.equal(h.count('builder'), 0)
})

test('an ordinary change that took a part id and shipped is not counted as the part', async () => {
  const h = await ready({})
  const other = join(tmp('req'), 'other.md')
  writeFileSync(other, 'a different request')
  assert.equal(await h.cli(['draft', 'pl-create', '--request', other]), 0)
  assert.equal(await h.cli(['approve', 'pl-create', '--by', 't', '--version', hash(vaultDir(h.sd, 'pl-create'))]), 0)
  assert.equal(await h.cli(['run', 'pl-create', '--ship-target', h.target, '--port', String(h.port), '--max-attempts', '2']), 0) // shipped by hand
  const builds = h.count('builder')
  assert.equal(await h.cli(h.planArgs()), 1)
  assert.match(h.result().reason, /pl-create was not drafted from the plan's request for part create/)
  assert.equal(h.count('builder'), builds)
})

test('a plan name that is already a change id (or a part of another plan) is refused', async () => {
  const h = await ready({})
  const other = join(tmp('req'), 'o.md')
  writeFileSync(other, 'WHOLE REQUEST again')
  // plan "pl-create" would shadow part 1 of plan "pl": `approve pl-create` could then never approve that part
  await assert.rejects(h.cli(['split', 'pl-create', '--request', other]), /change id pl-create is already used/)
  assert.ok(!existsSync(join(h.sd, 'runs', 'pl-create.plan', 'plan.json'))) // only the splitter's cost record is left
})
