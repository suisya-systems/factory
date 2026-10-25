// State dir + vault. Vault = hidden scenarios + the approved (version-fixed) set.
// Hidden by LOCATION (under $HOME, which every sandbox replaces with an empty tmpfs) and
// registered with the sandbox so no mount can ever expose it.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protect } from './sandbox.ts'
import type { Classification } from './classify.ts'
import { validateScenarios, type Scenario } from './scenario.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
// Everything the owner's approval covers. classification.json: the independent readable-from-spec labels
// shown in the summary. base.json: the app version the drafters saw and the request text's hash.
const FILES = ['spec.md', 'scenarios.json', 'assumptions.json', 'classification.json', 'base.json'] as const

export type Base = { baseSha: string | null; requestSha256: string | null }
export type Draft = { spec: string; scenarios: Scenario[]; assumptions: string[]; classification?: Classification[]; base?: Base }
export type Approved = Required<Draft> & { version: string }

export function checkId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) throw new Error(`bad change id: ${id}`)
  return id
}

// Resolves the state dir and refuses to start unless vault + runs are hidden from every sandbox.
export function stateDir(): string {
  const d = resolve(process.env.FACTORY_HOME ?? join(REPO, '.factory'))
  for (const sub of ['vault', 'runs']) {
    mkdirSync(join(d, sub), { recursive: true })
    protect(join(d, sub))
  }
  return d
}

export const vaultDir = (sd: string, id: string) => join(sd, 'vault', checkId(id))

// An experimenter's file (probes, mutants) that answers or names hidden checks: read only from under vault/.
export function hiddenFile(sd: string, file: string, flag: string): Buffer {
  const f = realpathSync(file) // a symlink under vault/ must not point outside it
  if (relative(realpathSync(join(sd, 'vault')), f).startsWith('..')) throw new Error(`${flag} must be under ${join(sd, 'vault')} (hidden from every sandbox)`)
  return readFileSync(f)
}

export const hash = (dir: string) => {
  const h = createHash('sha256')
  for (const f of FILES) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0')
  return h.digest('hex')
}

export function writeDraft(sd: string, id: string, d: Draft): string {
  const dir = vaultDir(sd, id)
  if (existsSync(join(dir, 'approval.json'))) throw new Error(`${id} is already approved; its version is fixed. Draft a new change instead.`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spec.md'), d.spec)
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(validateScenarios(d.scenarios), null, 2))
  writeFileSync(join(dir, 'assumptions.json'), JSON.stringify(d.assumptions, null, 2))
  writeFileSync(join(dir, 'classification.json'), JSON.stringify(d.classification ?? [], null, 2))
  writeFileSync(join(dir, 'base.json'), JSON.stringify(d.base ?? { baseSha: null, requestSha256: null }, null, 2))
  return dir
}

// `version` = the hash printed in the approval summary the owner read. Approval binds to THAT set:
// if the files changed since (re-draft, edit), the hash differs and approval is refused.
export function approve(sd: string, id: string, a: { by: string; version: string; note?: string }): string {
  const dir = vaultDir(sd, id)
  if (existsSync(join(dir, 'approval.json'))) throw new Error(`${id} is already approved`)
  for (const f of FILES) if (!existsSync(join(dir, f))) throw new Error(`${id} has no draft (${f} missing)`)
  validateScenarios(JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8')))
  const version = hash(dir)
  if (a.version !== version) throw new Error(`${id}: the draft on disk (version ${version}) is not the version you reviewed (${a.version}); re-read the summary`)
  writeFileSync(join(dir, 'approval.json'), JSON.stringify({ version, by: a.by, note: a.note ?? '', at: new Date().toISOString() }, null, 2))
  for (const f of [...FILES, 'approval.json']) chmodSync(join(dir, f), 0o444)
  return version
}

export function loadApproved(sd: string, id: string): Approved {
  const dir = vaultDir(sd, id)
  if (!existsSync(join(dir, 'approval.json'))) throw new Error(`${id} is not approved`)
  const { version } = JSON.parse(readFileSync(join(dir, 'approval.json'), 'utf8'))
  if (hash(dir) !== version) throw new Error(`${id}: approved set was modified after approval (hash mismatch)`)
  return {
    version,
    spec: readFileSync(join(dir, 'spec.md'), 'utf8'),
    scenarios: validateScenarios(JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'))),
    assumptions: JSON.parse(readFileSync(join(dir, 'assumptions.json'), 'utf8')),
    classification: JSON.parse(readFileSync(join(dir, 'classification.json'), 'utf8')),
    base: JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')),
  }
}
