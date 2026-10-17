import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Scenario } from '../src/scenario.ts'
import { approve, hash, stateDir, writeDraft } from '../src/vault.ts'

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

// State dirs must be under $HOME (the repo is), so the sandbox's $HOME tmpfs hides them.
export function freshState(): string {
  mkdirSync(join(REPO, '.worker-scratch'), { recursive: true })
  process.env.FACTORY_HOME = mkdtempSync(join(REPO, '.worker-scratch', 'state-'))
  return stateDir()
}

export const tmp = (p: string) => mkdtempSync(join(tmpdir(), `factory-test-${p}-`))

export function gitTarget(): string {
  const d = tmp('target')
  const g = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  g('init', '-q', '-b', 'main')
  writeFileSync(join(d, 'README.md'), 'practice memo\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
  return d
}

export const SCENARIOS: Scenario[] = [
  { id: 'create-get', title: 'create then get', summary: 'a created note can be fetched by its id', inSpec: true, kind: 'crud',
    steps: [
      { method: 'POST', path: '/notes', body: { title: 'alpha', body: 'beta' }, expect: { status: 201, jsonHas: ['id'] }, capture: { id: 'id' } },
      { method: 'GET', path: '/notes/{{id}}', expect: { status: 200, json: { title: 'alpha' } } },
    ] },
  { id: 'list-empty', title: 'empty list', summary: 'listing on a fresh app returns an empty array', inSpec: true, kind: 'crud',
    steps: [{ method: 'GET', path: '/notes', expect: { status: 200, isArray: true, length: 0 } }] },
  { id: 'update-title', title: 'zebra-unique-777 update', summary: 'updating a note changes its title', inSpec: true, kind: 'crud',
    steps: [
      { method: 'POST', path: '/notes', body: { title: 'old', body: 'x' }, expect: { status: 201 }, capture: { id: 'id' } },
      { method: 'PUT', path: '/notes/{{id}}', body: { title: 'zebra-unique-777' }, expect: { status: 200, json: { title: 'zebra-unique-777' } } },
    ] },
  { id: 'missing-404', title: 'unknown id', summary: 'fetching an unknown note is reported as not found', inSpec: false, kind: 'not-found',
    steps: [{ method: 'GET', path: '/notes/quokka-missing-42', expect: { status: 404 } }] },
]

export function approvedChange(sd: string, id: string, scenarios = SCENARIOS): string {
  const dir = writeDraft(sd, id, { spec: '# Memo API\n- CRUD on /notes\n', scenarios, assumptions: ['ids are strings'] })
  return approve(sd, id, { by: 'test', version: hash(dir) })
}

// A tiny memo server, written by the TEST (standing in for the builder).
export const MEMO_SERVER = `
const http = require('node:http')
const notes = new Map(); let n = 0
const send = (res, s, b) => { res.writeHead(s, {'content-type': 'application/json'}); res.end(JSON.stringify(b)) }
http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const m = req.url.match(/^\\/notes(?:\\/([^/]+))?$/)
    if (!m) return send(res, 404, { error: 'not found' })
    const id = m[1]
    if (!id && req.method === 'GET') return send(res, 200, [...notes.values()])
    if (!id && req.method === 'POST') { const note = { id: String(++n), title: body.title, body: body.body }; notes.set(note.id, note); return send(res, 201, note) }
    const note = notes.get(id)
    if (!note) return send(res, 404, { error: 'not found' })
    if (req.method === 'GET') return send(res, 200, note)
    if (req.method === 'PUT') { Object.assign(note, body, { id }); return send(res, 200, note) }
    if (req.method === 'DELETE') { notes.delete(id); return send(res, 204, {}) }
    send(res, 405, { error: 'method' })
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
`

export function writeApp(dir: string, server: string, start = 'node server.cjs') {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'memo', private: true, scripts: { start } }))
  writeFileSync(join(dir, 'server.cjs'), server)
}

export const CLI_MARKERS = [/error_max|subtype|session_id/, /claude(?!-(?:opus|sonnet|haiku|fable)-)/i, /--output-format/, /total_cost_usd/, /--permission/, /bypassPermissions/, /--max-budget/, /is_error/, /--tools/, /allowedTools/, /setting-sources/, /no-session-persistence/, /stream-json/]
