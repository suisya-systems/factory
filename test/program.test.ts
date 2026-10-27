// a command-line program as the app. The contract is declared in the spec, the scenarios have `run` steps, and the program runs in a
// sandbox of its own with a fresh working directory; its exit code, stdout, stderr and named files are checked like a response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model, Task } from '../src/adapter.ts'
import { approvalSummary, requestLines } from '../src/cli.ts'
import { predictInstruction, requestsOnly } from '../src/classify.ts'
import { checkContract, contractOf, loadDeps, RUN_LIMITS, usesRun, withRun, type Contract } from '../src/program.ts'
import { draft, runContract } from '../src/roles.ts'
import { get, judgeOpts, runScenario, validateScenarios, type Scenario } from '../src/scenario.ts'
import { undecidedItems } from '../src/classify.ts'
import { tmp } from './helpers.ts'

const never = new AbortController().signal
// The sandbox needs namespaces; where the host forbids them these tests of the isolation itself are skipped (the rest run through a stand-in).
const NAMESPACES = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', 'true']).status === 0

const CLI = `
const fs = require('node:fs'), path = require('node:path')
const [, , cmd, ...rest] = process.argv
if (cmd === 'echo') {
  let s = ''
  process.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(JSON.stringify({ args: rest, stdin: s, greeting: process.env.GREETING ?? null, files: fs.readdirSync('.').sort() })))
} else if (cmd === 'write') {
  fs.mkdirSync('out', { recursive: true })
  fs.writeFileSync('out/plan.json', JSON.stringify({ n: 1, from: fs.readFileSync(rest[0], 'utf8') }))
  console.error('wrote it')
  process.exit(3)
} else if (cmd === 'link') fs.symlinkSync('/etc/hostname', 'l.json')
else if (cmd === 'fifo') require('node:child_process').execFileSync('mkfifo', ['in.json'])
else if (cmd === 'spin') setInterval(() => {}, 1000)
else if (cmd === 'loud') process.stdout.write('x'.repeat(10000))
else if (cmd === 'poke') { try { fs.writeFileSync(path.join(__dirname, 'poked'), 'x'); process.stdout.write('"wrote"') } catch { process.stdout.write('"refused"') } }
else if (cmd === 'text') process.stdout.write('plain words\\n')
`
const CONTRACT: Contract = { command: ['node', '{app}/cli.cjs'] }
function app() {
  const d = tmp('prog')
  writeFileSync(join(d, 'cli.cjs'), CLI)
  return d
}
const sc = (steps: unknown[], summary = 'the program answers as the request describes'): Scenario => ({ id: 's', title: 't', summary, inSpec: true, kind: 'k', steps: steps as Scenario['steps'] })
const run = (steps: unknown[], o = { run: CONTRACT }, dir = app()) => runScenario(dir, sc(steps), never, o)

test('contract: a short argv, repository-relative python path, a lock hash; nothing else', () => {
  assert.deepEqual(checkContract({ command: ['python3', '-m', 'pkg.cli'], pythonPath: ['src'], deps: 'a'.repeat(64) }), { command: ['python3', '-m', 'pkg.cli'], pythonPath: ['src'], deps: 'a'.repeat(64) })
  for (const bad of [null, [], {}, { command: [] }, { command: ['/usr/bin/python3'] }, { command: ['python3', 'a b'] }, { command: ['python3'], pythonPath: ['../x'] }, { command: ['python3'], pythonPath: ['/abs'] },
    { command: ['python3'], deps: 'not-a-hash' }, { command: ['python3'], extra: 1 }, { command: Array(9).fill('x') }]) assert.throws(() => checkContract(bad), /contract/, JSON.stringify(bad))
})

test('contract in the spec: the section declares it, reads back as written, and leaves the Undecided points alone', () => {
  const spec = '# P\n- it prints\n\n## Undecided\n- the exit code on a bad flag'
  assert.equal(usesRun(spec), false)
  const withIt = withRun(spec, CONTRACT)
  assert.equal(usesRun(withIt), true)
  assert.deepEqual(contractOf(withIt), CONTRACT)
  assert.deepEqual(undecidedItems(withIt), undecidedItems(spec))
  assert.equal(withRun(withIt, CONTRACT), withIt, 'declaring it again changes nothing')
  assert.throws(() => withRun(withIt, { command: ['node'] }), /already declares another/)
  assert.throws(() => contractOf(spec), /declares no command-line contract/)
  assert.deepEqual(judgeOpts(withIt).run, CONTRACT)
  assert.equal(judgeOpts(spec).run, undefined)
})

test('a dependency set that is not built (or hidden from the sandboxes) is named, not guessed', () => {
  const was = process.env.FACTORY_DEPS
  try {
    process.env.FACTORY_DEPS = tmp('deps') // under /tmp: the sandboxes hide it
    assert.throws(() => loadDeps('a'.repeat(64)), /hidden from the sandboxes/)
    process.env.FACTORY_DEPS = '/opt/factory-deps-for-tests-only'
    assert.throws(() => loadDeps('a'.repeat(64)), /is not built/)
  } finally { if (was === undefined) delete process.env.FACTORY_DEPS; else process.env.FACTORY_DEPS = was }
})

test('the builder reads the contract: the command, the python path, and no server', () => {
  const spec = withRun('# P\n\n## Undecided\n- x', { command: ['python3', '-m', 'pkg.cli'], pythonPath: ['src'] })
  const c = runContract(spec)
  assert.match(c, /`python3 -m pkg\.cli <arguments of a check>`/)
  assert.match(c, /PYTHONPATH=<repository>\/src/)
  assert.match(c, /Standard library only/)
  assert.doesNotMatch(c, /npm start|HTTP server on/)
})

test('run steps validate: argv, stdin, files, read, env; one summary rule over their data', () => {
  const ok = { run: ['plan', '--in', 'task.json'], stdin: 'x', files: { 'task.json': { id: 'abc-123' }, 'sub/dir.txt': 'text' }, read: ['out/plan.json'], env: { GREETING: 'howdy' }, expect: { status: 0 }, capture: { id: 'stdout.id' } }
  assert.equal(validateScenarios([sc([ok])]).length, 1)
  const bad = (patch: object, re: RegExp) => assert.throws(() => validateScenarios([sc([{ ...ok, ...patch }])]), re, JSON.stringify(patch))
  bad({ extra: 1 }, /unknown field "extra"/)
  bad({ run: 'plan' }, /run must be a list/)
  bad({ run: [1] }, /run must be a list/)
  bad({ files: { '../x': 'y' } }, /files must map plain relative paths/)
  bad({ files: { '/abs': 'y' } }, /files must map plain relative paths/)
  bad({ read: ['a/../b'] }, /read must be a list of plain relative file paths/)
  bad({ env: { PATH: '/x' } }, /env must map upper-case/)
  bad({ env: { PYTHONPATH: '/x' } }, /env must map upper-case/)
  bad({ env: { lower: 'x' } }, /env must map upper-case/)
  bad({ stdin: 5 }, /stdin must be a string/)
  bad({ expect: undefined }, /expect must be an object/)
  bad({ method: 'GET' }, /unknown field "method"/)
  // the summary must not carry what the steps carry: a file path, a content value, an argument value; the sub-command words and flags are interface names
  const summary = (s: string) => () => validateScenarios([sc([ok], s)])
  assert.doesNotThrow(summary('the plan sub-command refuses a task without an id'))
  assert.throws(summary('reading task.json fails'), /concrete value from the steps \("task\.json"/)
  assert.throws(summary('the id abc-123 comes back'), /concrete value/)
  assert.throws(summary('the file out/plan.json is written'), /concrete value/)
  assert.throws(summary('the greeting howdy is passed on'), /concrete value/)
  // values hide in a flag's "=value" and in words with digits; a leading sub-command word and a bare flag do not count
  const argv = (run: string[], s: string) => () => validateScenarios([sc([{ run, expect: { status: 0 } }], s)])
  assert.throws(argv(['add', '--name=alice'], 'adding alice works'), /concrete value/)
  assert.throws(argv(['delegate-plan', 'w-10'], 'the w-10 pane is accepted'), /concrete value/)
  assert.doesNotThrow(argv(['delegate-plan', '--dry-run'], 'the delegate-plan sub-command takes a dry-run flag'))
})

// Codex review: a value like `greet alice` looks like two sub-command words; with the interface's command words only those are exempt.
test('the summary rule at draft time exempts the interface\'s command words only, so a positional value is data', () => {
  const words = new Set(['dispatcher', 'delegate-plan'])
  const one = (summary: string, run: string[], o?: { commandWords: Set<string> }) => () => validateScenarios([sc([{ run, expect: { status: 0 } }], summary)], o)
  assert.throws(one('greeting alice succeeds', ['greet', 'alice'], { commandWords: new Set(['greet']) }), /concrete value from the steps \("alice"/)
  assert.doesNotThrow(one('greeting succeeds', ['greet', 'alice'], { commandWords: new Set(['greet']) }))
  assert.doesNotThrow(one('the dispatcher delegate-plan command prints a plan', ['dispatcher', 'delegate-plan', '--dry-run'], { commandWords: words }))
  assert.throws(one('the pane in the plan is accepted', ['dispatcher', 'delegate-plan', 'pane'], { commandWords: words }), /concrete value/)
  assert.doesNotThrow(one('greeting alice succeeds', ['greet', 'alice'])) // a set re-read at approval has no interface at hand: the lenient rule, already held at draft
})

test('a key with dots (a file name in the envelope) is reached by its dot path', () => {
  const env = { stdout: { items: [1] }, files: { 'out/plan.json': { n: 7, a: { b: 1 } }, 'a.b': 'dotted' } }
  assert.equal(get(env, 'files.out/plan.json.n'), 7)
  assert.equal(get(env, 'files.out/plan.json.a.b'), 1)
  assert.equal(get(env, 'files.a.b'), 'dotted')
  assert.equal(get(env, 'stdout.items'), env.stdout.items)
  assert.equal(get(env, 'files.nope.json'), undefined)
  assert.equal(get({ constructor: 1 }, 'constructor.x'), undefined)
  assert.equal(get({ a: null }, 'a'), null)
})

test('a run: arguments, stdin, files and env go in; exit code, stdout, stderr and files come back as the response', async () => {
  const r = await run([
    { run: ['echo', 'a b', '--flag'], stdin: 'in text', files: { 'in.txt': 'hello', 'conf/c.json': { k: 1 } }, env: { GREETING: 'hey' },
      expect: { status: 0, json: { stdout: { args: ['a b', '--flag'], stdin: 'in text', greeting: 'hey', files: ['conf', 'in.txt'] }, stderr: '' }, length: { 'stdout.args': 2 } } },
  ])
  assert.equal(r.pass, true, r.detail)
})

test('the working directory lasts the scenario: a later run sees what an earlier one wrote; the exit code and stderr are checked', async () => {
  const r = await run([
    { run: ['write', 'in.txt'], files: { 'in.txt': 'seed' }, read: ['out/plan.json', 'missing.json'], expect: { status: [3], json: { stderr: 'wrote it\n', files: { 'out/plan.json': { n: 1, from: 'seed' } } }, jsonHas: ['files.out/plan.json'] }, capture: { n: 'files.out/plan.json.n' } },
    { run: ['echo'], expect: { status: 0, json: { stdout: { files: ['in.txt', 'out'] } } } },
    { run: ['echo', '{{n}}'], expect: { json: { stdout: { args: ['1'] } } } },
  ])
  assert.equal(r.pass, true, r.detail)
  const lacks = await run([{ run: ['write', 'in.txt'], files: { 'in.txt': 's' }, read: ['missing.json'], expect: { status: 3, jsonHas: ['files.missing.json'] } }])
  assert.equal(lacks.pass, false) // a file that was not written is absent
  assert.match(lacks.detail, /response missing files\.missing\.json/)
})

test('standard output that is not JSON is the text; a wrong exit code fails the step with the codes, not the output', async () => {
  const ok = await run([{ run: ['text'], expect: { status: 0, json: { stdout: 'plain words\n' } } }])
  assert.equal(ok.pass, true, ok.detail)
  const bad = await run([{ run: ['text'], expect: { status: 2 } }])
  assert.equal(bad.pass, false)
  assert.equal(bad.failedStep, 1)
  assert.match(bad.detail, /expected status 2, got 0/)
})

test('a path from a captured value cannot leave the working directory; a link the program made is not followed', async () => {
  const dotdot = await run([{ run: ['echo'], stdin: '../escape.txt', expect: { status: 0 }, capture: { p: 'stdout.stdin' } }, { run: ['echo'], files: { '{{p}}': 'x' }, expect: { status: 0 } }])
  assert.equal(dotdot.pass, false)
  assert.match(dotdot.detail, /not a plain relative file path/)
  const link = await run([{ run: ['link'], expect: { status: 0 } }, { run: ['echo'], read: ['l.json'], expect: { status: 0 } }])
  assert.equal(link.pass, false)
  assert.match(link.detail, /made a link/)
})

// A FIFO left where a later step writes a file would block the factory process itself (an open for writing waits for a reader), past every timer.
test('a FIFO the program left where a file is to be written is refused, not opened', { timeout: 20_000 }, async () => {
  const r = await run([{ run: ['fifo'], expect: { status: 0 } }, { run: ['echo'], files: { 'in.json': { a: 1 } }, expect: { status: 0 } }])
  assert.equal(r.pass, false)
  assert.equal(r.failedStep, 2)
  assert.match(r.detail, /in\.json is not a plain file/)
})

test('a program that never ends, or prints without end, is stopped and the step says so', async () => {
  const was = { ...RUN_LIMITS }
  try {
    RUN_LIMITS.timeoutMs = 600
    const spin = await run([{ run: ['spin'], expect: { status: 0 } }])
    assert.equal(spin.pass, false)
    assert.match(spin.detail, /the program was stopped: timeout after 600ms/)
    RUN_LIMITS.outChars = 1000
    const loud = await run([{ run: ['loud'], expect: { status: 0 } }])
    assert.equal(loud.pass, false)
    assert.match(loud.detail, /more than 1000 characters of output/)
  } finally { Object.assign(RUN_LIMITS, was) }
})

test('too many files, or too large a file, are refused before the program starts', async () => {
  const many = await run([{ run: ['echo'], files: Object.fromEntries(Array.from({ length: RUN_LIMITS.files }, (_, i) => [`f${i}.txt`, 'x'])), expect: { status: 0 } }])
  assert.equal(many.pass, true, many.detail)
  assert.throws(() => validateScenarios([sc([{ run: ['echo'], files: Object.fromEntries(Array.from({ length: RUN_LIMITS.files + 1 }, (_, i) => [`f${i}.txt`, 'x'])), expect: { status: 0 } }])]), /files must map/)
  assert.throws(() => validateScenarios([sc([{ run: ['echo'], files: { 'big.txt': 'x'.repeat(RUN_LIMITS.fileChars + 1) }, expect: { status: 0 } }])]), /files must map/)
})

test('one kind of step per spec: a run needs the declared program, a program takes no HTTP step', async () => {
  const undeclared = await runScenario(app(), sc([{ run: ['echo'], expect: { status: 0 } }]), never, {})
  assert.equal(undeclared.pass, false)
  assert.match(undeclared.detail, /declares no command-line program/)
  const http = await run([{ method: 'GET', path: '/x', expect: { status: 200 } }])
  assert.equal(http.pass, false)
  assert.match(http.detail, /run steps only/)
})

test('no server is started for a program: a scenario of run steps needs no package.json and no port', async () => {
  const d = app() // cli.cjs only
  const r = await run([{ run: ['echo'], expect: { status: 0 } }], { run: CONTRACT }, d)
  assert.equal(r.pass, true, r.detail)
})

test('isolation: the repository is read-only for the program', { skip: !NAMESPACES && 'needs namespaces' }, async () => {
  const r = await run([{ run: ['poke'], expect: { status: 0, json: { stdout: 'refused' } } }])
  assert.equal(r.pass, true, r.detail)
})

test('the classifier and the approval summary read a run step as a program run', () => {
  const s = sc([{ run: ['plan', '--in', 'task.json'], stdin: 'in', files: { 'task.json': { id: 'abc' } }, read: ['out.json'], env: { GREETING: 'hi' }, expect: { status: 0, json: { stdout: { ok: true } } } }])
  assert.deepEqual(Object.keys(requestsOnly(s)[0]).filter((k) => (requestsOnly(s)[0] as Record<string, unknown>)[k] !== undefined).sort(), ['env', 'files', 'read', 'run', 'stdin'])
  const instruction = predictInstruction('# P\n\n## Undecided\n- x', '', s)
  assert.match(instruction, /A request with "run" is not an HTTP request/)
  assert.doesNotMatch(predictInstruction('# P\n\n## Undecided\n- x', '', sc([{ method: 'GET', path: '/x', expect: { status: 200 } }])), /A request with "run"/)
  const lines = requestLines(s).join('\n')
  assert.match(lines, /1\. run \["plan","--in","task\.json"\]/)
  assert.match(lines, /file task\.json: \{"id":"abc"\}/)
  assert.match(lines, /env GREETING=hi/)
  const spec = withRun('# P\n\n## Undecided\n- x', { command: ['python3', '-m', 'pkg'], deps: 'b'.repeat(64) })
  const md = approvalSummary('x', { spec, scenarios: [s], assumptions: [], classification: [{ id: 's', label: 'unstated', checks: [{ step: 1, check: 'json', result: 'U', basis: 'spec' }] }] }, 'v')
  assert.match(md, /Command-line program: runs as `python3 -m pkg`, dependency set b{64}/)
  assert.match(md, /step 1 run json/)
})

// ---- the drafters ----
function fakeDrafters(scenario: (n: number) => unknown, seen: Task[] = []): Model {
  let tries = 0
  return async (t) => {
    seen.push(t)
    const reply = t.role === 'spec-drafter' ? { spec: '# P\n- the program prints a plan\n\n## Undecided\n- the exit code on a bad flag', interface: { commands: ['dispatcher plan'], flags: { 'dispatcher plan': ['--task-json', '--dry-run'] }, files: ['task.json', 'out/plan.json'], fields: { plan: ['id', 'items[].name'] } }, assumptions: [] }
      : t.role === 'scenario-drafter' ? scenario(tries++)
        : { steps: [{ status: [0], body: { stdout: { ok: true } }, basis: 'convention', quote: '' }] }
    return { ok: true, costUsd: 0.1, text: JSON.stringify(reply) }
  }
}
const GOOD = { scenarios: [{ id: 'plan-ok', title: 'plan', summary: 'the plan sub-command prints a plan', inSpec: true, kind: 'main', steps: [{ run: ['dispatcher', 'plan', '--task-json', 'task.json'], files: { 'task.json': { id: 'a1' } }, expect: { status: 0, json: { stdout: { ok: true } } } }] }], assumptions: [] }
const HTTP = { scenarios: [{ id: 'plan-http', title: 'plan', summary: 'the plan sub-command prints a plan', inSpec: true, kind: 'main', steps: [{ method: 'GET', path: '/plan', expect: { status: 200 } }] }], assumptions: [] }

test('draft with a contract: the spec declares the program, both drafters are told so, and every step is a run', async () => {
  const seen: Task[] = []
  const d = await draft(fakeDrafters(() => GOOD, seen), 'a dispatcher plan command', { run: CONTRACT })
  assert.equal(usesRun(d.spec), true)
  assert.deepEqual(contractOf(d.spec), CONTRACT)
  const specTask = seen.find((t) => t.role === 'spec-drafter')!, scenTask = seen.find((t) => t.role === 'scenario-drafter')!
  assert.match(specTask.instruction, /\(command-line program\)/)
  assert.match(specTask.instruction, /"commands": \["<command words>"/)
  assert.match(scenTask.instruction, /\(command-line program\)/)
  assert.match(scenTask.instruction, /"run": \["<argument>"/)
  assert.match(scenTask.instruction, /So "expect" and "capture" work as for an HTTP response/)
  assert.doesNotMatch(scenTask.instruction, /"method": "GET\|POST/)
  assert.match(d.assumptions[0], /"commands":\["dispatcher plan"\]/)
  assert.equal(d.classification?.[0].label, 'readable')
  assert.match(seen.find((t) => t.role === 'classifier')!.instruction, /A request with "run" is not an HTTP request/)
})

test('draft with a contract: a summary naming a positional argument value is sent back (the interface says which words are commands)', async () => {
  const seen: Task[] = []
  const leaky = { scenarios: [{ ...GOOD.scenarios[0], summary: 'the plan sub-command prints the plan for tokyo', steps: [{ run: ['dispatcher', 'plan', 'tokyo'], expect: { status: 0 } }] }], assumptions: [] }
  const fixed = { scenarios: [{ ...leaky.scenarios[0], summary: 'the plan sub-command prints a plan for the place' }], assumptions: [] }
  let n = 0
  const d = await draft(fakeDrafters(() => (n++ === 0 ? leaky : fixed), seen), 'r', { run: CONTRACT })
  assert.equal(n, 2) // the first reply was rejected once
  assert.equal(d.scenarios[0].summary, 'the plan sub-command prints a plan for the place')
})

test('draft with a contract: a scenario with an HTTP step is sent back once, then refused; without a contract a run step is refused', async () => {
  let n = 0
  const repaired = await draft(fakeDrafters(() => (n++ === 0 ? HTTP : GOOD)), 'r', { run: CONTRACT })
  assert.equal(repaired.scenarios[0].id, 'plan-ok')
  await assert.rejects(draft(fakeDrafters(() => HTTP), 'r', { run: CONTRACT }), /every step of a command-line program is a "run" step/)
  await assert.rejects(draft(fakeDrafters(() => GOOD), 'r'), /a "run" step needs a spec that declares a command-line program/)
})

test('a program does not go with a service or browser pages, however the spec came about', async () => {
  const ui = '# P\n\n## Undecided\n- x\n\n## Browser UI (factory)\n\nx\n'
  await assert.rejects(draft(fakeDrafters(() => GOOD), 'r', { run: CONTRACT, reuse: { body: ui, iface: '{"commands":["a"]}' } }), /does not go with an external service or browser pages/)
})

test('the interface of a program: command words, flags per command, file names; names only', async () => {
  const bad = (iface: unknown) => draft(async (t) => ({ ok: true, costUsd: 0, text: JSON.stringify(t.role === 'spec-drafter' ? { spec: '# P\n\n## Undecided\n- x', interface: iface, assumptions: [] } : GOOD) }), 'r', { run: CONTRACT })
  await assert.rejects(bad({ commands: ['Plan It'] }), /commands must be lists of bare command words/)
  await assert.rejects(bad({ flags: { 'a b': ['dry-run'] } }), /flags\["a b"\] must be a list of flag names/)
  await assert.rejects(bad({ flags: ['--x'] }), /flags must be an object/)
  await assert.rejects(bad({ files: ['/etc/passwd'] }), /files must be plain file names/)
  await assert.rejects(bad({ commands: ['plan'], fields: { x: ['exit 404'] } }), /interface/)
})
