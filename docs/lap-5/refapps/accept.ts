// Which pre-registered answers does each scenario set accept? Vary one decision at a time on the
// reference app; scenarios whose result changes are the ones testing it; an answer is accepted when
// it passes all of them. No scenario changes -> untested.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runScenarios, validateScenarios } from '../../../src/scenario.ts'
const [W, STATE, ...ids] = process.argv.slice(2)
const base = { rem: 'rotate', net: 'group', payer: 'listed' }
const decisions: Record<string, [string, Record<string, string>]> = {
  remainder: ['rem', { 'even-over-repeats': 'rotate', 'payer-covers': 'payer', 'first-listed-fixed': 'first', 'last-listed-fixed': 'last', 'rotate-non-payers': 'nonpayer' }],
  'payer-in-shares': ['payer', { 'listed-only': 'listed', 'payer-always-shares': 'always', refused: 'refuse' }],
  netting: ['net', { 'group-net': 'group', pairwise: 'pairwise' }],
}
const app = (s: object) => {
  const dir = join(W, 'refapps', 'acc-' + Object.values(s).join('-'))
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(W, 'refapps', 'server.cjs'), join(dir, 'server.cjs'))
  writeFileSync(join(dir, 'strategy.json'), JSON.stringify(s))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ref', private: true, scripts: { start: 'node server.cjs' } }))
  return dir
}
const out: Record<string, unknown> = {}
for (const id of ids) {
  const sc = validateScenarios(JSON.parse(readFileSync(join(STATE, 'vault', id, 'scenarios.json'), 'utf8')))
  out[id] = {}
  for (const [d, [key, opts]] of Object.entries(decisions)) {
    const res: Record<string, Record<string, boolean>> = {}
    for (const [name, v] of Object.entries(opts)) res[name] = Object.fromEntries((await runScenarios(app({ ...base, [key]: v }), sc, new AbortController().signal)).map((r) => [r.id, r.pass]))
    const relevant = sc.map((s) => s.id).filter((sid) => new Set(Object.values(res).map((r) => r[sid])).size > 1)
    const accepted = Object.keys(opts).filter((n) => relevant.every((sid) => res[n][sid]))
    ;(out[id] as any)[d] = { accepts: relevant.length ? accepted : 'untested', identifies: relevant.length > 0 && accepted.length === 1, testedBy: relevant }
  }
}
console.log(JSON.stringify(out, null, 1))
