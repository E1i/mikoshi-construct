import type { DatabaseSync } from 'node:sqlite'
import type { MachineReader } from '../../nodes/launch/launch-candidates.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OUTSIDE_TOUCHES, QUESTION_AGENT } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-24T09:00:00.000Z'
const LANE = 'lane-1'
const LANES = 3
const STOPPED = 2156
const NEXT = 2236
const OWN = 'scripts/a.ts'
const OUTSIDE = 'scripts/core/layer-map.ts'
const NEXT_TOUCH = 'scripts/b.ts'
const ONE_FREE_SLOT: MachineReader = { free: () => 1, held: () => null, waiting: () => [] }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: readonly string[]): string {
  return `card: #${id} card-${id} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: auto\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  private readonly root = mkdtempSync(path.join(tmpdir(), 'stopped-slot-'))
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))

  constructor() {
    roots.push(this.root)
  }

  admit(id: number, key: string, touches: readonly string[]): this {
    const text = cardText(id, touches)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: key, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: LANE, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    return this.reduced()
  }

  start(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
    return this.reduced()
  }

  stopOutsideTouches(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STOPPED, actor: 'worker:launch:node-1', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${id}`, payload: { reason: QUESTION_AGENT, code: OUTSIDE_TOUCHES, paths: [OUTSIDE], widen: [OUTSIDE] }, legacy: false })
    return this.reduced()
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, [], () => LANES, ONE_FREE_SLOT).map(candidate => candidate.cardId)
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function stoppedThenReadmitted(touches: readonly string[]): Bench {
  return new Bench()
    .admit(STOPPED, 'admit-stopped-1', [OWN])
    .start(STOPPED)
    .stopOutsideTouches(STOPPED)
    .admit(STOPPED, 'admit-stopped-2', touches)
    .admit(NEXT, 'admit-next-1', [NEXT_TOUCH])
}

describe('a card stopped on outside-touches and launchCandidates', () => {
  it('a card stopped on outside-touches takes no launch slot and the next card starts', () => {
    expect(stoppedThenReadmitted([OWN]).candidates()).toEqual([NEXT])
  })

  it('a card whose outside-touches stop is answered by widened touches is chosen again', () => {
    expect(stoppedThenReadmitted([OWN, OUTSIDE]).candidates()).toEqual([STOPPED])
  })
})
