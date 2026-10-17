// The ONE place that knows the model CLI: its binary, flags, files and output shape.
// Everything outside speaks only Task / Result (job, workplace, access, limits, result, cost).
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// The models a `--model` override may name (lap 5 compares these two).
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5']
export function modelFor(t: Pick<Task, 'role' | 'model'>): string {
  if (!Object.hasOwn(MODEL_BY_ROLE, t.role)) throw new Error(`no model is set for role "${t.role}"`)
  return t.model ?? MODEL_BY_ROLE[t.role]
}
// `--model <role>=<model>` values -> {role: model}. Rejected before any model is called.
export function parseModels(specs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of specs) {
    const [role, model, ...rest] = s.split('=')
    if (rest.length || !Object.hasOwn(MODEL_BY_ROLE, role) || !MODELS.includes(model)) throw new Error(`--model ${s}: expected <role>=<model> with role in ${Object.keys(MODEL_BY_ROLE).join('|')} and model in ${MODELS.join('|')}`)
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

// Exported for tests only (bin = a fake CLI); production code uses claudeModel.
export async function runCli(t: Task, bin: string): Promise<Result> {
  modelFor(t) // an unknown role throws before anything starts
  if (t.signal?.aborted) return { ok: false, text: '', costUsd: null, error: 'stopped before start' }
  const child = sandboxSpawn(bin, cliArgs(t), cliSandbox(t),
    { cwd: t.workdir, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
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

export const claudeModel: Model = (t) => runCli(t, BIN)
