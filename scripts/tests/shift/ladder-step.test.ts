import type { Card } from '../../../src/card/grammar.js'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../../src/card/grammar.js'
import { approvalSha256, canonicalImplementText } from '../../ghosts/approval.js'
import { briefPathOf, isLadder, ladderStep, tasksFilePathOf, tasksFileText } from '../../shift/ladder.js'
import { BRIEF_TEXT } from './fixtures/ladder-world.js'

function cardOf(line: string): Card {
  const parsed = parseCard(line)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.card
}

const CARD = cardOf('#603 shift-runs-ladder [implement/runner/M/ladder/owner] · depends #602 · blocks —')
const SHA = approvalSha256(canonicalImplementText(BRIEF_TEXT)!)
const APPROVAL = `approved /implement text sha256: ${SHA} sketch: none (2026-10-06, morse)\n`
const entry = (sha = SHA, task = 'shift-runs-ladder'): object => ({ event: 'entry', task, CONTRACT: `ladder · brief b.md approved ${sha.slice(0, 7)} · law brief Acceptance:` })
const ended = (ladder: string, sha = SHA): object => ({ event: 'task', task: 'shift-runs-ladder', approvedSha256: sha, ladder })
const journal = (...lines: object[]): string => `${lines.map(line => JSON.stringify(line)).join('\n')}\nnot json\n`
const step = (text: string | null, brief: string | null = BRIEF_TEXT, approval: string | null = APPROVAL): string => ladderStep({ journal: text, brief, approval }, CARD).kind

describe('the ladder step is derived from the journal and the brief', () => {
  it('is brief while there is no brief, no approval file, or an approval of another text', () => {
    expect(step(null, null, null)).toBe('brief')
    expect(step(null, BRIEF_TEXT, null)).toBe('brief')
    expect(step(null, `${BRIEF_TEXT}changed\n`, APPROVAL)).toBe('brief')
    expect(step(null, BRIEF_TEXT, 'approved nothing')).toBe('brief')
  })

  it('is launch once the current text is approved and no entry names that hash', () => {
    expect(ladderStep({ journal: null, brief: BRIEF_TEXT, approval: APPROVAL }, CARD)).toEqual({ kind: 'launch', sha256: SHA })
    expect(step(journal(entry('0'.repeat(64)), entry(SHA, 'another-task')))).toBe('launch')
  })

  it('is running while an entry has no Ghost task line after it', () => {
    expect(step(journal(entry()))).toBe('running')
    expect(step(journal(ended('done'), entry()))).toBe('running')
    expect(step(journal(entry(), ended('done', '0'.repeat(64))))).toBe('running')
  })

  it('is review when the Ghost task line after the entry says ladder done', () => {
    expect(step(journal(entry(), ended('done')))).toBe('review')
  })

  it('is a fault naming any other ladder status', () => {
    expect(ladderStep({ journal: journal(entry(), ended('stopped')), brief: BRIEF_TEXT, approval: APPROVAL }, CARD)).toEqual({ kind: 'fault', why: `the Ghost ended with ladder status 'stopped'` })
  })

  it('is running again when a newer entry follows a finished Ghost', () => {
    expect(step(journal(entry(), ended('done'), entry()))).toBe('running')
  })
})

describe('the ladder files of a card', () => {
  it('names the brief and the tasks file after the card number and name', () => {
    expect(briefPathOf('/h', CARD)).toBe('/h/brief-603-shift-runs-ladder.md')
    expect(tasksFilePathOf('/h', CARD)).toBe('/h/tasks-603-shift-runs-ladder.json')
  })

  it('writes the tasks file ghosts:launch reads: the card name is the task id', () => {
    expect(JSON.parse(tasksFileText(CARD, { repo: '/r', handoffDir: '/h', brief: '/h/b.md' }))).toEqual({ repo: '/r', status: '/h/status.md', out: '/h', tasks: [{ id: 'shift-runs-ladder', brief: '/h/b.md', card: CARD.line }] })
  })

  it('marks a ladder card by kind and contour, and a probe or a cheap card is not one', () => {
    expect([CARD, cardOf('#1 a [probe/runner/S/ladder/none] · depends — · blocks —'), cardOf('#2 b [implement/runner/S/cheap/auto] · depends — · blocks —')].map(isLadder)).toEqual([true, false, false])
  })
})
