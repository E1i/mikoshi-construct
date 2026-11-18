import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, LANE_HELD } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { laneOverlapRecorder, layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, laneHeadHolds, launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { BusRead } from '../../ports/bus-read.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-17T10:00:00.000Z'
const LANES = 3
const IDLE_MACHINE = { free: () => LANES, held: () => null, waiting: () => [] }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: number[]): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Lanes {
  readonly db: DatabaseSync
  private seq = 0

  constructor() {
    const root = mkdtempSync(path.join(tmpdir(), 'lane-held-'))
    roots.push(root)
    this.db = openBus(path.join(root, 'bus.db'))
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', id)
    return this.settle()
  }

  append(type: string, id: number): this {
    this.seq += 1
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${type}:${id}:${this.seq}`, payload: {}, legacy: false })
    return this.settle()
  }

  tick(): this {
    launchCandidates(this.db, () => false, Date.now, laneOverlapRecorder(this.db, TS, 'worker:launch:w1'), [], () => LANES, IDLE_MACHINE)
    reduce(this.db, 'pending', busProjections())
    return this
  }

  held(): { card: number | null, lane: unknown, hold: unknown, reason: unknown }[] {
    return new BusRead(this.db).slice(LANE_HELD, ['lane', 'hold', 'reason']).map(row => ({ card: row.card, ...row.fields })) as { card: number | null, lane: unknown, hold: unknown, reason: unknown }[]
  }

  private settle(): this {
    reduce(this.db, 'pending', busProjections())
    layLanes(this.db, LANES, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

describe('the launch node records what holds the head of each lane', () => {
  it('names a dependency that is not merged yet, with the hold reason the launch node logs', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').append(CARD_STARTED, 1).admit(2, 'scripts/b.ts', [1])
    const heads = laneHeadHolds(lanes.db, () => false, Date.now, [], () => LANES, IDLE_MACHINE)
    expect(heads.map(head => [head.cardId, head.hold])).toEqual([[2, { kind: 'depends', depends: 1 }]])
    expect(holdReason(heads[0]!.hold)).toContain('#1')
  })

  it('records one lane.held per lane and writes nothing while the hold stays the same', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').admit(2, 'scripts/b.ts', [1]).append(CARD_DROPPED, 1).tick().tick().tick()
    expect(lanes.held()).toHaveLength(1)
    expect(lanes.held()[0]).toMatchObject({ card: 2, hold: 'dropped-depends', reason: holdReason({ kind: 'dropped-depends', dropped: 1 }) })
  })

  it('clears a lane once its head no longer waits', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').admit(2, 'scripts/b.ts', [1]).append(CARD_DROPPED, 1).tick()
    const lane = lanes.held()[0]!.lane
    lanes.append(CARD_DROPPED, 2).tick().tick()
    expect(lanes.held()).toEqual([expect.objectContaining({ card: 2, lane }), { card: null, lane, hold: null, reason: null }])
  })

  it('a head chosen to launch leaves its lane with no recorded hold', () => {
    const lanes = new Lanes().admit(3, 'scripts/c.ts').tick()
    expect(lanes.held()).toEqual([])
  })
})
