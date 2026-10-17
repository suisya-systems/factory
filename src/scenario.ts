// Deterministic HTTP scenario runner. Each scenario gets a FRESH sandboxed app instance.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, killTree, removeTree, spawnApp, waitPort } from './sandbox.ts'

export type Expect = { status?: number | number[]; json?: unknown; jsonHas?: string[]; isArray?: boolean; length?: number | Record<string, number> }
export type Step = { method: string; path: string; body?: unknown; headers?: Record<string, string>; expect: Expect; capture?: Record<string, string> }
// inSpec: the drafter's claim that the spec states this behaviour (used to split pass rates; self-reported, not verified).
export type Scenario = { id: string; title: string; summary: string; inSpec: boolean; kind: string; steps: Step[] }
export type ScenarioResult = { id: string; inSpec: boolean; kind: string; pass: boolean; failedStep?: number; detail: string }

// ---- validation (drafter output is untrusted) ----
export const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x)
function keys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unknown field "${k}"`)
}
function leaves<T>(x: unknown, is: (v: unknown) => v is T, out: T[] = []): T[] {
  if (is(x)) out.push(x)
  else if (Array.isArray(x)) x.forEach((v) => leaves(v, is, out))
  else if (isObj(x)) Object.values(x).forEach((v) => leaves(v, is, out))
  return out
}
const strings = (x: unknown) => leaves(x, (v): v is string => typeof v === 'string')
// Lap 4: amounts (yen) are this app's expected values, so numbers count too.
const numbers = (x: unknown) => leaves(x, Number.isInteger as (v: unknown) => v is number)

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
      if (e.jsonHas !== undefined && !(Array.isArray(e.jsonHas) && e.jsonHas.length > 0 && e.jsonHas.every((p: unknown) => typeof p === 'string'))) throw new Error(`${ws}: bad expect.jsonHas`)
      if (e.isArray !== undefined && typeof e.isArray !== 'boolean') throw new Error(`${ws}: bad expect.isArray`)
      if (e.length !== undefined && !(Number.isInteger(e.length) || (isObj(e.length) && Object.keys(e.length).length > 0 && Object.values(e.length).every(Number.isInteger)))) throw new Error(`${ws}: bad expect.length`)
      // The summary is the only thing the builder may see on failure: it must not carry concrete values.
      const lits = [st.path.split('?')[0].replace(/\{\{\w+\}\}/g, ''), ...strings(st.body), ...strings(e.json), ...strings(st.headers)]
        .filter((v) => v.length >= 3 && v !== '/').map((v) => v.toLowerCase())
      const leaked = lits.find((v) => s.summary.toLowerCase().includes(v))
        ?? [e.status ?? [], ...numbers(st.body), ...numbers(e.json)].flat().find((c: number) => Math.abs(c) >= 100 && new RegExp(`(?<!\\d)${c}(?!\\d)`).test(s.summary))
      if (leaked !== undefined) throw new Error(`${w}: summary contains a concrete value from the steps (${JSON.stringify(String(leaked))})`)
    }
  }
  return x as Scenario[]
}

// ---- matching ----
// Own properties only: 'constructor' etc. must not count as present.
export const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined), o)

// ponytail: arrays match by position (expected is a prefix of actual); unordered containment if specs leave order open.
export function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length >= expected.length && expected.every((e, i) => subset(e, actual[i]))
  if (isObj(expected)) return isObj(actual) && Object.entries(expected).every(([k, v]) => subset(v, actual[k]))
  return expected === actual
}

export function fill(x: unknown, vars: Record<string, unknown>): unknown {
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

// One step's checks against one response; fills `vars` from its captures. Returns the failure, or null.
// Shared by the runner (real responses) and the classifier (predicted responses).
// expect.length: a number checks the top-level array; {"dot.path": n} checks arrays inside the body.
export const lengthChecks = (e: Expect): [string, number][] => (e.length === undefined ? [] : typeof e.length === 'number' ? [['', e.length]] : Object.entries(e.length))
export const at = (json: unknown, path: string) => (path ? get(json, path) : json)
// A capture path "header:<name>" reads a response header instead of the JSON body.
export const HEADER = 'header:'

export function checkStep(st: Step, status: number, json: unknown, vars: Record<string, unknown>, headers?: Headers): string | null {
  const e = st.expect
  const statuses = e.status === undefined ? null : ([] as number[]).concat(e.status)
  if (statuses && !statuses.includes(status)) return `expected status ${statuses.join('|')}, got ${status}`
  if (e.isArray !== undefined && Array.isArray(json) !== e.isArray) return `expected isArray=${e.isArray}`
  for (const [p, n] of lengthChecks(e)) {
    const v = at(json, p)
    if (!Array.isArray(v) || v.length !== n) return `expected length ${n}${p ? ` at ${p}` : ''}, got ${Array.isArray(v) ? v.length : 'non-array'}`
  }
  for (const p of e.jsonHas ?? []) if (get(json, p) === undefined) return `response missing ${p}`
  if (e.json !== undefined && !subset(fill(e.json, vars), json)) return 'response body did not match expected subset'
  for (const [name, p] of Object.entries(st.capture ?? {})) {
    const v = p.startsWith(HEADER) ? (headers?.get(p.slice(HEADER.length)) ?? undefined) : get(json, p)
    if ((vars[name] = v) === undefined) return `capture ${name} missing from response`
  }
  return null
}

async function send(port: number, st: Omit<Step, 'expect'>, vars: Record<string, unknown>, signal: AbortSignal) {
  const path = fill(st.path, vars) as string
  const body = st.body === undefined ? undefined : JSON.stringify(fill(st.body, vars))
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: st.method, body, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(fill(st.headers ?? {}, vars) as Record<string, string>) },
    redirect: 'manual', // judge the tested endpoint's own response, never a redirect target
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  const raw = await text(res)
  let json: unknown
  try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
  return { res, json }
}

async function runSteps(port: number, s: Scenario, signal: AbortSignal): Promise<{ failedStep?: number; detail: string }> {
  const vars: Record<string, unknown> = {}
  for (const [i, st] of s.steps.entries()) {
    const n = i + 1
    try {
      const { res, json } = await send(port, st, vars, signal)
      const failed = checkStep(st, res.status, json, vars, res.headers)
      if (failed) return { failedStep: n, detail: `step ${n}: ${failed}` }
    } catch (err) {
      if (signal.aborted) throw err
      return { failedStep: n, detail: `step ${n}: ${(err as Error).message}` }
    }
  }
  return { detail: 'ok' }
}

// Starts the app fresh (own data dir, own port), runs `go` against it, always stops it.
// When the app does not start, `failed` gets why.
async function withApp<T>(appDir: string, signal: AbortSignal, go: (port: number) => Promise<T>, failed: (why: string) => T): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'factory-data-'))
  const port = await freePort()
  const app = spawnApp(appDir, port, dataDir)
  let stderr = ''
  app.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-300) })
  try {
    try {
      await waitPort(port, 15_000, app, signal)
    } catch (err) {
      if (signal.aborted) throw err
      return failed(`app did not start: ${(err as Error).message}; stderr: ${stderr.trim()}`)
    }
    return await go(port)
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

export async function runScenario(appDir: string, s: Scenario, signal: AbortSignal): Promise<ScenarioResult> {
  const base = { id: s.id, inSpec: s.inSpec, kind: s.kind }
  return withApp(appDir, signal, async (port) => {
    const r = await runSteps(port, s, signal)
    return { ...base, pass: r.failedStep === undefined, ...r }
  }, (detail) => ({ ...base, pass: false, failedStep: 0, detail }))
}

// ---- probes (lap 5) ----
// A probe tells which of several pre-registered answers a build chose for one open decision: its steps
// run on a fresh app (no checks), `observe` picks values out of the responses ("<step>:status",
// "<step>:body" or "<step>:body.<dot.path>"), and the first option listing a matching observation
// names the answer. Options may name captured values ("{{a}}"); each observed value matches its own
// position like unordered(). No option matches -> "other" (the observation is kept); a step that could not run
// (no response, a capture missing) -> "blocked". Written by the experimenter, never shown to a builder.
export type Probe = { id: string; steps: Omit<Step, 'expect'>[]; observe: string[]; options: Record<string, unknown[][]> }
export type ProbeResult = { id: string; answer: string; observed?: unknown[]; detail?: string }
export const OTHER = 'other', BLOCKED = 'blocked'

export function validateProbes(x: unknown): Probe[] {
  const ds = isObj(x) ? x.decisions : undefined
  if (!Array.isArray(ds) || ds.length === 0) throw new Error('probes: "decisions" must be a non-empty array')
  for (const [i, d] of ds.entries()) {
    const w = `probes.decisions[${i}]`
    if (!isObj(d) || typeof d.id !== 'string' || !Array.isArray(d.steps) || d.steps.length === 0) throw new Error(`${w}: needs an id and steps`)
    for (const st of d.steps) if (!isObj(st) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(st.method) || typeof st.path !== 'string' || !st.path.startsWith('/')) throw new Error(`${w}: bad step`)
    if (!Array.isArray(d.observe) || d.observe.length === 0 || !d.observe.every((o: unknown) => typeof o === 'string' && /^\d+:(status|body(\..+)?)$/.test(o) && Number(o.split(':')[0]) >= 1 && Number(o.split(':')[0]) <= d.steps.length)) throw new Error(`${w}: bad observe`)
    if (!isObj(d.options) || Object.keys(d.options).length < 2) throw new Error(`${w}: needs at least two options`)
    for (const [name, vs] of Object.entries(d.options)) {
      if (name === OTHER || name === BLOCKED) throw new Error(`${w}: option name "${name}" is reserved`)
      if (!Array.isArray(vs) || vs.length === 0 || !vs.every((v) => Array.isArray(v) && v.length === d.observe.length)) throw new Error(`${w}.options.${name}: a list of observations, each as long as observe`)
    }
  }
  return ds as Probe[]
}

// Like subset(), but arrays must be as long as expected and match in any order (a settlement's
// transfers have no fixed order); objects may carry extra keys.
export function unordered(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    const take = (i: number, used: boolean[]): boolean => i === expected.length
      || actual.some((a, j) => !used[j] && unordered(expected[i], a) && take(i + 1, used.map((u, k) => u || k === j)))
    return take(0, actual.map(() => false))
  }
  if (isObj(expected)) return isObj(actual) && Object.entries(expected).every(([k, v]) => unordered(v, actual[k]))
  return expected === actual
}

export async function runProbe(appDir: string, p: Probe, signal: AbortSignal): Promise<ProbeResult> {
  return withApp(appDir, signal, async (port) => {
    const vars: Record<string, unknown> = {}
    const seen: { status: number; json: unknown }[] = []
    for (const [i, st] of p.steps.entries()) {
      try {
        const { res, json } = await send(port, st, vars, signal)
        seen.push({ status: res.status, json })
        for (const [name, path] of Object.entries(st.capture ?? {})) {
          const v = path.startsWith(HEADER) ? (res.headers.get(path.slice(HEADER.length)) ?? undefined) : get(json, path)
          if (v !== undefined) vars[name] = v
          else delete vars[name] // missing (even if captured before): a later step that uses it throws, and the probe is blocked
        }
      } catch (err) {
        if (signal.aborted) throw err
        return { id: p.id, answer: BLOCKED, detail: `step ${i + 1}: ${(err as Error).message}` }
      }
    }
    const observed = p.observe.map((o) => {
      const [n, what] = [Number(o.split(':')[0]), o.slice(o.indexOf(':') + 1)]
      return what === 'status' ? seen[n - 1].status : at(seen[n - 1].json, what.slice('body.'.length))
    })
    const answer = Object.entries(p.options).find(([, vs]) => vs.some((v) => { try { return (fill(v, vars) as unknown[]).every((e, i) => unordered(e, observed[i])) } catch { return false } }))?.[0] ?? OTHER
    return { id: p.id, answer, observed }
  }, (detail) => ({ id: p.id, answer: BLOCKED, detail }))
}

export async function runScenarios(appDir: string, scenarios: Scenario[], signal: AbortSignal): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const s of scenarios) {
    if (signal.aborted) throw new Error('stopped')
    out.push(await runScenario(appDir, s, signal)) // ponytail: sequential; parallelize if scenario count grows
  }
  return out
}
