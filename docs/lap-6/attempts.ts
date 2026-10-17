// Lap 6 tally (no model call): per run and attempt, how many scenarios passed, split into the verified minority
// scenarios (prereg.json) and the rest; then each run's class and the verdict, by the lines fixed in the runbook.
// usage: node --experimental-strip-types --no-warnings docs/lap-6/attempts.ts <prereg.json> <STATE>
//        node --experimental-strip-types --no-warnings docs/lap-6/attempts.ts --self-test
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Attempt = { n: number; testsAllPass: boolean; llmPass: boolean | null; pass: boolean; results: { id: string; pass: boolean }[] }
type Run = { changeId: string; status: string; stopReason: string; attempts: Attempt[] }
export type Prereg = { maxAttempts: number; sets: Record<string, { runs: string[]; minority: string[] }> }

const passed = (a: Attempt, ids: Set<string>, inside: boolean) => a.results.filter((r) => r.pass && ids.has(r.id) === inside).length

// P1: attempt 1 already passes every minority scenario (the retry loop is not exercised on them).
// CONV: some later attempt passes them all. INCOMPLETE: stopped (cost cap, stop, error) before the last attempt.
// NEAR: more minority passes at the last attempt than at the first, and no fewer of the others. STUCK: the rest.
export function classOf(r: Run, minority: string[], maxAttempts: number): string {
  const m = new Set(minority), all = (a: Attempt) => passed(a, m, true) === m.size
  const [first, last] = [r.attempts[0], r.attempts.at(-1)]
  if (!first) return 'INCOMPLETE'
  if (all(first)) return 'P1'
  if (r.attempts.some(all)) return 'CONV'
  if (r.attempts.length < maxAttempts) return 'INCOMPLETE'
  return passed(last!, m, true) > passed(first, m, true) && passed(last!, m, false) >= passed(first, m, false) ? 'NEAR' : 'STUCK'
}

// Over the exercised, complete runs (CONV / NEAR / STUCK): more than half CONV -> supported, more than half STUCK ->
// not supported, else undecided; fewer than 3 such runs -> undecided.
export function verdict(classes: string[]): string {
  const ex = classes.filter((c) => ['CONV', 'NEAR', 'STUCK'].includes(c))
  if (ex.length < 3) return `undecided (${ex.length} exercised complete runs)`
  const n = (c: string) => ex.filter((x) => x === c).length
  return n('CONV') * 2 > ex.length ? 'supported' : n('STUCK') * 2 > ex.length ? 'not supported' : 'undecided'
}

function report(p: Prereg, sd: string): string {
  const lines: string[] = [], all: string[] = []
  for (const [set, s] of Object.entries(p.sets)) {
    const m = new Set(s.minority), classes: string[] = []
    lines.push(`## ${set} (minority: ${s.minority.join(', ')})`, '', '| run | attempt | all tests | minority | others | LLM | pass | failed |', '|---|---|---|---|---|---|---|---|')
    for (const id of s.runs) {
      const f = join(sd, 'runs', id, 'run.json')
      if (!existsSync(f)) { lines.push(`| ${id} | **not started** | | | | | | |`); continue } // a lap cap or stop ended the lap first: not counted
      const r: Run = JSON.parse(readFileSync(f, 'utf8'))
      for (const a of r.attempts) {
        const others = a.results.filter((x) => !m.has(x.id)).length
        lines.push(`| ${id} | ${a.n} | ${a.results.filter((x) => x.pass).length}/${a.results.length} | ${passed(a, m, true)}/${m.size} | ${passed(a, m, false)}/${others} | ${a.llmPass} | ${a.pass} | ${a.results.filter((x) => !x.pass).map((x) => x.id).join(', ')} |`)
      }
      const c = classOf(r, s.minority, p.maxAttempts)
      classes.push(c)
      lines.push(`| ${id} | **${c}** | status ${r.status} | | | | | ${r.stopReason} |`)
    }
    all.push(...classes)
    lines.push('', `${set}: ${verdict(classes)}`, '')
  }
  lines.push(`All sets: ${verdict(all)}`)
  return lines.join('\n')
}

function selfTest() {
  const at = (n: number, pass: Record<string, boolean>): Attempt => ({ n, testsAllPass: false, llmPass: null, pass: false, results: Object.entries(pass).map(([id, p]) => ({ id, pass: p })) })
  const run = (...as: Attempt[]): Run => ({ changeId: 'x', status: 'failed', stopReason: '', attempts: as })
  const m = ['a', 'b']
  assert.equal(classOf(run(at(1, { a: true, b: true, c: false })), m, 5), 'P1')
  assert.equal(classOf(run(at(1, { a: false, b: true }), at(2, { a: true, b: true })), m, 5), 'CONV')
  assert.equal(classOf(run(at(1, { a: false, b: true }), at(2, { a: false, b: true })), m, 5), 'INCOMPLETE')
  const five = (last: Record<string, boolean>) => run(at(1, { a: false, b: false, c: true }), ...[2, 3, 4].map((n) => at(n, { a: false, b: false, c: true })), at(5, last))
  assert.equal(classOf(five({ a: true, b: false, c: true }), m, 5), 'NEAR')
  assert.equal(classOf(five({ a: true, b: false, c: false }), m, 5), 'STUCK') // gained a minority pass, lost another
  assert.equal(classOf(run(), m, 5), 'INCOMPLETE')
  assert.equal(verdict(['P1', 'CONV', 'CONV', 'STUCK']), 'supported')
  assert.equal(verdict(['CONV', 'STUCK', 'STUCK']), 'not supported')
  assert.equal(verdict(['CONV', 'NEAR', 'STUCK', 'STUCK']), 'undecided')
  assert.match(verdict(['P1', 'CONV', 'INCOMPLETE']), /undecided \(1/)
  console.log('self-test ok')
}

const [a1, a2] = process.argv.slice(2)
if (a1 === '--self-test') selfTest()
else console.log(report(JSON.parse(readFileSync(a1, 'utf8')), a2))
