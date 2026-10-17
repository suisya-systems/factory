import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProbe, validateProbes } from '../../../src/scenario.ts'
const W = process.argv[2]
const probes = validateProbes(JSON.parse(readFileSync(join(W, 'probes.json'), 'utf8')))
const strategies = [
  ...['rotate', 'payer', 'first', 'last', 'nonpayer', 'exact', 'random'].map((rem) => ({ rem, net: 'group', payer: 'listed' })),
  { rem: 'rotate', net: 'pairwise', payer: 'listed' }, { rem: 'rotate', net: 'group', payer: 'always' },
]
for (const s of strategies) {
  const dir = join(W, 'refapps', `${s.rem}-${s.net}-${s.payer}`)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(W, 'refapps', 'server.cjs'), join(dir, 'server.cjs'))
  writeFileSync(join(dir, 'strategy.json'), JSON.stringify(s))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ref', private: true, scripts: { start: 'node server.cjs' } }))
  const out = []
  for (const p of probes) { const r = await runProbe(dir, p, new AbortController().signal); out.push(`${p.id}=${r.answer}${r.answer === 'other' ? JSON.stringify(r.observed) : ''}`) }
  console.log(JSON.stringify(s), out.join(' '))
}
