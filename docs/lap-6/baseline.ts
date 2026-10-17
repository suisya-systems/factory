// Lap 6 rarity check (no model call): the lap-5 builds of the same spec (16 builds, no feedback) run against
// the lap-6 scenario sets. A minority scenario most of them fail is a real minority answer for this builder
// population; one most of them pass is not, and cannot exercise the retry loop.
// usage: node --experimental-strip-types --no-warnings docs/lap-6/baseline.ts <LAP5 STATE> <STATE> <id> [<id> ...]
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportTree, removeTree } from '../../src/sandbox.ts'
import { runScenarios, validateScenarios } from '../../src/scenario.ts'

const [LAP5, STATE, ...ids] = process.argv.slice(2)
const signal = new AbortController().signal
const recs = join(LAP5, 'runs', 'settle-a1', 'replicates')
const sets = ids.map((id) => [id, validateScenarios(JSON.parse(readFileSync(join(STATE, 'vault', id, 'scenarios.json'), 'utf8')))] as const)
const passes: Record<string, Record<string, string[]>> = Object.fromEntries(ids.map((id) => [id, {}]))
const builds = readdirSync(recs).filter((f) => f.endsWith('.json')).sort()
for (const f of builds) {
  const { sha } = JSON.parse(readFileSync(join(recs, f), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'lap6-base-'))
  try {
    await exportTree(join(LAP5, 'work', 'settle-a1-rep', f.slice(0, -5)), sha, dir, signal)
    for (const [id, sc] of sets) for (const r of await runScenarios(dir, sc, signal)) (passes[id][r.id] ??= []).push(r.pass ? 'P' : 'f')
  } finally { removeTree(dir) }
}
console.log(`builds: ${builds.map((f) => f.slice(0, -5)).join(', ')}`)
for (const [id, sc] of sets) {
  console.log(`\n## ${id}\n\n| scenario | passed / ${builds.length} | per build |\n|---|---|---|`)
  for (const s of sc) console.log(`| ${s.id} | ${passes[id][s.id].filter((x) => x === 'P').length} | ${passes[id][s.id].join('')} |`)
}
