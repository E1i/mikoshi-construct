import type { SessionEvidence } from '../../shift/continuation.js'
import { describe, expect, it } from 'vitest'
import { continues, eddiesEvidence, exitReason, MAX_RESTARTS } from '../../shift/continuation.js'

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

describe('continues', () => {
  it('restarts only an eddies-warn exit under continue: auto, below the ceiling', () => {
    expect(continues('auto', 'eddies-warn', MAX_RESTARTS - 1)).toBe(true)
    expect(continues('auto', 'eddies-warn', MAX_RESTARTS)).toBe(false)
    expect(continues('stop', 'eddies-warn', 0)).toBe(false)
    expect(continues('auto', 'ended', 0)).toBe(false)
  })

  it('restarts a boundary exit under continue: auto, below the same ceiling', () => {
    expect(continues('auto', 'boundary', 0)).toBe(true)
    expect(continues('auto', 'boundary', MAX_RESTARTS - 1)).toBe(true)
    expect(continues('auto', 'boundary', MAX_RESTARTS)).toBe(false)
    expect(continues('stop', 'boundary', 0)).toBe(false)
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
})
