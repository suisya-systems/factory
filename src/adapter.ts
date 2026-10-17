// The ONE place that knows the model CLI: its binary, flags, files and output shape.
// Everything outside speaks only Task / Result (job, workplace, access, limits, result, cost).
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sandboxSpawn, killTree, HOME, SANDBOX_PATH, type SandboxOpts } from './sandbox.ts'

export type Access = 'none' | 'read' | 'write'
// model: a per-command override of MODEL_BY_ROLE (lap 5, `--model <role>=<model>`); checked by parseModels.
export type Task = { role: string; instruction: string; workdir: string; access: Access; maxCostUsd: number; timeoutMs: number; signal?: AbortSignal; model?: string }
// costByModel: the cost the CLI reports per model inside the call (its own internal calls included), when it reports one.
export type Result = { ok: boolean; text: string; costUsd: number | null; error?: string; model?: string; costByModel?: Record<string, number> }
export type Model = (task: Task) => Promise<Result>

// The launcher's real file (under ~/.local/share/claude, which is mounted), not the whole ~/.local/bin.
const LAUNCHER = `${HOME}/.local/bin/claude`
export const BIN = existsSync(LAUNCHER) ? realpathSync(LAUNCHER) : LAUNCHER

// ~/.claude.json holds other sessions' first prompts (projects[*]), MCP headers, etc. The sandbox gets
// only the keys the CLI needs to start without onboarding. ponytail: oauthAccount (account metadata,
// not a token) is kept because auth may need it; unverified offline which keys are strictly required.
export const CONFIG_KEEP = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'userID', 'oauthAccount', 'bypassPermissionsModeAccepted']
let configFile: string | undefined
function minimalConfig(): string {
  if (configFile) return configFile
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(readFileSync(`${HOME}/.claude.json`, 'utf8')) } catch { /* no config: start empty */ }
  configFile = join(mkdtempSync(join(tmpdir(), 'factory-cfg-')), 'claude.json')
  writeFileSync(configFile, JSON.stringify(Object.fromEntries(CONFIG_KEEP.filter((k) => Object.hasOwn(j, k)).map((k) => [k, j[k]]))), { mode: 0o600 })
  return configFile
}

// Exported so the isolation test checks the exact mounts a model session gets.
export function cliSandbox(t: Task): SandboxOpts {
  return {
    workdir: t.workdir,
    writable: t.access === 'write',
    // Only what the CLI needs to start and authenticate. Never the whole config dir: its history,
    // transcripts and file backups can contain scenario text from the drafter / approval sessions.
    // ponytail: credentials are read-only, so an in-sandbox token refresh cannot persist (unverified offline).
    extraRo: [`${HOME}/.local/share/claude`, ...[`${HOME}/.claude/.credentials.json`].filter(existsSync)],
    copies: { [`${HOME}/.claude.json`]: minimalConfig() }, // writable throwaway copy of the allowlisted keys
  }
}

// Model per role, pinned explicitly so a CLI default never decides it (claude-opus-5-5 was the newest generation on 2026-10-17).
// The keys are the role names the factory really calls with (until lap 4 they were drafter/builder/judge, so the
// two drafters and the classifier silently got the fallback). A role missing here is an error, never a default.
export const MODEL_BY_ROLE: Record<string, string> = {
  splitter: 'claude-opus-5-5', 'spec-drafter': 'claude-opus-5-5', 'scenario-drafter': 'claude-opus-5-5', classifier: 'claude-opus-5-5', builder: 'claude-opus-5-5', judge: 'claude-opus-5-5',
}
// Lap 8 (owner decision 2026-10-18): a second model family, for the two drafter roles only. The builder, and every
// role that reads builder-written code, stays on the first family, so the second family's login is never mounted
// where builder code runs. Its spend is not reported in USD (a subscription): the guard counts its calls instead.
export const CROSS_MODELS = ['gpt-6-astra']
export const CROSS_ROLES = ['spec-drafter', 'scenario-drafter']
// The models a `--model` override may name (lap 5 compares the first two).
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', ...CROSS_MODELS]
export function modelFor(t: Pick<Task, 'role' | 'model'>): string {
  if (!Object.hasOwn(MODEL_BY_ROLE, t.role)) throw new Error(`no model is set for role "${t.role}"`)
  const m = t.model ?? MODEL_BY_ROLE[t.role]
  if (CROSS_MODELS.includes(m) && !CROSS_ROLES.includes(t.role)) throw new Error(`model ${m} is for ${CROSS_ROLES.join(' / ')} only, not for role "${t.role}"`)
  return m
}
// The model a call will be made with, or null for a role the factory does not know (tests' own roles).
export const requestedModel = (t: Pick<Task, 'role' | 'model'>): string | null => (Object.hasOwn(MODEL_BY_ROLE, t.role) ? modelFor(t) : null)
export const countedInCalls = (model: string | null): boolean => model !== null && CROSS_MODELS.includes(model)
// `--model <role>=<model>` values -> {role: model}. Rejected before any model is called.
export function parseModels(specs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of specs) {
    const [role, model, ...rest] = s.split('=')
    if (rest.length || !Object.hasOwn(MODEL_BY_ROLE, role) || !MODELS.includes(model)) throw new Error(`--model ${s}: expected <role>=<model> with role in ${Object.keys(MODEL_BY_ROLE).join('|')} and model in ${MODELS.join('|')}`)
    try { modelFor({ role, model }) } catch (e) { throw new Error(`--model ${s}: ${(e as Error).message}`) }
    out[role] = model
  }
  return out
}

function cliArgs(t: Task): string[] {
  const a = ['-p', '--model', modelFor(t), '--output-format', 'json', '--max-budget-usd', t.maxCostUsd.toFixed(4), '--no-session-persistence', '--strict-mcp-config',
    // Inside the sandbox the user config dir is empty, so 'user' loads nothing. 'project' is NOT
    // loaded on purpose: the workdir is builder-written and could plant hooks that see the judge prompt.
    '--setting-sources', 'user']
  if (t.access === 'write') a.push('--permission-mode', 'bypassPermissions') // the OS sandbox is the guarantee
  else if (t.access === 'read') a.push('--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk')
  else a.push('--tools', '')
  return a
}

// The CLI gets an allowlisted env, never the factory's: parent-session tokens, messaging sockets and
// behaviour knobs (effort, entrypoint) must not reach a builder running with full tool access.
// ponytail: proxy vars pass through as-is (the API may need them), credentials embedded in them included.
const ENV_KEEP = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] // last two: explicit auth, if the operator uses env auth
export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: SANDBOX_PATH, HOME, TMPDIR: '/tmp' }
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

// CLI error kinds -> factory words; the CLI's own names never leave this module.
const ERROR_KIND: Record<string, string> = { error_max_budget_usd: 'budget exceeded', error_max_turns: 'turn limit', error_during_execution: 'execution error' }

// Runs one model process in the sandbox: the instruction on stdin, stdout collected, stderr dropped.
// why: set when the factory stopped it (abort, timeout, failed start).
async function spawnModel(t: Task, bin: string, args: string[], box: SandboxOpts, env: NodeJS.ProcessEnv): Promise<{ out: string; code: number | null; why?: string }> {
  const child = sandboxSpawn(bin, args, box, { cwd: t.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.on('data', (d) => { out += d })
  child.stderr!.resume() // raw CLI stderr never leaves this module
  child.stdin!.on('error', () => {})
  child.stdin!.end(t.instruction)
  let why: string | undefined
  const stop = (reason: string) => { why ??= reason; killTree(child) }
  const onAbort = () => stop('stopped by emergency stop or limit')
  t.signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => stop(`timed out after ${t.timeoutMs}ms`), t.timeoutMs)
  const code = await new Promise<number | null>((ok) => {
    child.on('close', (c) => ok(c))
    child.on('error', () => { why ??= 'model process failed to start'; ok(null) })
  })
  clearTimeout(timer)
  t.signal?.removeEventListener('abort', onAbort)
  return { out, code, why }
}

// Exported for tests only (bin = a fake CLI); production code uses realModel.
export async function runCli(t: Task, bin: string): Promise<Result> {
  modelFor(t) // an unknown role throws before anything starts
  if (t.signal?.aborted) return { ok: false, text: '', costUsd: null, error: 'stopped before start' }
  const { out, code, why } = await spawnModel(t, bin, cliArgs(t), cliSandbox(t), cliEnv())
  let j: any = null
  try { j = JSON.parse(out) } catch { /* died without JSON */ }
  const cost = j && typeof j.total_cost_usd === 'number' && Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null
  const text = j && typeof j.result === 'string' ? j.result : ''
  // The models that actually answered (per-model usage), else the one requested.
  const usage: [string, any][] = j && j.modelUsage && typeof j.modelUsage === 'object' ? Object.entries(j.modelUsage) : []
  const model = usage.map(([m]) => m).join(',') || modelFor(t)
  const priced = usage.filter(([, u]) => u && typeof u.costUSD === 'number' && Number.isFinite(u.costUSD))
  const by = priced.length ? { costByModel: Object.fromEntries(priced.map(([m, u]) => [m, u.costUSD])) } : {}
  if (why) return { ok: false, text, costUsd: cost, error: why, model, ...by }
  if (!j) return { ok: false, text: '', costUsd: null, error: `model process exited (code ${code}) without a parseable result`, model }
  if (j.is_error || code !== 0) return { ok: false, text, costUsd: cost, error: `model reported an error (${Object.hasOwn(ERROR_KIND, j.subtype) ? ERROR_KIND[j.subtype] : 'unknown'})`, model, ...by }
  return { ok: true, text, costUsd: cost, model, ...by }
}

// ---- the second family: Codex CLI (lap 8) ----
// Its real path is not fixed (a node version manager's per-shell dir), so it is looked up on PATH at call time.
export function codexBin(path = process.env.PATH ?? ''): string {
  for (const d of path.split(':').filter(Boolean)) if (existsSync(join(d, 'codex'))) return realpathSync(join(d, 'codex'))
  throw new Error('the codex CLI is not on PATH; it is needed for a gpt-6-astra drafter')
}
export const CODEX_AUTH = `${HOME}/.codex/auth.json`
// Exported so the isolation test checks the exact mounts. Only a drafter sandbox ever gets the login.
export function codexSandbox(t: Task, bin: string, auth = CODEX_AUTH): SandboxOpts {
  return {
    workdir: t.workdir,
    writable: false,
    // The launcher is a node script in its npm package (bin/codex.js); the package holds the native binary.
    extraRo: [dirname(dirname(bin))],
    // Bound read-write, not copied: a token refresh during the call must reach the host file, or the host could be
    // left holding a rotated-out refresh token. Everything else of ~/.codex (history, sessions, config) stays hidden.
    extraRw: [auth].filter(existsSync),
  }
}
// No config, no rules files, no session files; the CLI's own sandbox read-only on top of ours. The reasoning effort
// is pinned so a CLI default never decides it.
function codexArgs(t: Task): string[] {
  return ['exec', '--json', '--model', modelFor(t), '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '-c', 'model_reasoning_effort="medium"', '--cd', t.workdir, '-']
}
export function codexEnv(auth = CODEX_AUTH): NodeJS.ProcessEnv {
  const env = cliEnv()
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return { ...env, CODEX_HOME: dirname(auth) }
}

// Exported for tests only (bin = a fake CLI). The reply is the last agent message of the JSONL event stream.
// The CLI reports neither a USD cost nor the model that answered: costUsd stays null and no model is reported.
export async function runCodex(t: Task, bin: string, auth = CODEX_AUTH): Promise<Result> {
  modelFor(t)
  if (t.access !== 'none') throw new Error(`role ${t.role}: the second model family runs without tool access only`)
  if (t.signal?.aborted) return { ok: false, text: '', costUsd: null, error: 'stopped before start' }
  const { out, code, why } = await spawnModel(t, bin, codexArgs(t), codexSandbox(t, bin, auth), codexEnv(auth))
  const events = out.split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  const msgs = events.filter((e) => e?.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string')
  const text = msgs.length ? msgs[msgs.length - 1].item.text : ''
  if (why) return { ok: false, text, costUsd: null, error: why }
  if (events.some((e) => e?.type === 'turn.failed' || e?.type === 'error')) return { ok: false, text, costUsd: null, error: 'model reported an error (turn failed)' }
  if (code !== 0 || !msgs.length) return { ok: false, text, costUsd: null, error: `model process exited (code ${code}) without a reply` }
  // The CLI keeps a read-only shell, and its login is mounted: a reply carrying a login secret is dropped whole, so it
  // never reaches a spec, a scenario or a builder. ponytail: verbatim copies only; an encoded one is NOT detected.
  if (crossLoginSecrets(auth).some((x) => out.includes(x))) return { ok: false, text: '', costUsd: null, error: 'reply contained a second-family login secret (dropped)' }
  return { ok: true, text, costUsd: null }
}

// Login secrets of the second family (string values of its auth file), for leak checks only: never written anywhere.
export function crossLoginSecrets(auth = CODEX_AUTH): string[] {
  let j: unknown
  try { j = JSON.parse(readFileSync(auth, 'utf8')) } catch { return [] }
  const out: string[] = []
  const walk = (x: unknown) => { if (typeof x === 'string') { if (x.length >= 20) out.push(x) } else if (x && typeof x === 'object') Object.values(x).forEach(walk) }
  walk(j)
  return out
}

// Shell commands a builder is asked to run in the isolation probe: where the login would be if it leaked.
export const crossLoginProbe = (auth = CODEX_AUTH) => [`ls -la ${dirname(auth)}`, `cat ${auth}`]

export const realModel: Model = async (t) => (countedInCalls(modelFor(t)) ? runCodex(t, codexBin()) : runCli(t, BIN))
