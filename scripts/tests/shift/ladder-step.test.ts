import type { Card } from '../../../src/card/grammar.js'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../../src/card/grammar.js'
import { approvalSha256, canonicalImplementText } from '../../ghosts/approval.js'
import { approvedSha256Of, briefPathOf, isLadder, ladderStep, tasksFilePathOf, tasksFileText } from '../../shift/ladder.js'
import { approvalLine, BRIEF_TEXT, revokeLine } from './fixtures/ladder-world.js'

function cardOf(line: string): Card {
  const parsed = parseCard(line)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.card
}

const CARD = cardOf('#603 shift-runs-ladder [implement/runner/M/ladder/owner] · depends #602 · blocks —')
const SHA = approvalSha256(canonicalImplementText(BRIEF_TEXT)!)
const APPROVED = approvalLine(603, 'morse')
const entry = (sha = SHA, task = 'shift-runs-ladder'): object => ({ event: 'entry', task, CONTRACT: `ladder · brief b.md approved ${sha.slice(0, 7)} · law brief Acceptance:` })
const ended = (ladder: string, sha = SHA): object => ({ event: 'task', task: 'shift-runs-ladder', approvedSha256: sha, ladder })
const journal = (...lines: object[]): string => `${APPROVED}${lines.map(line => JSON.stringify(line)).join('\n')}\nnot json\n`
const step = (text: string | null, brief: string | null = BRIEF_TEXT): string => ladderStep({ journal: text, brief }, CARD).kind

describe('the ladder step is derived from the journal and the brief', () => {
  it('is brief while there is no brief, no approval event, or an approval of another text', () => {
    expect(step(null, null)).toBe('brief')
    expect(step(null, BRIEF_TEXT)).toBe('brief')
    expect(step(APPROVED, `${BRIEF_TEXT}changed\n`)).toBe('brief')
    expect(step(approvalLine(603, 'morse', '0'.repeat(64)))).toBe('brief')
    expect(step(approvalLine(604, 'morse'))).toBe('brief')
  })

  it('is launch once the current text is approved and no entry names that hash', () => {
    expect(ladderStep({ journal: APPROVED, brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'launch', sha256: SHA })
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
    expect(ladderStep({ journal: journal(entry(), ended('stopped')), brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'fault', why: `the Ghost ended with ladder status 'stopped'` })
  })

  it('is running again when a newer entry follows a finished Ghost', () => {
    expect(step(journal(entry(), ended('done'), entry()))).toBe('running')
  })

  it('a newly approved text is launch even when an older text was launched', () => {
    const olderSha = approvalSha256(canonicalImplementText(`${BRIEF_TEXT}older\n`)!)
    const older = `${approvalLine(603, 'morse', olderSha)}${JSON.stringify(entry(olderSha))}\n`
    expect(ladderStep({ journal: `${older}${APPROVED}`, brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'launch', sha256: SHA })
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

describe('the approved hash of a card is read from the journal alone', () => {
  it('is the current hash when an approval event names it and no revoke does', () => {
    expect(approvedSha256Of({ journal: APPROVED, brief: BRIEF_TEXT }, CARD)).toBe(SHA)
    expect(approvedSha256Of({ journal: `${APPROVED}${revokeLine(603)}`, brief: BRIEF_TEXT }, CARD)).toBeNull()
    expect(approvedSha256Of({ journal: null, brief: BRIEF_TEXT }, CARD)).toBeNull()
  })

  it('is brief after a revoke of that hash, and launch for an approval by the owner as much as by MORSE', () => {
    expect(step(`${APPROVED}${revokeLine(603)}`)).toBe('brief')
    expect(step(approvalLine(603, 'owner'))).toBe('launch')
  })
})
