// Lap 6 entrance check (no model call). Runs one scenario set on the reference app set to the answers the
// scenario writer declared ([minority] lines), then reverts each declared answer alone to the majority one.
// - A scenario that fails on the declared app: a wrong expectation, an undeclared choice, or a gap of the reference app.
// - A minority scenario is verified when it passes on the declared app and fails once that one answer is reverted.
// usage: node --experimental-strip-types --no-warnings docs/lap-6/entrance.ts <server.cjs> <STATE> <id> '<declared json>'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScenarios, validateScenarios } from '../../src/scenario.ts'

const [SERVER, STATE, id, declaredJson] = process.argv.slice(2)
const MAJORITY: Record<string, string> = { rem: 'rotate', net: 'group', payer: 'listed' } // lap 5: 16/16 builds on this spec
const declared = { ...MAJORITY, ...JSON.parse(declaredJson) }
const sc = validateScenarios(JSON.parse(readFileSync(join(STATE, 'vault', id, 'scenarios.json'), 'utf8')))
const signal = new AbortController().signal

async function results(s: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'lap6-ref-'))
  copyFileSync(SERVER, join(dir, 'server.cjs'))
  writeFileSync(join(dir, 'strategy.json'), JSON.stringify(s))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ref', private: true, scripts: { start: 'node server.cjs' } }))
  return new Map((await runScenarios(dir, sc, signal)).map((r) => [r.id, r]))
}

const base = await results(declared)
const out: Record<string, unknown> = { id, declared, failOnDeclared: [...base.values()].filter((r) => !r.pass).map((r) => `${r.id}: ${r.detail}`), revert: {} }
for (const k of Object.keys(declared).filter((k) => declared[k] !== MAJORITY[k])) {
  const rev = await results({ ...declared, [k]: MAJORITY[k] })
  ;(out.revert as Record<string, string[]>)[`${k}=${declared[k]} -> ${MAJORITY[k]}`] = sc.map((s) => s.id).filter((x) => base.get(x)!.pass && !rev.get(x)!.pass)
}
console.log(JSON.stringify(out, null, 1))
