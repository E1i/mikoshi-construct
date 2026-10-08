import type { SessionEvidence } from '../../shift/continuation.js'
import { describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, HANDOFF_LIMIT } from '../../ghosts/handoff-check.js'
import { BOUNDARY_LINE, continuationRefusal, continues, eddiesEvidence, exitReason, MAX_RESTARTS } from '../../shift/continuation.js'

const HANDOFF = HANDOFF_FIELDS.map(field => `${field.label}: ${field.label === 'queue' ? '#1 → #2' : 'x'}`).join('\n')
const QUIET: SessionEvidence = { exit: 0, closed: false, stopped: false, refused: false, question: false, boundary: false, warned: false }

describe('exitReason', () => {
  it.each([
    ['a closed task, whatever else happened', { closed: true, stopped: true, warned: true }, 'closed'],
    ['an Eddies stop over its warn', { stopped: true, warned: true }, 'eddies-stop'],
    ['a guard refusal over a warn', { refused: true, warned: true }, 'guard-refusal'],
    ['a question over a warn', { question: true, warned: true }, 'owner-question'],
    ['a question over a boundary', { question: true, boundary: true }, 'owner-question'],
    ['a boundary and a clean exit', { boundary: true }, 'boundary'],
    ['a boundary over a warn', { boundary: true, warned: true }, 'boundary'],
    ['a boundary and a failed exit', { boundary: true, exit: 1 }, 'ended'],
    ['a warn and a clean exit', { warned: true }, 'eddies-warn'],
    ['a warn and a failed exit', { warned: true, exit: 1 }, 'ended'],
    ['a warn and a signal, read as no exit code', { warned: true, exit: null }, 'ended'],
    ['nothing', {}, 'ended'],
  ] as const)('reads %s', (_, evidence, reason) => {
    expect(exitReason({ ...QUIET, ...evidence })).toBe(reason)
  })
})

describe('the boundary line of a report', () => {
  it.each([
    ['a boundary line that names its boundary', 'result: stopped\nboundary: contextLimit 250000\n', true],
    ['a boundary line that names nothing', 'result: stopped\nboundary:\n', false],
    ['a boundary mentioned in the middle of a line', 'result: stopped at boundary: x\n', false],
  ] as const)('reads %s', (_, report, matched) => {
    expect(BOUNDARY_LINE.test(report)).toBe(matched)
  })
})

describe('continues', () => {
  it('restarts only an eddies-warn exit under continue: auto, below the ceiling', () => {
    expect(continues('auto', 'eddies-warn', MAX_RESTARTS - 1, HANDOFF)).toBe(true)
    expect(continues('auto', 'eddies-warn', MAX_RESTARTS, HANDOFF)).toBe(false)
    expect(continues('stop', 'eddies-warn', 0, HANDOFF)).toBe(false)
    expect(continues('auto', 'ended', 0, HANDOFF)).toBe(false)
  })

  it('restarts a boundary exit under continue: auto, below the same ceiling', () => {
    expect(continues('auto', 'boundary', 0, HANDOFF)).toBe(true)
    expect(continues('auto', 'boundary', MAX_RESTARTS - 1, HANDOFF)).toBe(true)
    expect(continues('auto', 'boundary', MAX_RESTARTS, HANDOFF)).toBe(false)
    expect(continues('stop', 'boundary', 0, HANDOFF)).toBe(false)
  })

  it('does not continue from a handoff that lacks a mandatory field, at either exit', () => {
    const lacking = HANDOFF.split('\n').slice(1).join('\n')
    expect(continues('auto', 'eddies-warn', 0, lacking)).toBe(false)
    expect(continues('auto', 'boundary', 0, lacking)).toBe(false)
    expect(continues('auto', 'boundary', 0, '')).toBe(false)
  })
})

describe('eddiesEvidence', () => {
  it('reads only the lines of the given session, and a refusal only from the eddies guard', () => {
    const journal = [
      { event: 'budget-warn', session_id: 'a' },
      { event: 'budget-stop', session_id: 'b' },
      { event: 'unread', hook: 'eddies-prompt', session_id: 'a' },
      { event: 'unread', hook: 'eddies-guard', session_id: 'b' },
    ].map(line => JSON.stringify(line)).join('\n')
    expect(eddiesEvidence(`${journal}\nnot json`, 'a')).toEqual({ warned: true, stopped: false, refused: false })
    expect(eddiesEvidence(journal, 'b')).toEqual({ warned: false, stopped: true, refused: true })
  })

  it.each([
    ['two STOP sections', () => `## STOP — one\n${HANDOFF}\n## STOP — two\n`, 'STOP sections: 2'],
    ['a size over the limit', () => `${HANDOFF}\nnot done: ${'x'.repeat(HANDOFF_LIMIT)}`, 'too large'],
    ['prose in queue', () => HANDOFF.replace('queue: #1 → #2', 'queue: #650 then whatever the owner says'), 'queue: prose'],
  ] as const)('does not continue a Ghost from a handoff the bounded check refuses: %s', (_, handoff, refused) => {
    expect(continues('auto', 'eddies-warn', 0, handoff())).toBe(false)
    expect(continues('auto', 'boundary', 0, handoff())).toBe(false)
    expect(continuationRefusal(handoff())).toMatch(new RegExp(`^handoff-invalid: .*${refused}`))
    expect(continuationRefusal(HANDOFF)).toBeNull()
  })
})
