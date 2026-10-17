// Deterministic HTTP scenario runner. Each scenario gets a FRESH sandboxed app instance.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertLoopbackOnly, freePort, killTree, removeTree, spawnApp, waitPort } from './sandbox.ts'

export type Expect = { status?: number | number[]; json?: unknown; jsonHas?: string[]; isArray?: boolean; length?: number }
export type Step = { method: string; path: string; body?: unknown; headers?: Record<string, string>; expect: Expect; capture?: Record<string, string> }
export type Scenario = { id: string; title: string; summary: string; inSpec: boolean; kind: string; steps: Step[] }
export type ScenarioResult = { id: string; inSpec: boolean; kind: string; pass: boolean; failedStep?: number; detail: string }

// ---- validation (drafter output is untrusted) ----
const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x)
function keys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unknown field "${k}"`)
}
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x)
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out))
  else if (isObj(x)) Object.values(x).forEach((v) => strings(v, out))
  return out
}

export function validateScenarios(x: unknown): Scenario[] {
  if (!Array.isArray(x) || x.length === 0) throw new Error('scenarios must be a non-empty array')
  const ids = new Set<string>()
  for (const [i, s] of x.entries()) {
    const w = `scenario[${i}]`
    if (!isObj(s)) throw new Error(`${w}: not an object`)
    keys(s, ['id', 'title', 'summary', 'inSpec', 'kind', 'steps'], w)
    if (typeof s.id !== 'string' || !/^[\w.-]{1,64}$/.test(s.id) || ids.has(s.id)) throw new Error(`${w}: bad or duplicate id`)
    ids.add(s.id)
    for (const f of ['title', 'summary', 'kind']) if (typeof s[f] !== 'string' || !s[f].trim()) throw new Error(`${w}: ${f} must be a non-empty string`)
    if (/[\r\n]/.test(s.summary) || s.summary.length > 200) throw new Error(`${w}: summary must be one line (<=200 chars)`)
    if (typeof s.inSpec !== 'boolean') throw new Error(`${w}: inSpec must be boolean`)
    if (!Array.isArray(s.steps) || s.steps.length === 0) throw new Error(`${w}: steps must be a non-empty array`)
    for (const [j, st] of s.steps.entries()) {
      const ws = `${w}.steps[${j}]`
      if (!isObj(st)) throw new Error(`${ws}: not an object`)
      keys(st, ['method', 'path', 'body', 'headers', 'expect', 'capture'], ws)
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(st.method)) throw new Error(`${ws}: bad method`)
      if (typeof st.path !== 'string' || !st.path.startsWith('/')) throw new Error(`${ws}: path must start with /`)
      if (st.method === 'GET' && st.body !== undefined) throw new Error(`${ws}: GET cannot have a body`)
      if (st.headers !== undefined && (!isObj(st.headers) || !Object.values(st.headers).every((v) => typeof v === 'string'))) throw new Error(`${ws}: bad headers`)
      if (st.capture !== undefined && (!isObj(st.capture) || !Object.values(st.capture).every((v) => typeof v === 'string'))) throw new Error(`${ws}: bad capture`)
      const e = st.expect
      if (!isObj(e)) throw new Error(`${ws}: expect must be an object`)
      keys(e, ['status', 'json', 'jsonHas', 'isArray', 'length'], `${ws}.expect`)
      if (Object.keys(e).length === 0) throw new Error(`${ws}: expect must contain at least one check`)
      if (e.status !== undefined && !(Number.isInteger(e.status) || (Array.isArray(e.status) && e.status.length > 0 && e.status.every(Number.isInteger)))) throw new Error(`${ws}: bad expect.status`)
      if (e.jsonHas !== undefined && !(Array.isArray(e.jsonHas) && e.jsonHas.every((p: unknown) => typeof p === 'string'))) throw new Error(`${ws}: bad expect.jsonHas`)
      if (e.isArray !== undefined && typeof e.isArray !== 'boolean') throw new Error(`${ws}: bad expect.isArray`)
      if (e.length !== undefined && !Number.isInteger(e.length)) throw new Error(`${ws}: bad expect.length`)
      // The summary is the only thing the builder may see on failure: it must not carry concrete values.
      const lits = [st.path.split('?')[0].replace(/\{\{\w+\}\}/g, ''), ...strings(st.body), ...strings(e.json), ...strings(st.headers)]
        .filter((v) => v.length >= 3 && v !== '/').map((v) => v.toLowerCase())
      const leaked = lits.find((v) => s.summary.toLowerCase().includes(v))
        ?? [e.status ?? []].flat().find((c: number) => new RegExp(`\\b${c}\\b`).test(s.summary))
      if (leaked !== undefined) throw new Error(`${w}: summary contains a concrete value from the steps`)
    }
  }
  return x as Scenario[]
}

// ---- matching ----
// Own properties only: 'constructor' etc. must not count as present.
const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined), o)

// ponytail: arrays match by position (expected is a prefix of actual); unordered containment if specs leave order open.
export function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length >= expected.length && expected.every((e, i) => subset(e, actual[i]))
  if (isObj(expected)) return isObj(actual) && Object.entries(expected).every(([k, v]) => subset(v, actual[k]))
  return expected === actual
}

function fill(x: unknown, vars: Record<string, unknown>): unknown {
  const need = (n: string) => { if (!Object.hasOwn(vars, n)) throw new Error(`variable ${n} was never captured`); return vars[n] }
  if (typeof x === 'string' && /^\{\{\w+\}\}$/.test(x)) return need(x.slice(2, -2)) // whole value: keep the captured type
  if (typeof x === 'string') return x.replace(/\{\{(\w+)\}\}/g, (_, n) => String(need(n)))
  if (Array.isArray(x)) return x.map((v) => fill(v, vars))
  if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v, vars)]))
  return x
}

// The response body is builder-controlled: cap it instead of buffering whatever the app sends.
async function text(res: Response, max = 1_000_000): Promise<string> {
  let raw = ''
  const dec = new TextDecoder()
  for await (const chunk of res.body ?? []) if ((raw += dec.decode(chunk, { stream: true })).length > max) throw new Error('response too large')
  return raw + dec.decode()
}

async function runSteps(port: number, s: Scenario, signal: AbortSignal): Promise<{ failedStep?: number; detail: string }> {
  const vars: Record<string, unknown> = {}
  for (const [i, st] of s.steps.entries()) {
    const n = i + 1
    try {
      const path = fill(st.path, vars) as string
      const body = st.body === undefined ? undefined : JSON.stringify(fill(st.body, vars))
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: st.method, body, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...st.headers },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      })
      const raw = await text(res)
      let json: unknown
      try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
      const e = st.expect
      const statuses = e.status === undefined ? null : ([] as number[]).concat(e.status)
      if (statuses && !statuses.includes(res.status)) return { failedStep: n, detail: `step ${n}: expected status ${statuses.join('|')}, got ${res.status}` }
      if (e.isArray !== undefined && Array.isArray(json) !== e.isArray) return { failedStep: n, detail: `step ${n}: expected isArray=${e.isArray}` }
      if (e.length !== undefined && (!Array.isArray(json) || json.length !== e.length)) return { failedStep: n, detail: `step ${n}: expected length ${e.length}, got ${Array.isArray(json) ? json.length : 'non-array'}` }
      for (const p of e.jsonHas ?? []) if (get(json, p) === undefined) return { failedStep: n, detail: `step ${n}: response missing ${p}` }
      if (e.json !== undefined && !subset(fill(e.json, vars), json)) return { failedStep: n, detail: `step ${n}: response body did not match expected subset` }
      for (const [name, p] of Object.entries(st.capture ?? {})) {
        if ((vars[name] = get(json, p)) === undefined) return { failedStep: n, detail: `step ${n}: capture ${name} missing from response` }
      }
    } catch (err) {
      if (signal.aborted) throw err
      return { failedStep: n, detail: `step ${n}: ${(err as Error).message}` }
    }
  }
  return { detail: 'ok' }
}

export async function runScenario(appDir: string, s: Scenario, signal: AbortSignal): Promise<ScenarioResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'factory-data-'))
  const port = await freePort()
  const app = spawnApp(appDir, port, dataDir)
  let stderr = ''
  app.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-300) })
  const base = { id: s.id, inSpec: s.inSpec, kind: s.kind }
  try {
    try {
      await waitPort(port, 15_000, app, signal)
    } catch (err) {
      if (signal.aborted) throw err
      return { ...base, pass: false, failedStep: 0, detail: `app did not start: ${(err as Error).message}; stderr: ${stderr.trim()}` }
    }
    try { assertLoopbackOnly(app) } catch (err) { return { ...base, pass: false, failedStep: 0, detail: (err as Error).message } }
    const r = await runSteps(port, s, signal)
    return { ...base, pass: r.failedStep === undefined, ...r }
  } finally {
    killTree(app, 500)
    await new Promise((r) => {
      if (app.exitCode !== null || app.signalCode !== null) return r(null)
      app.once('exit', r)
      setTimeout(r, 3000).unref() // bounded: never hang the factory on a stuck child
    })
    removeTree(dataDir)
  }
}

export async function runScenarios(appDir: string, scenarios: Scenario[], signal: AbortSignal): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const s of scenarios) {
    if (signal.aborted) throw new Error('stopped')
    out.push(await runScenario(appDir, s, signal)) // ponytail: sequential; parallelize if scenario count grows
  }
  return out
}
