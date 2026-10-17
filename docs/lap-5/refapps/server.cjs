// Reference split app for validating probes. Strategy from ./strategy.json: {rem, net, payer}.
const http = require('node:http'); const S = require('./strategy.json')
const groups = new Map(); let n = 0; const id = () => String(++n)
const send = (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
function shares(g, e) {
  let bens = [...e.beneficiaryIds]; if (S.payer === 'always' && !bens.includes(e.payerId)) bens.push(e.payerId)
  const k = bens.length, base = Math.floor(e.amount / k), rem = e.amount - base * k, out = {}
  for (const b of bens) out[b] = S.rem === 'exact' ? e.amount / k : base
  if (S.rem === 'exact' || rem === 0) return out
  const order = g.members.map((m) => m.id).filter((x) => bens.includes(x))
  let pick
  if (S.rem === 'payer') pick = () => e.payerId
  if (S.rem === 'first') pick = () => e.beneficiaryIds[0]
  if (S.rem === 'last') pick = () => e.beneficiaryIds[e.beneficiaryIds.length - 1]
  if (S.rem === 'random') pick = () => order[Math.floor(Math.random() * order.length)]
  if (S.rem === 'rotate' || S.rem === 'nonpayer') pick = () => {
    const pool = S.rem === 'nonpayer' && order.some((x) => x !== e.payerId) ? order.filter((x) => x !== e.payerId) : order
    return pool.reduce((best, x) => ((g.extra[x] ?? 0) < (g.extra[best] ?? 0) ? x : best), pool[0])
  }
  for (let i = 0; i < rem; i++) { const w = pick(); out[w] = (out[w] ?? 0) + 1; g.extra[w] = (g.extra[w] ?? 0) + 1 }
  return out
}
function settle(g) {
  if (S.net === 'pairwise') {
    const owe = {}
    for (const e of g.expenses) for (const [m, s] of Object.entries(e.shares)) if (m !== e.payerId) owe[m + '>' + e.payerId] = (owe[m + '>' + e.payerId] ?? 0) + s
    const t = []
    for (const [k, v] of Object.entries(owe)) { const [f, to] = k.split('>'); const back = owe[to + '>' + f] ?? 0; if (v - back > 0) t.push({ fromMemberId: f, toMemberId: to, amount: Math.round(v - back) }) }
    return t
  }
  const bal = {}; for (const m of g.members) bal[m.id] = 0
  for (const e of g.expenses) { bal[e.payerId] += e.amount; for (const [m, s] of Object.entries(e.shares)) bal[m] -= s }
  for (const m in bal) bal[m] = Math.round(bal[m])
  const t = []
  for (;;) {
    const ids = Object.keys(bal), d = ids.reduce((a, b) => (bal[b] < bal[a] ? b : a)), c = ids.reduce((a, b) => (bal[b] > bal[a] ? b : a))
    const x = Math.min(-bal[d], bal[c]); if (x <= 0) return t
    t.push({ fromMemberId: d, toMemberId: c, amount: x }); bal[d] += x; bal[c] -= x
  }
}
http.createServer((req, res) => { let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
  const body = raw ? JSON.parse(raw) : {}; const p = req.url.split('/').filter(Boolean)
  if (req.method === 'POST' && p.length === 1) { const g = { id: id(), name: body.name, members: body.members.map((m) => ({ id: id(), name: m.name })), expenses: [], extra: {} }; groups.set(g.id, g); return send(res, 201, { id: g.id, name: g.name, members: g.members }) }
  const g = groups.get(p[1]); if (!g) return send(res, 404, {})
  if (req.method === 'POST' && p[2] === 'expenses') {
    const ids = g.members.map((m) => m.id)
    if (!Number.isInteger(body.amount) || body.amount <= 0 || !Array.isArray(body.beneficiaryIds) || !body.beneficiaryIds.length || !ids.includes(body.payerId) || !body.beneficiaryIds.every((b) => ids.includes(b))) return send(res, 400, {})
    if (S.payer === 'refuse' && !body.beneficiaryIds.includes(body.payerId)) return send(res, 400, {}); const e = { id: id(), groupId: g.id, ...body }; e.shares = shares(g, e); g.expenses.push(e); return send(res, 201, e) }
  if (p[2] === 'settlement') return send(res, 200, { groupId: g.id, transfers: settle(g) })
  send(res, 404, {})
}) }).listen(Number(process.env.PORT), '127.0.0.1')
