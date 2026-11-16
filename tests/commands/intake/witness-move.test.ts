import type { OwnerWords } from '../../../scripts/policy/decisions/decisions.js'
import type { WitnessField } from '../../../src/card/witness-fields.js'
import type { AdmitResult } from '../../../src/commands/intake/admit.js'
import type { CardEvent, RecordedIntake } from '../../../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_ADMITTED, CARD_WAITING, WITNESS_DOWNGRADE } from '../../../scripts/core/events.js'
import { InMemoryDecisions } from '../../../scripts/policy/decisions/decisions.js'
import { witnessFieldsLine } from '../../../src/card/witness-fields.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'

const NOW = new Date('2026-11-16T10:00:00.000Z')
const CARD = 1979
const OTHER_CARD = 1980
const RUN = 'pnpm exec vitest run tests/slice.test.ts'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const W1: WitnessField = { id: 'W1', run: RUN, test: 'the change', head: 'pass', base: 'fail', proves: 'the change is made' }
const W2: WitnessField = { id: 'W2', run: RUN, test: 'the restart waits [needs ps]', head: 'pass', base: 'pass', proves: 'the restart keeps waiting' }
const W3: WitnessField = { id: 'W3', run: RUN, test: null, head: 'pass', base: 'pass', proves: 'the whole file keeps passing' }

function cardText(fields: readonly WitnessField[]): string {
  return [
    `card: #${CARD} restart-waits [implement/construct/S/cheap/auto] · depends — · blocks —`,
    'branch: feat/restart-waits',
    'touches: src/a.ts, tests/slice.test.ts',
    'continue: stop',
    'who: shift',
    '',
    'Make the restart wait.',
    '',
    witnessFieldsLine(fields),
    '',
  ].join('\n')
}

function recorded(text: string): RecordedIntake {
  return { card: text.split('\n')[0]!.slice('card: '.length), bodySha: 'recorded', ts: NOW.toISOString(), confirmation: 'none', source: 'admit', text }
}

function amend(decisions: OwnerWords[]): { result: AdmitResult, events: CardEvent[] } {
  const root = mkdtempSync(path.join(tmpdir(), 'witness-move-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(path.join(repo, 'tests'), { recursive: true })
  mkdirSync(parking, { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  writeFileSync(path.join(repo, 'tests', 'slice.test.ts'), '')
  const events: CardEvent[] = []
  const before = recorded(cardText([W1, W2]))
  const result = runAdmit({
    file: path.join(parking, `${CARD}.md`),
    body: cardText([W1, W3]),
    dir: repo,
    dryRun: false,
    autoConfirm: true,
    parkingRoot: parking,
    events: event => events.push(event),
    cardStates: () => new Map([[String(CARD), 'queued']]),
    admissions: (id) => {
      if (id !== CARD)
        return null
      const at = events.map(event => event.type === CARD_ADMITTED && event.cardId === id).lastIndexOf(true)
      if (at === -1)
        return before
      const { payload, ts } = events[at]!
      return { card: String(payload.card), bodySha: payload.bodySha, ts, confirmation: payload.confirmation, source: payload.source, text: String(payload.text), event: at + 1 }
    },
    decisions: new InMemoryDecisions(decisions),
  }, () => NOW)
  return { result, events }
}

function downgradeWaits(events: readonly CardEvent[]): CardEvent[] {
  return events.filter(event => event.type === CARD_WAITING && event.payload.reason === WITNESS_DOWNGRADE)
}

const MOVE: OwnerWords = { decisionId: 639, words: 'move W2 to W3 running the whole file', cards: [CARD], written: true }

describe('an owner decision naming a witness move lets the amend through with no downgrade wait', () => {
  it.each([
    ['move W2 to W3', MOVE.words],
    ['W2 → W3', 'W2 → W3: the whole file'],
    ['W2 -> W3', 'witness W2 -> W3'],
    ['перенести W2 в W3', 'перенести свидетеля W2 в W3, весь файл'],
  ])('%s', (_name, words) => {
    const { result, events } = amend([{ ...MOVE, words }])
    expect(result).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(downgradeWaits(events)).toEqual([])
  })
})

describe('without a decision naming the move, removing the invariant witness still waits for the owner', () => {
  it.each([
    ['no decision', []],
    ['a move decision scoped to another card', [{ ...MOVE, cards: [OTHER_CARD] }]],
    ['a standing move decision with no card', [{ ...MOVE, cards: [] }]],
    ['a move the owner did not write', [{ ...MOVE, written: false }]],
    ['a move to an id the amend does not add', [{ ...MOVE, words: 'move W2 to W4' }]],
    ['a move of another id', [{ ...MOVE, words: 'move W1 to W3' }]],
    ['a move to an id that only begins the same', [{ ...MOVE, words: 'move W2 to W30' }]],
    ['a decision that names both ids but no move', [{ ...MOVE, words: 'W2 and W3 both stay' }]],
  ] as [string, OwnerWords[]][])('%s', (_name, decisions) => {
    const { result, events } = amend(decisions)
    expect(result).toMatchObject({ status: 'ownerWait', actions: [`разрешить понижение свидетеля #${CARD} W2`] })
    expect(downgradeWaits(events)).toHaveLength(1)
  })
})
