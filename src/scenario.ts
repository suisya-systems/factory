// Deterministic HTTP scenario runner. Each scenario gets a FRESH sandboxed app instance.
import { mkdtempSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBrowser, TARGET, UI_ACTIONS, UI_LIMITS, usesUi, type Browser } from './browser.ts'
import { CONTROL, startFake, usesService, type Fake } from './fake.ts'
import { contractOf, ENV_NAME, okPath, RESERVED_ENV, RUN_LIMITS, runProgram, serviceUrl, usesRun, type Contract } from './program.ts'
import { freePort, killTree, removeTree, spawnApp, waitPort } from './sandbox.ts'

export type Expect = { status?: number | number[]; json?: unknown; jsonHas?: string[]; jsonAbsent?: string[]; isArray?: boolean; length?: number | Record<string, number> }
// service: the step goes to the fake external service's control endpoint (fake.ts), not to the app.
// ui (#4): a browser step instead of an HTTP request (no method, body, headers): "goto" a path, "click" / "fill" (with text)
// a target "<testId>" or "<testId>.<n>". Its response is the page: json {"<testId>": [visible texts]}, status (goto only).
// run: a step that starts the declared command-line program (program.ts) with these arguments instead of sending a request (no method, path,
// body, headers). stdin: its standard input; files: path -> content (a string, or JSON that is written as text) put in its working directory first;
// read: paths of files it wrote that come back; env: extra variables. Its response is the envelope {stdout, stderr, files} with status = exit code.
export type Step = { method: string; path: string; body?: unknown; headers?: Record<string, string>; expect: Expect; capture?: Record<string, string>; service?: true
  ui?: 'goto' | 'click' | 'fill'; target?: string; text?: string
  run?: string[]; stdin?: string; files?: Record<string, unknown>; read?: string[]; env?: Record<string, string> }
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
const objKeys = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(objKeys) : isObj(x) ? Object.entries(x).flatMap(([k, v]) => [k, ...objKeys(v)]) : [])
// Lap 4: amounts (yen) are this app's expected values, so numbers count too.
const numbers = (x: unknown) => leaves(x, Number.isInteger as (v: unknown) => v is number)

// A run's arguments that are scenario data. The flags are interface names the builder knows, and so are the sub-command words at the front:
// with the interface's command words (draft time) only those exact words are exempt, so a value like `greet alice` is data; without them (a
// set re-read at approval, already checked at draft) a leading lower-case word without digits is taken for a sub-command. "--flag=value" counts its value.
const SUB = /^[a-z][a-z-]*$/
// A flag name (`--name`, or a lone `-x`) is an interface name; anything else that starts with a dash (`-123`, `-x5`, `-abc`) is a value.
const FLAG_ARG = /^(--[A-Za-z][\w-]*|-[A-Za-z])$/
export const argvData = (run: string[], commandWords?: Set<string>) => {
  let i = 0
  while (i < run.length && (commandWords ? commandWords.has(run[i]) : SUB.test(run[i]))) i++
  return run.slice(i).flatMap((a) => {
    if (FLAG_ARG.test(a)) return []
    const eq = a.match(/^(--[A-Za-z][\w-]*)=(.*)$/)
    return eq ? (eq[2] ? [eq[2]] : []) : [a]
  })
}

// o.commandWords (draft time, a program): the words of the interface's commands, the only leading arguments the summary rule exempts.
export function validateScenarios(x: unknown, o: { commandWords?: Set<string> } = {}): Scenario[] {
  if (!Array.isArray(x) || x.length === 0) throw new Error('scenarios must be a non-empty array')
  const ids = new Set<string>()
  // Summary problems are collected over all scenarios (id, rule, value) so one repair round can fix every one;
  // the rules themselves are unchanged. Any other problem still throws at once.
  const bad: string[] = []
  for (const [i, s] of x.entries()) {
    const w = `scenario[${i}]`
    if (!isObj(s)) throw new Error(`${w}: not an object`)
    keys(s, ['id', 'title', 'summary', 'inSpec', 'kind', 'steps'], w)
    if (typeof s.id !== 'string' || !/^[\w.-]{1,64}$/.test(s.id) || ids.has(s.id)) throw new Error(`${w}: bad or duplicate id`)
    ids.add(s.id)
    for (const f of ['title', 'summary', 'kind']) if (typeof s[f] !== 'string' || !s[f].trim()) throw new Error(`${w}: ${f} must be a non-empty string`)
    if (/[\r\n]/.test(s.summary) || s.summary.length > 200) bad.push(`scenario "${s.id}": summary must be one line (<=200 chars); it has ${s.summary.split(/\r?\n/).length} line(s) and ${s.summary.length} chars`)
    if (typeof s.inSpec !== 'boolean') throw new Error(`${w}: inSpec must be boolean`)
    if (!Array.isArray(s.steps) || s.steps.length === 0) throw new Error(`${w}: steps must be a non-empty array`)
    for (const [j, st] of s.steps.entries()) {
      const ws = `${w}.steps[${j}]`
      if (!isObj(st)) throw new Error(`${ws}: not an object`)
      if (st.run !== undefined) {
        keys(st, ['run', 'stdin', 'files', 'read', 'env', 'expect', 'capture'], ws)
        if (!Array.isArray(st.run) || !st.run.every((a: unknown) => typeof a === 'string' && a.length <= 500 && !a.includes('\0'))) throw new Error(`${ws}: run must be a list of argument strings`)
        if (st.stdin !== undefined && typeof st.stdin !== 'string') throw new Error(`${ws}: stdin must be a string`)
        if (st.files !== undefined && (!isObj(st.files) || Object.keys(st.files).length > RUN_LIMITS.files || !Object.entries(st.files).every(([f, c]) => okPath(f.replace(/\{\{\w+\}\}/g, 'x')) && (typeof c === 'string' ? c : JSON.stringify(c)).length <= RUN_LIMITS.fileChars)))
          throw new Error(`${ws}: files must map plain relative paths (at most ${RUN_LIMITS.files}) to a string or JSON of at most ${RUN_LIMITS.fileChars} characters`)
        if (st.read !== undefined && !(Array.isArray(st.read) && st.read.length <= RUN_LIMITS.files && st.read.every((f: unknown) => typeof f === 'string' && okPath(f.replace(/\{\{\w+\}\}/g, 'x')))))
          throw new Error(`${ws}: read must be a list of plain relative file paths (at most ${RUN_LIMITS.files})`)
        if (st.env !== undefined && !(isObj(st.env) && Object.entries(st.env).every(([k, v]) => ENV_NAME.test(k) && !RESERVED_ENV.test(k) && typeof v === 'string')))
          throw new Error(`${ws}: env must map upper-case variable names (not PATH, HOME, PYTHON*, LD_* ...) to strings`)
        if (st.expect === undefined) throw new Error(`${ws}: expect must be an object`)
      } else if (st.ui !== undefined) {
        keys(st, ['ui', 'path', 'target', 'text', 'expect', 'capture'], ws)
        if (!UI_ACTIONS.includes(st.ui)) throw new Error(`${ws}: ui must be one of ${UI_ACTIONS.join(', ')}`)
        if ((st.ui === 'goto') !== (st.path !== undefined) || (st.ui === 'goto') === (st.target !== undefined) || (st.ui === 'fill') !== (st.text !== undefined))
          throw new Error(`${ws}: a "goto" step has a path, a "click" step a target, a "fill" step a target and a text`)
        if (st.path !== undefined && (typeof st.path !== 'string' || !st.path.startsWith('/'))) throw new Error(`${ws}: path must start with /`)
        if (st.target !== undefined && (typeof st.target !== 'string' || !TARGET.test(st.target))) throw new Error(`${ws}: target must be "<testId>" or "<testId>.<n>"`)
        if (st.text !== undefined && typeof st.text !== 'string') throw new Error(`${ws}: text must be a string`)
        if (st.ui !== 'goto' && st.expect?.status !== undefined) throw new Error(`${ws}: only a "goto" step has a status`)
      } else {
        keys(st, ['method', 'path', 'body', 'headers', 'expect', 'capture', 'service'], ws)
        if (st.service !== undefined && (st.service !== true || st.headers !== undefined || ![CONTROL.set, CONTROL.list].includes(`${st.method} ${String(st.path).split('?')[0]}`)))
          throw new Error(`${ws}: a service step is "${CONTROL.set}" or "${CONTROL.list}" with "service": true and no headers`)
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(st.method)) throw new Error(`${ws}: bad method`)
        if (typeof st.path !== 'string' || !st.path.startsWith('/')) throw new Error(`${ws}: path must start with /`)
        if (st.method === 'GET' && st.body !== undefined) throw new Error(`${ws}: GET cannot have a body`)
        if (st.headers !== undefined && (!isObj(st.headers) || !Object.values(st.headers).every((v) => typeof v === 'string'))) throw new Error(`${ws}: bad headers`)
        if (st.expect === undefined) throw new Error(`${ws}: expect must be an object`)
      }
      if (st.capture !== undefined && (!isObj(st.capture) || !Object.values(st.capture).every((v) => typeof v === 'string'))) throw new Error(`${ws}: bad capture`)
      const e = st.expect ?? {} // only a ui action may have nothing to check
      if (!isObj(e)) throw new Error(`${ws}: expect must be an object`)
      keys(e, ['status', 'json', 'jsonHas', 'jsonAbsent', 'isArray', 'length'], `${ws}.expect`)
      if (st.expect !== undefined && Object.keys(e).length === 0) throw new Error(`${ws}: expect must contain at least one check`)
      if (e.status !== undefined && !(Number.isInteger(e.status) || (Array.isArray(e.status) && e.status.length > 0 && e.status.every(Number.isInteger)))) throw new Error(`${ws}: bad expect.status`)
      if (e.jsonHas !== undefined && !(Array.isArray(e.jsonHas) && e.jsonHas.length > 0 && e.jsonHas.every((p: unknown) => typeof p === 'string'))) throw new Error(`${ws}: bad expect.jsonHas`)
      if (e.jsonAbsent !== undefined && !(Array.isArray(e.jsonAbsent) && e.jsonAbsent.length > 0 && e.jsonAbsent.every((p: unknown) => typeof p === 'string'))) throw new Error(`${ws}: bad expect.jsonAbsent`)
      // A file the step does not read is never in the envelope: naming it would pass whatever the program did.
      const unread = st.run ? (e.jsonAbsent ?? []).find((p: string) => p.startsWith('files.') && !(st.read ?? []).some((r: string) => p === `files.${r}` || p.startsWith(`files.${r}.`))) : undefined
      if (unread !== undefined) throw new Error(`${ws}: expect.jsonAbsent ${unread} names a file that is not in "read"`)
      if (e.isArray !== undefined && typeof e.isArray !== 'boolean') throw new Error(`${ws}: bad expect.isArray`)
      if (e.length !== undefined && !(Number.isInteger(e.length) || (isObj(e.length) && Object.keys(e.length).length > 0 && Object.values(e.length).every(Number.isInteger)))) throw new Error(`${ws}: bad expect.length`)
      // The summary is the only thing the builder may see on failure: it must not carry concrete values.
      // A service set step's body is the control envelope {method, path, status, json?, headers?}: only the canned
      // answer in it (json and headers, keys too, and the path) is scenario data; the envelope keys and method are not (#42).
      const bare = (p: unknown) => (typeof p === 'string' ? [p.split('?')[0].replace(/\{\{\w+\}\}/g, '')] : [])
      const canned = st.service && isObj(st.body) ? [st.body.json, st.body.headers] : []
      const lits = [...(st.run ? [...argvData(st.run, o.commandWords), ...strings(st.stdin), ...strings(st.files), ...Object.keys(st.files ?? {}), ...(st.read ?? []), ...strings(st.env)] : []), ...bare(st.path), ...strings(st.text), ...(st.service ? [...(isObj(st.body) ? bare(st.body.path) : []), ...strings(canned), ...objKeys(canned)] : strings(st.body)), ...strings(e.json), ...strings(st.headers)]
        .filter((v) => v.length >= 3 && v !== '/').map((v) => v.toLowerCase())
      const leaked = lits.find((v) => s.summary.toLowerCase().includes(v))
        ?? [e.status ?? [], ...numbers(st.body), ...numbers(st.files), ...numbers(e.json)].flat().find((c: number) => Math.abs(c) >= 100 && new RegExp(`(?<!\\d)${c}(?!\\d)`).test(s.summary))
      if (leaked !== undefined) bad.push(`scenario "${s.id}": summary contains a concrete value from the steps (${JSON.stringify(String(leaked))}; step ${j}); reword it without that value`)
    }
  }
  if (bad.length) throw new Error(`${bad.length} scenario summar${bad.length === 1 ? 'y' : 'ies'} rejected:\n- ${bad.join('\n- ')}`)
  return x as Scenario[]
}

// ---- matching ----
// Own properties only: 'constructor' etc. must not count as present.
// A key may hold dots (a run's file "plan.json" in the envelope): the shortest run of segments that names an own key is taken, backtracking.
function walk(v: any, segs: string[]): unknown {
  if (!segs.length) return v
  if (v === null || typeof v !== 'object') return undefined
  for (let j = 1; j <= segs.length; j++) {
    const k = segs.slice(0, j).join('.')
    if (Object.hasOwn(v, k)) { const r = walk(v[k], segs.slice(j)); if (r !== undefined) return r }
  }
  return undefined
}
export const get = (o: any, path: string): any => walk(o, path.split('.'))

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
  // Keys too: an object keyed by captured ids ({"{{a}}": 1}) is common, and an unfilled key reaches the app as is.
  if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k.replace(/\{\{(\w+)\}\}/g, (_, n) => String(need(n))), fill(v, vars)]))
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

// The page is read with whitespace collapsed and trimmed (browser.ts SNAPSHOT): a ui step's expected strings are read the same way.
const squash = (x: unknown): unknown => typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : Array.isArray(x) ? x.map(squash) : isObj(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, squash(v)])) : x

export function checkStep(st: Step, status: number, json: unknown, vars: Record<string, unknown>, headers?: Headers): string | null {
  const e = st.expect ?? {}
  const statuses = e.status === undefined ? null : ([] as number[]).concat(e.status)
  if (statuses && !statuses.includes(status)) return `expected status ${statuses.join('|')}, got ${status}`
  if (e.isArray !== undefined && Array.isArray(json) !== e.isArray) return `expected isArray=${e.isArray}`
  for (const [p, n] of lengthChecks(e)) {
    const v = at(json, p)
    if (!Array.isArray(v) || v.length !== n) return `expected length ${n}${p ? ` at ${p}` : ''}, got ${Array.isArray(v) ? v.length : 'non-array'}`
  }
  for (const p of e.jsonHas ?? []) if (get(json, p) === undefined) return `response missing ${p}`
  for (const p of e.jsonAbsent ?? []) if (get(json, p) !== undefined) return `response has ${p}, expected it absent`
  if (e.json !== undefined && !subset(st.ui ? squash(fill(e.json, vars)) : fill(e.json, vars), json)) return 'response body did not match expected subset'
  for (const [name, p] of Object.entries(st.capture ?? {})) {
    const v = p.startsWith(HEADER) ? (headers?.get(p.slice(HEADER.length)) ?? undefined) : get(json, p)
    if ((vars[name] = v) === undefined) return `capture ${name} missing from response`
  }
  return null
}

// The request exactly as it is sent (the approval summary shows the same object): path and body after
// placeholder substitution, headers with the default content-type applied. vars null (#30, a user action): sent literally.
export function buildRequest(st: Omit<Step, 'expect'>, vars: Record<string, unknown> | null) {
  const f = (x: unknown) => (vars ? fill(x, vars) : x)
  const path = f(st.path) as string
  const body = st.body === undefined ? undefined : JSON.stringify(f(st.body))
  // Header names are case-insensitive: a scenario's own "Content-Type" replaces the default, never joins it
  // (a plain-object merge sent "application/json, application/json").
  const headers = new Headers(f(st.headers ?? {}) as Record<string, string>)
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return { method: st.method, path, body, headers }
}

// A body as the approval summary shows it: past BODY_MAX chars it is cut, and the cut is said.
export const BODY_MAX = 600
export const clip = (b: string) => (b.length > BODY_MAX ? `${b.slice(0, BODY_MAX)}... (truncated, ${b.length} chars)` : b)

// #45: what the app sent the fake, for the detail of a failed service step (the fake goes with the scenario).
// Method, path and body only; the detail never reaches a builder (roles.ts: feedbackFor).
function fakeLog(fake: Fake): string {
  const log = fake.control('GET', '/requests', undefined).json as { method: string; path: string; body: unknown }[]
  return `; the fake received ${log.length} request(s)${log.map((r, i) => `\n  ${i + 1}. ${r.method} ${r.path} body: ${r.body === undefined ? 'none' : clip(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))}`).join('')}`
}

async function send(port: number, st: Omit<Step, 'expect'>, vars: Record<string, unknown> | null, signal: AbortSignal) {
  const { path, body, headers } = buildRequest(st, vars)
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: st.method, body, headers,
    redirect: 'manual', // judge the tested endpoint's own response, never a redirect target
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  const raw = await text(res)
  let json: unknown
  try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
  return { res, json, raw }
}

// steps[i] is step from + i + 1 of the scenario. port 0: the app is not started yet (only service steps run).
// A ui step: act, then re-read the page until the checks pass or settleMs pass (pages update asynchronously), and report
// the last failure. Each read is checked against a copy of vars: only the passing read's captures are kept.
async function uiStep(ui: { browser?: Browser }, st: Step, port: number, vars: Record<string, unknown>, signal: AbortSignal): Promise<string | null> {
  ui.browser ??= await openBrowser(port, signal)
  const status = await ui.browser.act({ ui: st.ui!, target: st.target, path: st.path === undefined ? undefined : fill(st.path, vars) as string, text: st.text === undefined ? undefined : String(fill(st.text, vars)) }, port)
  const end = Date.now() + UI_LIMITS.settleMs
  for (;;) {
    let failed: string | null
    try {
      const page: Record<string, unknown> = await ui.browser.snapshot()
      for (const [p] of lengthChecks(st.expect ?? {})) { const id = p.split('.')[0]; if (id && !Object.hasOwn(page, id)) page[id] = [] } // none visible: an empty list
      const v = { ...vars }
      if (!(failed = checkStep(st, status, page, v))) { Object.assign(vars, v); return null }
    } catch (err) {
      if (signal.aborted) throw err
      failed = (err as Error).message // e.g. read while the page navigates: read again
    }
    if (Date.now() >= end) return failed
    await new Promise((r) => setTimeout(r, 100))
  }
}

// prog (the spec declares a command-line program): where its run steps start it.
type Prog = { appDir: string; work: string; contract: Contract; service?: { port: number; connect: () => Duplex } }
async function runSteps(port: number, steps: Step[], from: number, vars: Record<string, unknown>, fake: Fake | undefined, signal: AbortSignal, ui?: { browser?: Browser }, prog?: Prog): Promise<{ failedStep?: number; detail: string }> {
  for (const [i, st] of steps.entries()) {
    const n = from + i + 1
    try {
      let failed: string | null
      if (st.run) {
        if (!prog) return { failedStep: n, detail: `step ${n}: the spec declares no command-line program` }
        const r = await runProgram(prog, {
          argv: (fill(st.run, vars) as unknown[]).map(String), stdin: st.stdin === undefined ? undefined : String(fill(st.stdin, vars)),
          files: st.files === undefined ? undefined : Object.fromEntries(Object.entries(fill(st.files, vars) as Record<string, unknown>).map(([f, c]) => [f, typeof c === 'string' ? c : JSON.stringify(c)])),
          read: st.read === undefined ? undefined : (fill(st.read, vars) as unknown[]).map(String), env: st.env === undefined ? undefined : Object.fromEntries(Object.entries(fill(st.env, vars) as Record<string, unknown>).map(([k, e]) => [k, String(e)])),
        }, signal)
        failed = checkStep(st, r.status, r.json, vars)
      } else if (prog && !st.service) {
        return { failedStep: n, detail: `step ${n}: a command-line program is checked with run steps and service steps only` }
      } else if (st.service) {
        if (!fake) return { failedStep: n, detail: `step ${n}: the spec declares no external service` }
        const r = fake.control(st.method, fill(st.path, vars) as string, st.body === undefined ? undefined : fill(st.body, vars))
        failed = checkStep(st, r.status, r.json, vars)
      } else if (st.ui) {
        if (!ui) return { failedStep: n, detail: `step ${n}: the spec declares no browser UI` }
        failed = await uiStep(ui, st, port, vars, signal)
      } else {
        const { res, json } = await send(port, st, vars, signal)
        failed = checkStep(st, res.status, json, vars, res.headers)
      }
      if (failed) return { failedStep: n, detail: `step ${n}: ${failed}${st.service ? fakeLog(fake!) : ''}` }
    } catch (err) {
      if (signal.aborted) throw err
      return { failedStep: n, detail: `step ${n}: ${(err as Error).message}${st.service && fake ? fakeLog(fake) : ''}` }
    }
  }
  return { detail: 'ok' }
}

// Starts the app fresh (own data dir, own port), runs `go` against it, always stops it.
// When the app does not start, `failed` gets why.
async function withApp<T>(appDir: string, signal: AbortSignal, go: (port: number) => Promise<T>, failed: (why: string) => T, fake?: Fake): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'factory-data-'))
  const port = await freePort()
  let sport = 0 // the service port only exists inside the app's network namespace; any port but the app's will do
  while (fake && (!sport || sport === port)) sport = await freePort()
  const app = spawnApp(appDir, port, dataDir, undefined, fake && { port: sport, connect: () => fake.connect() })
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

// o.service (#17, the approved spec declares an external service): a fresh fake per scenario; the
// scenario's leading service steps run before the app starts, so an app that calls the service at startup sees them.
// o.ui (#4, the spec declares a browser UI): a fresh browser per scenario, opened at its first ui step.
// o.run (the spec declares a command-line program): the scenario's run steps start it in a fresh working directory; no app server is started.
export type JudgeOpts = { service?: boolean; ui?: boolean; run?: Contract }
export const judgeOpts = (spec: string): JudgeOpts => ({ service: usesService(spec), ui: usesUi(spec), ...(usesRun(spec) ? { run: contractOf(spec) } : {}) })
export async function runScenario(appDir: string, s: Scenario, signal: AbortSignal, o: JudgeOpts = {}): Promise<ScenarioResult> {
  const base = { id: s.id, inSpec: s.inSpec, kind: s.kind }
  const stray = s.steps.findIndex((st) => st.run)
  if (!o.run && stray >= 0) return { ...base, pass: false, failedStep: stray + 1, detail: `step ${stray + 1}: the spec declares no command-line program` }
  if (o.run) { // no server: one working directory for the whole scenario, so a later run sees what an earlier one wrote
    const work = mkdtempSync(join(tmpdir(), 'factory-work-'))
    const fake = o.service ? startFake() : undefined // fresh per scenario, as for a server
    try {
      // The service port only exists inside the program's network namespace; any port will do. {{SERVICE_URL}} is the same address as the program's SERVICE_URL.
      const service = fake && { port: await freePort(), connect: () => fake.connect() }
      const r = await runSteps(0, s.steps, 0, service ? { SERVICE_URL: serviceUrl(service.port) } : {}, fake, signal, undefined, { appDir, work, contract: o.run, service })
      if (r.failedStep === undefined && fake?.overflow()) return { ...base, pass: false, failedStep: s.steps.length, detail: 'the program sent the external service more than the fake keeps' }
      return { ...base, pass: r.failedStep === undefined, ...r }
    } finally { fake?.close(); removeTree(work) }
  }
  const fake = o.service ? startFake() : undefined
  const ui: { browser?: Browser } | undefined = o.ui ? {} : undefined
  try {
    const vars: Record<string, unknown> = {}
    const first = s.steps.findIndex((st) => !st.service)
    const lead = !fake ? 0 : first < 0 ? s.steps.length : first
    const pre = await runSteps(0, s.steps.slice(0, lead), 0, vars, fake, signal)
    if (pre.failedStep !== undefined) return { ...base, pass: false, ...pre }
    return await withApp(appDir, signal, async (port) => {
      const r = await runSteps(port, s.steps.slice(lead), lead, vars, fake, signal, ui).finally(() => ui?.browser?.close())
      if (r.failedStep === undefined && fake?.overflow()) return { ...base, pass: false, failedStep: s.steps.length, detail: 'the app sent the external service more than the fake keeps' }
      return { ...base, pass: r.failedStep === undefined, ...r }
    }, (detail) => ({ ...base, pass: false, failedStep: 0, detail }), fake)
  } finally { fake?.close() }
}

// ---- user sessions (#30) ----
// One app (with its fake and browser, as for a scenario) kept running while `go` sends it actions one by one, as a user would:
// its data stays between actions. An action is a step without checks; what comes back is what a user sees of it (bounded by user.ts).
// The app starts at the first action that is not a service action, so service answers set before it are there when it starts.
export type Action = Omit<Step, 'expect' | 'capture'>
export type Seen = { status?: number; headers?: Record<string, string>; body?: string; page?: Record<string, string[]>; error?: string }
export async function withSession<T>(appDir: string, signal: AbortSignal, o: JudgeOpts, go: (act: (a: Action) => Promise<Seen>) => Promise<T>, failed: (why: string) => T): Promise<T> {
  const fake = o.service ? startFake() : undefined
  const ui: { browser?: Browser } = {}
  class Down extends Error {}
  let app: { port: Promise<number>; done: () => void; run: Promise<unknown> } | undefined
  const start = () => {
    let done!: () => void, up!: (p: number) => void, down!: (e: unknown) => void
    const end = new Promise<void>((r) => (done = r)), port = new Promise<number>((ok, ko) => { up = ok; down = ko })
    const run = withApp(appDir, signal, (p) => { up(p); return end }, (why) => down(new Down(why)), fake).catch(down)
    return { port, done, run }
  }
  // Past the fake's limits it cuts the app's traffic: every later result says so, as a scenario fails then.
  const act = async (a: Action): Promise<Seen> => {
    const seen = await act1(a)
    return fake?.overflow() ? { ...seen, error: `${seen.error ? `${seen.error}; ` : ''}the app sent the external service more than the fake keeps (later traffic was cut)` } : seen
  }
  const act1 = async (a: Action): Promise<Seen> => {
    try {
      if (a.service) {
        if (!fake) return { error: 'this app declares no external service' }
        const r = fake.control(a.method, a.path, a.body)
        return { status: r.status, ...(r.json === undefined ? {} : { body: JSON.stringify(r.json) }) }
      }
      const port = await (app ??= start()).port
      if (a.ui) {
        if (!o.ui) return { error: 'this app declares no browser pages' }
        ui.browser ??= await openBrowser(port, signal)
        const status = await ui.browser.act({ ui: a.ui, target: a.target, path: a.path, text: a.text }, port)
        // ponytail: a fixed pause before reading the page (scenarios re-read until their checks pass; a user has no checks).
        await new Promise((r) => setTimeout(r, 500))
        return { ...(a.ui === 'goto' ? { status } : {}), page: await ui.browser.snapshot() }
      }
      const { res, raw } = await send(port, a, null, signal)
      return { status: res.status, headers: Object.fromEntries(res.headers), body: raw }
    } catch (err) {
      if (signal.aborted || err instanceof Down) throw err
      return { error: (err as Error).message }
    }
  }
  try {
    return await go(act)
  } catch (e) {
    if (e instanceof Down) return failed(e.message)
    throw e
  } finally {
    await ui.browser?.close()
    app?.done()
    await app?.run
    fake?.close()
  }
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

export async function runScenarios(appDir: string, scenarios: Scenario[], signal: AbortSignal, o: JudgeOpts = {}): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const s of scenarios) {
    if (signal.aborted) throw new Error('stopped')
    out.push(await runScenario(appDir, s, signal, o)) // ponytail: sequential; parallelize if scenario count grows
  }
  return out
}
