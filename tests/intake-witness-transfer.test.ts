import type { OwnerWords } from '../scripts/policy/decisions/decisions.js'
import type { WitnessField } from '../src/card/witness-fields.js'
import type { AdmitResult, JournalledIntake } from '../src/commands/intake/admit.js'
import type { CardEvent, RecordedIntake } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_ADMITTED, CARD_WAITING, CARD_WAITS, WITNESS_DOWNGRADE } from '../scripts/core/events.js'
import { InMemoryDecisions } from '../scripts/policy/decisions/decisions.js'
import { witnessFieldsLine, witnessText } from '../src/card/witness-fields.js'
import { runAdmit, untransferred, WITNESS_TRANSFER_IS_NO_DOWNGRADE, witnessTransferIsNoDowngrade } from '../src/commands/intake/admit.js'

const NOW = new Date('2026-11-12T10:00:00.000Z')
const SLICE_ONE = 1651
const SLICE_TWO = 1652
const D_447 = `Постоянно: ${WITNESS_TRANSFER_IS_NO_DOWNGRADE} или в общий набор законов (node-contract-suite) — не понижение, решает окно. Понижение — только когда закон теряет свидетеля совсем; это моё.`
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function field(id: string, test: string): WitnessField {
  return { id, run: 'pnpm exec vitest run tests/slice.test.ts', test, head: 'pass', base: 'fail', proves: `the law ${test} answers to` }
}

const MOVING = [field('W1', 'first moving'), field('W2', 'second moving'), field('W3', 'third moving')]
const STAYING = field('W4', 'staying')

function cardText(id: number, name: string, fields: readonly WitnessField[]): string {
  return [
    `card: #${id} ${name} [implement/black-ice/S/cheap/owner] · depends — · blocks —`,
    `branch: feat/${name}`,
    'touches: src/a.ts, tests/slice.test.ts',
    'continue: stop',
    'who: shift',
    '',
    `Do ${name}.`,
    '',
    witnessFieldsLine(fields),
    '',
  ].join('\n')
}

function recorded(text: string): RecordedIntake {
  return { card: text.split('\n')[0]!.slice('card: '.length), bodySha: 'recorded', ts: NOW.toISOString(), confirmation: 'none', source: 'admit', text }
}

function journalled(b: Bench, id: number): JournalledIntake | null {
  const at = b.events.map(event => event.type === CARD_ADMITTED && event.cardId === id).lastIndexOf(true)
  if (at === -1)
    return null
  const { payload, ts } = b.events[at]!
  return { card: String(payload.card), bodySha: payload.bodySha, ts, confirmation: payload.confirmation, source: payload.source, text: String(payload.text), event: at + 1 }
}

interface Bench { states: Map<string, string>, texts: Map<number, string>, events: CardEvent[], decisions: OwnerWords[] }

function bench(): Bench {
  return { states: new Map(), texts: new Map(), events: [], decisions: [{ decisionId: 447, words: D_447, cards: [], written: true }] }
}

function admitted(b: Bench, id: number, text: string, state = 'queued'): void {
  b.states.set(String(id), state)
  b.texts.set(id, text)
}

function amendSliceOne(b: Bench, kept: readonly WitnessField[]): AdmitResult {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-witness-transfer-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(path.join(repo, 'tests'), { recursive: true })
  mkdirSync(parking, { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  writeFileSync(path.join(repo, 'tests', 'slice.test.ts'), '')
  return runAdmit({
    file: path.join(parking, `${SLICE_ONE}.md`),
    body: cardText(SLICE_ONE, 'slice-one', kept),
    dir: repo,
    dryRun: false,
    autoConfirm: true,
    parkingRoot: parking,
    events: event => b.events.push(event),
    cardStates: () => b.states,
    admissions: id => journalled(b, id) ?? (b.texts.has(id) ? recorded(b.texts.get(id)!) : null),
    decisions: new InMemoryDecisions(b.decisions),
  }, () => NOW)
}

function downgradeWaits(b: Bench): CardEvent[] {
  return b.events.filter(event => event.type === CARD_WAITING && event.payload.reason === WITNESS_DOWNGRADE)
}

describe('intake reads the decisions in force: a witness moved to another card is no downgrade (D-447)', () => {
  it('a witness that moves to another admitted card is not a downgrade', () => {
    const b = bench()
    admitted(b, SLICE_ONE, cardText(SLICE_ONE, 'slice-one', [...MOVING, STAYING]))
    admitted(b, SLICE_TWO, cardText(SLICE_TWO, 'slice-two', MOVING.map((each, at) => ({ ...each, id: `W${at + 1}` }))))

    expect(amendSliceOne(b, [STAYING])).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(downgradeWaits(b)).toEqual([])
  })

  it('a witness removed with no card that holds it still waits for the owner', () => {
    const lost = bench()
    admitted(lost, SLICE_ONE, cardText(SLICE_ONE, 'slice-one', [...MOVING, STAYING]))
    admitted(lost, SLICE_TWO, cardText(SLICE_TWO, 'slice-two', MOVING.slice(1)))
    const held = amendSliceOne(lost, [STAYING])
    expect(held).toMatchObject({ status: 'ownerWait', actions: [`разрешить понижение свидетеля #${SLICE_ONE} W1`] })
    expect(downgradeWaits(lost)).toHaveLength(1)
    expect(downgradeWaits(lost)[0]!.payload).toMatchObject({ code: 'owner', detail: expect.stringContaining(`the ${CARD_WAITS.owner.lifter} lifts it by`) })

    const merged = bench()
    admitted(merged, SLICE_ONE, cardText(SLICE_ONE, 'slice-one', [...MOVING, STAYING]))
    admitted(merged, SLICE_TWO, cardText(SLICE_TWO, 'slice-two', MOVING), 'merged')
    expect(amendSliceOne(merged, [STAYING])).toMatchObject({ status: 'ownerWait', actions: MOVING.map(each => `разрешить понижение свидетеля #${SLICE_ONE} ${each.id}`) })

    const unruled = bench()
    unruled.decisions = []
    admitted(unruled, SLICE_ONE, cardText(SLICE_ONE, 'slice-one', [...MOVING, STAYING]))
    admitted(unruled, SLICE_TWO, cardText(SLICE_TWO, 'slice-two', MOVING))
    expect(amendSliceOne(unruled, [STAYING])).toMatchObject({ status: 'ownerWait' })
  })

  it('the transfer rule is a standing decision the owner wrote, read through the decisions port', () => {
    const owner: OwnerWords = { decisionId: 447, words: D_447, cards: [], written: true }
    expect(witnessTransferIsNoDowngrade(new InMemoryDecisions([owner]))).toBe(true)
    expect(witnessTransferIsNoDowngrade(new InMemoryDecisions([{ ...owner, written: false }]))).toBe(false)
    expect(witnessTransferIsNoDowngrade(new InMemoryDecisions([{ ...owner, cards: [SLICE_ONE] }]))).toBe(false)
    expect(witnessTransferIsNoDowngrade(new InMemoryDecisions([]))).toBe(false)
  })

  it('a witness counts as moved only when another card holds the same run and the same test', () => {
    const previous = cardText(SLICE_ONE, 'slice-one', [...MOVING, STAYING])
    const removed = MOVING.map(witnessText)
    expect(untransferred(removed, previous, MOVING)).toEqual([])
    expect(untransferred(removed, previous, [{ run: MOVING[0]!.run, test: 'another test' }])).toEqual(removed)
    expect(untransferred(removed, previous, [{ run: 'pnpm exec vitest run tests/other.test.ts', test: MOVING[0]!.test }])).toEqual(removed)
    expect(untransferred(['W1: a prose witness'], previous, MOVING)).toEqual(['W1: a prose witness'])
  })
})
