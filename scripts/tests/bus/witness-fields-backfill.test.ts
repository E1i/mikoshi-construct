import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { witnessFieldsLine } from '../../../src/card/witness-fields.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, REJECTED, WITNESS_FIELDS_BACKFILLED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { backfillWitnessFields, recordedWitnessFieldsBackfill, witnessFieldsBackfillOf, witnessFieldsOfCard } from '../../intake/witness-fields-backfill.js'
import { cardWitnessesOf } from '../../policy/policy.js'
import { busProjections } from '../../supervisor/composition.js'

const NOW = '2026-11-04T12:00:00.000Z'
const NAMED_RUN = 'pnpm exec vitest run tests/a.test.ts -t \'the thing is done\''
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, witnesses: readonly string[], extra: readonly string[] = []): string {
  return [
    `card: #${id} old-card [implement/runner/S/cheap/auto] · depends — · blocks —`,
    `branch: feat/old-${id}`,
    'touches: src/board/run.ts',
    'continue: stop',
    'who: shift',
    '',
    'Do the thing.',
    '',
    ...extra,
    'Witnesses:',
    ...witnesses.map(witness => `- ${witness}`),
    '',
  ].join('\n')
}

function freshBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'witness-backfill-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function admitted(db: DatabaseSync, id: number, text: string): void {
  appendEvent(db, { ts: NOW, type: CARD_ADMITTED, actor: 'worker:intake:test', cardId: id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${id}:${textSha(text)}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: 'lane-window', text, textSha: textSha(text) }, legacy: false })
  reduce(db, 'pending', busProjections())
}

function bodies(db: DatabaseSync): { card_id: number, text: string, text_sha: string, admission_event_id: number }[] {
  return db.prepare(`SELECT card_id, text, text_sha, admission_event_id FROM ${CARD_BODIES} ORDER BY card_id`).all() as { card_id: number, text: string, text_sha: string, admission_event_id: number }[]
}

function countOf(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

describe('the witness fields backfill', () => {
  it('an old card after the backfill gives the same witnesses, red on main and green on head', () => {
    const text = cardText(90, [
      `a new test: the thing is done: \`${NAMED_RUN}\` exits 0 on head and fails on main`,
      '`pnpm exec vitest run tests/b.test.ts` exits 1 on head and 0 on base',
      '`pnpm run quality` stays green',
      '`test -f a.txt` and `test -f b.txt` hold',
    ], ['Runs: tests/**, scripts/tests/bus/card.test.ts'])
    const { cards, unparsed } = witnessFieldsBackfillOf([{ card: 90, text }])
    expect(unparsed).toEqual([])
    const { witnesses, runs } = cards['90']!
    const before = cardWitnessesOf(text)
    const after = cardWitnessesOf(witnessFieldsLine(witnesses))
    expect(after.acceptance.map(witness => witness.command)).toEqual(before.acceptance.map(witness => witness.command))
    expect(after.invariants.map(witness => witness.command)).toEqual(before.invariants.map(witness => witness.command))
    expect(witnesses).toEqual([
      { id: 'W1', run: 'pnpm exec vitest run tests/a.test.ts', test: 'the thing is done', head: 'pass', base: 'fail', proves: 'a new test: the thing is done: exits 0 on head and fails on main' },
      { id: 'W2', run: '! pnpm exec vitest run tests/b.test.ts', test: null, head: 'pass', base: 'fail', proves: 'exits 1 on head and 0 on base' },
      { id: 'W3', run: 'pnpm run quality', test: null, head: 'pass', base: 'pass', proves: 'stays green' },
      { id: 'W4', run: 'test -f a.txt', test: null, head: 'pass', base: 'pass', proves: 'and hold' },
      { id: 'W5', run: 'test -f b.txt', test: null, head: 'pass', base: 'pass', proves: 'and hold' },
    ])
    expect(runs).toEqual(['tests/**', 'scripts/tests/bus/card.test.ts'])
  })

  it('one backfill event lists what did not parse and changes no body sha', () => {
    const db = freshBus()
    const parsed = cardText(90, [`\`${NAMED_RUN}\` exits 0; red on main`])
    const prose = cardText(91, ['the owner reads the page', `\`${NAMED_RUN}\` exits 0; red on main`])
    const badRuns = cardText(92, [`\`${NAMED_RUN}\` exits 0; red on main`], ['Runs: src/board/run.ts'])
    const withFields = `${cardText(93, []).replace('Witnesses:\n', '')}${witnessFieldsLine([{ id: 'W1', run: 'test -f a', test: null, head: 'pass', base: 'fail', proves: 'a is there' }])}\n`
    for (const [id, text] of [[90, parsed], [91, prose], [92, badRuns], [93, withFields]] as const)
      admitted(db, id, text)
    const before = bodies(db)
    const admissions = countOf(db, CARD_ADMITTED)
    const first = backfillWitnessFields(db, NOW)
    expect(first.recorded).toBe(true)
    expect(Object.keys(first.backfill.cards)).toEqual(['90'])
    expect(first.backfill.unparsed).toEqual([{ card: 91, line: 'the owner reads the page' }, { card: 92, line: 'Runs: src/board/run.ts' }])
    expect(backfillWitnessFields(db, NOW)).toEqual({ recorded: false, backfill: first.backfill })
    reduce(db, 'pending', busProjections())
    expect(countOf(db, WITNESS_FIELDS_BACKFILLED)).toBe(1)
    expect(countOf(db, REJECTED)).toBe(0)
    expect(countOf(db, CARD_ADMITTED)).toBe(admissions)
    expect(bodies(db)).toEqual(before)
    db.close()
  })

  it('a backfilled card keeps its fields through an amend that leaves its witnesses, and returns to prose when they change', () => {
    const db = freshBus()
    const text = cardText(90, [`\`${NAMED_RUN}\` exits 0; red on main`], ['Runs: tests/**'])
    admitted(db, 90, text)
    backfillWitnessFields(db, NOW)
    const backfill = recordedWitnessFieldsBackfill(db)
    const shown = (card: string): unknown => witnessFieldsOfCard({ id: 90, witnessFields: [], runs: [], text: card }, backfill)
    expect(shown(text)).toMatchObject({ witnesses: [{ id: 'W1', test: 'the thing is done' }], runs: ['tests/**'] })
    expect(shown(text.replace('Do the thing.', 'Do the thing better.'))).toMatchObject({ witnesses: [{ id: 'W1' }] })
    expect(shown(text.replace('exits 0; red on main', 'exits 0'))).toBeNull()
    expect(shown(text.replace('Runs: tests/**', 'Runs: scripts/tests/**'))).toBeNull()
    db.close()
  })

  it('a card whose witnesses heading holds no item is listed, and a card with no heading is not', () => {
    const noItem = cardText(90, [])
    const noHeading = noItem.replace('Witnesses:\n', '')
    expect(witnessFieldsBackfillOf([{ card: 90, text: noItem }, { card: 91, text: noHeading }])).toEqual({ cards: {}, unparsed: [{ card: 90, line: 'Witnesses:' }] })
  })

  it('a card with no witness at all reads no event as its fields', () => {
    expect(witnessFieldsOfCard({ id: 90, witnessFields: [], runs: [], text: cardText(90, []) }, null)).toBeNull()
  })
})
