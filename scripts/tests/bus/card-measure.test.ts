import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, MERGE_DONE, REVIEW_RECORDED, SESSION_HEARTBEAT } from '../../core/events.js'
import { cardMeasure, categoryOf, findingsOf, measureLines, runCardMeasure } from '../../window/card-measure.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CUT = '2026-11-07T00:00:00.000Z'
const WINDOW = { before: CUT, after: CUT }
const EARLY = '2026-11-01T00:00:00.000Z'
const LATE = '2026-11-08T00:00:00.000Z'
const HEAD_ONE = '1'.repeat(40)
const HEAD_TWO = '2'.repeat(40)
const OUTSIDE = 'scripts/x.ts is outside the touches of card #1 (scripts/y.ts, package.json)'
const roots: string[] = []
const dbs: DatabaseSync[] = []
let sequence = 0

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): { db: DatabaseSync, file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'card-measure-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  const db = openBus(file)
  dbs.push(db)
  return { db, file }
}

function put(db: DatabaseSync, type: string, ts: string, card: number, payload: object, pr: number | null = null, head: string | null = null): void {
  sequence += 1
  appendEvent(db, { ts, type, actor: 'policy', cardId: card, pr, head, dedupeKey: `${type}:${card}:${sequence}`, payload: JSON.stringify(payload), legacy: false })
}

function admitted(db: DatabaseSync, card: number, size: string): void {
  put(db, CARD_ADMITTED, EARLY, card, { card: `#${card} sized [implement/netwatch/${size}/cheap/owner] · depends — · blocks —`, lane: 'lane-a' })
}

function merged(db: DatabaseSync, card: number, ts: string): void {
  put(db, MERGE_DONE, ts, card, {}, card)
}

function beat(db: DatabaseSync, card: number, session: string, step: string, spent: number): void {
  put(db, SESSION_HEARTBEAT, EARLY, card, { step, session, spent })
}

function review(db: DatabaseSync, card: number, head: string, verdict: string, findings: string[] = [], body = 'body'): void {
  put(db, REVIEW_RECORDED, EARLY, card, { verdict, findings, card_body: body }, card, head)
}

describe('sessions and tokens per merged card', () => {
  it('the measure gives sessions and tokens per merged card by size before and after', () => {
    const { db } = bus()
    admitted(db, 1, 'L')
    admitted(db, 2, 'L')
    admitted(db, 3, 'S')
    merged(db, 1, EARLY)
    merged(db, 2, EARLY)
    merged(db, 3, LATE)
    beat(db, 1, 'a', 'launch', 100)
    beat(db, 1, 'a', 'launch', 300)
    beat(db, 1, 'b', 'review', 50)
    beat(db, 2, 'c', 'launch', 150)
    beat(db, 3, 'd', 'launch', 70)
    beat(db, 99, 'never-merged', 'launch', 9999)

    const measure = cardMeasure(db, WINDOW)

    expect(measure.before.L.cards).toEqual({ cards: 2, sessions: 3, tokens: 500 })
    expect(measure.before.S.cards.cards).toBe(0)
    expect(measure.after.S.cards).toEqual({ cards: 1, sessions: 1, tokens: 70 })
    expect(measure.after.L.cards.cards).toBe(0)
    const printed = measureLines(measure, WINDOW).join('\n')
    expect(printed).toContain(`merged before ${CUT}`)
    expect(printed).toContain(`merged at or after ${CUT}`)
  })

  it('the size comes from the latest admission and an unsized card has its own row', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    admitted(db, 1, 'L')
    merged(db, 1, EARLY)
    merged(db, 2, EARLY)
    const { before } = cardMeasure(db, WINDOW)
    expect(before.L.cards.cards).toBe(1)
    expect(before.S.cards.cards).toBe(0)
    expect(before.unknown.cards.cards).toBe(1)
  })

  it('an admission whose line carries the card prefix still gives the size', () => {
    const { db } = bus()
    put(db, CARD_ADMITTED, EARLY, 1, { card: 'card: #1 sized [implement/netwatch/L/cheap/owner] · depends — · blocks —', lane: 'lane-a' })
    merged(db, 1, EARLY)
    expect(cardMeasure(db, WINDOW).before.L.cards.cards).toBe(1)
  })

  it('an admission that holds only the text gives the size from its first line', () => {
    const { db } = bus()
    put(db, CARD_ADMITTED, EARLY, 1, { text: '#1 sized [implement/netwatch/L/cheap/owner] · depends — · blocks —\n\nthe body', lane: 'lane-a' })
    merged(db, 1, EARLY)
    expect(cardMeasure(db, WINDOW).before.L.cards.cards).toBe(1)
  })

  it('the card line wins over the text, and a card line that does not parse falls back to it', () => {
    const { db } = bus()
    put(db, CARD_ADMITTED, EARLY, 1, { card: '#1 sized [implement/netwatch/L/cheap/owner] · depends — · blocks —', text: '#1 sized [implement/netwatch/S/cheap/owner] · depends — · blocks —' })
    put(db, CARD_ADMITTED, EARLY, 2, { card: 'no card line here', text: '#2 sized [implement/netwatch/S/cheap/owner] · depends — · blocks —' })
    merged(db, 1, EARLY)
    merged(db, 2, EARLY)
    const { before } = cardMeasure(db, WINDOW)
    expect(before.L.cards.cards).toBe(1)
    expect(before.S.cards.cards).toBe(1)
  })

  it('an admission with neither field stays unknown and does not undo an earlier size', () => {
    const { db } = bus()
    put(db, CARD_ADMITTED, EARLY, 1, { lane: 'archive' })
    admitted(db, 2, 'M')
    put(db, CARD_ADMITTED, EARLY, 2, { lane: 'archive' })
    merged(db, 1, EARLY)
    merged(db, 2, EARLY)
    const { before } = cardMeasure(db, WINDOW)
    expect(before.unknown.cards.cards).toBe(1)
    expect(before.M.cards.cards).toBe(1)
  })

  it('it writes nothing to the bus', () => {
    const { db, file } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const digest = (): string => createHash('sha256').update(readFileSync(file)).digest('hex')
    const before = digest()
    const lines: string[] = []
    expect(runCardMeasure(['--before', CUT, '--after', CUT], file, line => lines.push(line))).toBe(0)
    expect(lines.join('\n')).toContain('cards, sessions and tokens')
    expect(digest()).toBe(before)
  })

  it('asks for both times and a known category', () => {
    const { file } = bus()
    const lines: string[] = []
    expect(runCardMeasure(['--before', CUT], file, line => lines.push(line))).toBe(2)
    expect(runCardMeasure(['--before', CUT, '--after', CUT, '--list', 'nonsense'], file, line => lines.push(line))).toBe(2)
    expect(lines[1]).toContain('unclassified')
  })

  it('the usage names no pnpm command, so the generated contract/factory.json holds no overlap row for the measure and the owner-commands ratchet does not grow', () => {
    const { file } = bus()
    const lines: string[] = []
    runCardMeasure([], file, line => lines.push(line))
    expect(lines[0]).toMatch(/^usage: card:measure /)
    const { overlaps } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as { overlaps: Record<string, Record<string, number>> }
    expect(Object.values(overlaps).flatMap(files => Object.keys(files))).not.toContain('scripts/window/card-measure.ts')
  })
})

describe('verdict reasons', () => {
  it('a finding no form matches reads unclassified, not behaviour', () => {
    expect(categoryOf('Consider the shape of this arrangement')).toBe('unclassified')
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', ['Consider the shape of this arrangement'])
    expect(cardMeasure(db, WINDOW).before.S.categories).toMatchObject({ unclassified: 1, behaviour: 0 })
    expect(measureLines(cardMeasure(db, WINDOW), WINDOW).join('\n')).toContain('100%')
  })

  it.each([
    ['the exact form of the mechanism', OUTSIDE, 'touches'],
    ['a word in a code name is not the form', 'TreeTask.creates is read wrong and the branch returns null', 'behaviour'],
    ['a bare word touches is not the form', 'the change touches nothing else, consider this', 'unclassified'],
    ['a named witness', 'witness W3 does not prove the clause', 'witnesses'],
    ['a surviving mutation', 'a surviving mutation in the guard', 'mutations'],
    ['an untested branch by what it says', 'the refusal branch is not covered', 'mutations'],
    ['a test about a behaviour by what it says', 'the test passes but the function still writes the wrong file', 'behaviour'],
    ['form', 'the rendered block is stale', 'form'],
    ['a stated defect', 'the merge overwrites a user field', 'behaviour'],
  ])('%s', (_name, finding, category) => {
    expect(categoryOf(finding)).toBe(category)
  })

  it('a finding the review names among its surviving mutations reads as a mutation', () => {
    expect(categoryOf('the guard flips unnoticed', ['the guard flips unnoticed'])).toBe('mutations')
  })

  it('--list prints the texts of one category, only of merged cards', () => {
    const { db, file } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', [OUTSIDE, 'the rendered block is stale'])
    review(db, 2, HEAD_TWO, 'changes', ['not merged: another is outside the touches'])
    expect(findingsOf(db, WINDOW, 'touches').map(found => found.text)).toEqual([OUTSIDE])
    const lines: string[] = []
    expect(runCardMeasure(['--before', CUT, '--after', CUT, '--list', 'form'], file, line => lines.push(line))).toBe(0)
    expect(lines).toEqual(['before #1 PR 1: the rendered block is stale'])
  })
})

describe('tokens by role', () => {
  it('a session under two steps counts once and its spent is not summed twice', () => {
    const { db } = bus()
    admitted(db, 1, 'M')
    merged(db, 1, EARLY)
    beat(db, 1, 'a', 'launch', 100)
    beat(db, 1, 'a', 'launch', 400)
    beat(db, 1, 'a', 'answer', 450)
    beat(db, 1, 'a', 'session', 900)
    beat(db, 1, 'a', 'answer', 1000)

    const { M } = cardMeasure(db, WINDOW).before

    expect(M.sessionsOnce).toBe(1)
    expect(M.cards).toEqual({ cards: 1, sessions: 1, tokens: 1000 })
    expect(M.roles.launch).toEqual({ sessions: 1, tokens: 400 })
    expect(M.roles.answer).toEqual({ sessions: 1, tokens: 150 })
    expect(M.roles.session).toEqual({ sessions: 1, tokens: 450 })
    const sum = Object.values(M.roles).reduce((total, role) => total + role.tokens, 0)
    expect(sum).toBe(M.cards.tokens)
  })

  it('a fall of spent adds nothing to a role and is said', () => {
    const { db } = bus()
    admitted(db, 1, 'M')
    merged(db, 1, EARLY)
    beat(db, 1, 'a', 'launch', 500)
    beat(db, 1, 'a', 'answer', 400)
    beat(db, 1, 'a', 'answer', 600)
    const measure = cardMeasure(db, WINDOW)
    expect(measure.before.M.roles.launch!.tokens).toBe(500)
    expect(measure.before.M.roles.answer!.tokens).toBe(100)
    expect(measure.before.M.spentFalls).toBe(1)
    expect(measureLines(measure, WINDOW).join('\n')).toContain('spent fell 1 times')
  })

  it('shows launch, answer, review and session as rows of their own', () => {
    const { db } = bus()
    admitted(db, 1, 'M')
    merged(db, 1, EARLY)
    beat(db, 1, 'a', 'session', 100)
    const printed = measureLines(cardMeasure(db, WINDOW), WINDOW)
    for (const role of ['launch', 'answer', 'review', 'session', 'every session once'])
      expect(printed.some(line => line.startsWith(`M     ${role}`)), role).toBe(true)
  })
})

describe('mechanism noise', () => {
  it('a changes round followed by a review on the same head reads as noise', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', ['the merge overwrites a user field'], 'first')
    review(db, 1, HEAD_ONE, 'pass', [], 'second')
    expect(cardMeasure(db, WINDOW).before.S.noise).toMatchObject({ rounds: 1, noise: 1, sameHead: 1, outsideOnly: 0, both: 0, sameHeadThenPass: 1, sameHeadBodyChanged: 1 })
  })

  it('a round whose code changed before the next review is no noise', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', ['the merge overwrites a user field'])
    review(db, 1, HEAD_TWO, 'pass')
    expect(cardMeasure(db, WINDOW).before.S.noise).toMatchObject({ rounds: 1, noise: 0, sameHead: 0 })
  })

  it('a round of only the exact outside-the-touches form is noise, and one mixed with a defect is not', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', [OUTSIDE])
    review(db, 1, HEAD_TWO, 'changes', [OUTSIDE, 'the merge overwrites a user field'])
    expect(cardMeasure(db, WINDOW).before.S.noise).toMatchObject({ rounds: 2, noise: 1, sameHead: 0, outsideOnly: 1 })
  })

  it('a round of prose that only names the phrase is not the form the mechanism writes', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', ['Still open: scripts/x.ts and scripts/y.ts are also outside the touches of card #1'])
    review(db, 1, HEAD_TWO, 'pass')
    const { S } = cardMeasure(db, WINDOW).before
    expect(S.noise).toMatchObject({ rounds: 1, noise: 0, outsideOnly: 0 })
    expect(S.categories.touches).toBe(1)
  })

  it('a round that is both counts once and shows under both reasons', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', [OUTSIDE])
    review(db, 1, HEAD_ONE, 'changes', ['the merge overwrites a user field'])
    expect(cardMeasure(db, WINDOW).before.S.noise).toMatchObject({ rounds: 2, noise: 1, sameHead: 1, outsideOnly: 1, both: 1 })
  })

  it('the next review is read within one pull request, not across cards', () => {
    const { db } = bus()
    admitted(db, 1, 'S')
    merged(db, 1, EARLY)
    review(db, 1, HEAD_ONE, 'changes', ['the merge overwrites a user field'])
    review(db, 2, HEAD_ONE, 'pass')
    expect(cardMeasure(db, WINDOW).before.S.noise.sameHead).toBe(0)
  })
})
