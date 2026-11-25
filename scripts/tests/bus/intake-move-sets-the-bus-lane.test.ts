import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_MOVED, CARD_STARTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-26T10:00:00.000Z'
const LAUNCH_ACTOR = 'worker:launch:s1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'intake-move-lane-'))
  private admissions = 0

  constructor(private readonly lanes: number) {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches: string): this {
    const text = cardText(id, touches)
    this.admissions += 1
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, this.lanes, TS, LAUNCH_ACTOR, id)
    reduce(this.db, 'pending', busProjections())
    return this
  }

  start(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  moveByIntake(id: number, lane: string): this {
    busCardEvents(this.db, 's1')({ type: CARD_MOVED, cardId: id, ts: TS, dedupeKey: `${CARD_MOVED}:${id}:${lane}`, payload: { from: null, to: path.join(this.root, lane), bodySha: 'moved' } })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  tick(): this {
    layLanes(this.db, this.lanes, TS, LAUNCH_ACTOR)
    return this
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  reason(id: number): unknown {
    return latestAssignment(this.db, id)?.reason
  }
}

function chainedBehindARunningHead(): Bench {
  return new Bench(2).admit(1, 'src/a.ts').start(1).admit(3, 'src/z.ts').start(3).admit(2, 'src/a.ts,src/b.ts')
}

describe('intake --move and the bus lane', () => {
  it('a card moved into another lane by intake takes that lane in the bus', () => {
    const bench = chainedBehindARunningHead()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-1', 'chain'])
    bench.moveByIntake(2, 'lane-2').tick()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-2', 'moved'])
  })

  it('the moved card stays in the lane intake named on the next ticks', () => {
    const bench = chainedBehindARunningHead().moveByIntake(2, 'lane-2').tick().tick()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-2', 'moved'])
  })

  it('a move into a lane past the lane count leaves the card where it is', () => {
    const bench = chainedBehindARunningHead().moveByIntake(2, 'lane-5').tick()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-1', 'chain'])
  })
})

describe('an amend and the lane of the card it overlapped', () => {
  it('an amend that removes the overlap that chained a card frees it from the lane of the card it overlapped', () => {
    const bench = chainedBehindARunningHead()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-1', 'chain'])
    bench.admit(2, 'src/b.ts')
    expect(bench.lane(2)).toBe('lane-2')
  })

  it('an amend that keeps the overlap leaves the card chained in its lane', () => {
    const bench = chainedBehindARunningHead().admit(2, 'src/a.ts,src/c.ts')
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-1', 'chain'])
  })
})
