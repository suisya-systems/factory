// What a rejected builder learns: summaries only, never scenario bodies or the judge's reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineVerdict, extractJson, feedbackFor, type Verdict } from '../src/roles.ts'
import { validateScenarios } from '../src/scenario.ts'
import { SCENARIOS } from './helpers.ts'

test('feedbackFor never carries paths, bodies, expectations, details or the judge reason', () => {
  const v: Verdict = {
    pass: false, testsAllPass: false, llmPass: false, approvedVersion: 'v',
    reason: 'PUT /notes/{{id}} with {"title":"zebra-unique-777"} must return 200; GET /notes/quokka-missing-42 -> 404',
    results: [
      { id: 'update-title', inSpec: true, kind: 'crud', pass: false, failedStep: 2, detail: 'step 2: expected status 200, got 500 zebra-unique-777' },
      { id: 'missing-404', inSpec: false, kind: 'not-found', pass: false, failedStep: 1, detail: 'step 1: expected status 404, got 200' },
      { id: 'list-empty', inSpec: true, kind: 'crud', pass: true, detail: 'ok' },
    ],
  }
  const fb = feedbackFor(v, SCENARIOS)
  assert.match(fb, /updating a note changes its title/)
  assert.match(fb, /fetching an unknown note is reported as not found/)
  assert.match(fb, /LLM judge did not approve/)
  assert.doesNotMatch(fb, /listing on a fresh app/) // passed scenarios are not mentioned
  // lap 7 control: one line per failed scenario and the LLM flag, no summary
  assert.equal(feedbackFor(v, SCENARIOS, 'bare'), '- failed: a hidden scenario\n- failed: a hidden scenario\n- LLM judge did not approve')
  for (const leak of ['zebra-unique-777', 'quokka-missing-42', '/notes', '404', '200', 'status', 'step', '{{', 'PUT']) assert.ok(!fb.includes(leak), `leaked ${leak}`)
})

test('scenario validation rejects malformed drafter output and value-carrying summaries', () => {
  assert.doesNotThrow(() => validateScenarios(SCENARIOS))
  const bad = (patch: object) => [{ ...SCENARIOS[3], ...patch }]
  assert.throws(() => validateScenarios(bad({ summary: 'GET /notes/quokka-missing-42 returns 404' })), /concrete value/)
  assert.throws(() => validateScenarios(bad({ inSpec: 'yes' })), /inSpec/)
  assert.throws(() => validateScenarios(bad({ extra: 1 })), /unknown field/)
  assert.throws(() => validateScenarios(bad({ steps: [{ method: 'HACK', path: '/', expect: {} }] })), /method/)
  assert.throws(() => validateScenarios(bad({ summary: 'two\nlines' })), /one line/)
  assert.throws(() => validateScenarios([]), /non-empty/)
  const step = (st: object) => bad({ steps: [{ method: 'GET', path: '/x', expect: { status: 200 }, ...st }] })
  assert.throws(() => validateScenarios(step({ body: {} })), /GET cannot have a body/)
  assert.throws(() => validateScenarios(step({ expect: {} })), /at least one check/)
  assert.throws(() => validateScenarios(step({ expect: { status: [] } })), /expect.status/)
  assert.throws(() => validateScenarios(bad({ summary: 'missing title says Title Is Required', steps: [{ method: 'POST', path: '/x', body: {}, expect: { json: { error: 'title is required' } } }] })), /concrete value/)
  assert.throws(() => validateScenarios(bad({ summary: 'missing title gives 422' , steps: [{ method: 'POST', path: '/x', body: {}, expect: { status: 422 } }] })), /concrete value/)
  // lap 4: amounts (3+ digits) in the body or the expected json are values too; small counts are not
  const split = (summary: string) => validateScenarios(bad({ summary, steps: [{ method: 'POST', path: '/x', body: { amount: 1000 }, expect: { json: { shares: [334, 333, 333], members: 3 } } }] }))
  for (const leak of ['the payer of 1000 is owed by two', 'one share gets 334 and the rest less']) assert.throws(() => split(leak), /concrete value/)
  assert.doesNotThrow(() => split('a shared expense is split among 3 members, the remainder going to one of them'))
  assert.doesNotThrow(() => split('amounts like 10000 are fine when the steps do not use them'))
})

test('every bad summary is reported at once, each with its scenario id, the rule and the value (#31)', () => {
  const sc = (id: string, summary: string, body: object) => ({ ...SCENARIOS[3], id, summary, steps: [{ method: 'POST', path: '/x', body, expect: { status: 201 } }] })
  const all = [sc('a', 'fine summary', {}), sc('b', 'ann pays', { who: 'ann' }), sc('c', 'two\nlines', {}), sc('d', 'x'.repeat(201), {})]
  try { validateScenarios(all); assert.fail('should throw') } catch (e) {
    const m = (e as Error).message
    assert.match(m, /3 scenario summaries rejected/)
    assert.match(m, /scenario "b": .*concrete value .*"ann"/)
    assert.match(m, /scenario "c": .*one line.* 2 line/)
    assert.match(m, /scenario "d": .*201 chars/)
    assert.doesNotMatch(m, /scenario "a"/)
  }
})

test('combineVerdict defaults to AND; extractJson handles fenced and embedded JSON', () => {
  assert.deepEqual([combineVerdict(true, true), combineVerdict(true, false), combineVerdict(false, true)], [true, false, false])
  assert.deepEqual(extractJson('sure:\n```json\n{"pass":true}\n```'), { pass: true })
  assert.deepEqual(extractJson('verdict {"pass":false,"reason":"x"} done'), { pass: false, reason: 'x' })
  assert.throws(() => extractJson('nothing here'))
})
