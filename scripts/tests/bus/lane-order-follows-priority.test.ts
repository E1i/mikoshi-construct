import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, LANE_ASSIGNED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-16T10:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Shape { depends?: number[], priority?: string }

function cardText(id: number, touches: string, shape: Shape): string {
  const depends = shape.depends ?? []
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  const priority = shape.priority === undefined ? '' : `priority: ${shape.priority}\n`
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n${priority}\nDo the thing.\n`
}

class Lanes {
  readonly db: DatabaseSync
  private admissions = 0

  constructor(private readonly count: number = 3) {
    const root = mkdtempSync(path.join(tmpdir(), 'lane-order-'))
    roots.push(root)
    this.db = openBus(path.join(root, 'bus.db'))
  }

  admit(id: number, touches: string, shape: Shape = {}): this {
    const text = cardText(id, touches, shape)
    this.admissions += 1
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: shape.depends ?? [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, this.count, TS, 'worker:launch:s1', id)
    return this.lay()
  }

  drop(id: number): this {
    return this.append(CARD_DROPPED, id).lay()
  }

  start(id: number): this {
    return this.append(CARD_STARTED, id)
  }

  lay(): this {
    reduce(this.db, 'pending', busProjections())
    layLanes(this.db, this.count, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return this
  }

  laid(): number {
    reduce(this.db, 'pending', busProjections())
    const count = layLanes(this.db, this.count, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return count
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  after(id: number): number[] {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string } | undefined
    const after = row === undefined ? [] : (JSON.parse(row.payload) as { after?: unknown }).after
    return Array.isArray(after) ? after as number[] : []
  }

  reason(id: number): unknown {
    return latestAssignment(this.db, id)?.reason
  }

  launchable(): number[] {
    return launchCandidates(this.db, () => false).map(candidate => candidate.cardId)
  }

  private append(type: string, id: number): this {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${type}:${id}:${this.admissions}`, payload: {}, legacy: false })
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

describe('lane order on a shared file follows release priority, never admission time', () => {
  it('a readmitted card is never chained behind a card that depends on it', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').admit(2, 'scripts/a.ts', { depends: [1] })
    expect(lanes.after(2)).toEqual([1])
    lanes.drop(1).admit(1, 'scripts/a.ts')
    expect(lanes.lane(1)).toBe(lanes.lane(2))
    expect(lanes.after(1)).not.toContain(2)
    expect(lanes.after(2)).toContain(1)
    expect(lanes.launchable()).toEqual([1])
  })

  it('a readmitted card is never chained behind a card that depends on it through its depends', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').admit(3, 'scripts/b.ts', { depends: [1] }).admit(4, 'scripts/a.ts', { depends: [3] })
    lanes.drop(1).admit(1, 'scripts/a.ts')
    expect(lanes.lane(1)).toBe(lanes.lane(4))
    expect(lanes.after(1)).not.toContain(4)
    expect(lanes.after(1)).not.toContain(3)
    expect(lanes.after(4)).toContain(1)
  })

  it('a higher-priority card is chained before a lower one whatever their admission order', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts', { priority: 'p1' }).admit(2, 'scripts/a.ts', { priority: 'p0' })
    expect(lanes.lane(2)).toBe(lanes.lane(1))
    expect(lanes.after(2)).not.toContain(1)
    expect(lanes.after(1)).toContain(2)
    expect(lanes.launchable()).toEqual([2])
  })

  it('a core card takes the priority of the later wave it blocks', () => {
    const lanes = new Lanes().admit(5, 'scripts/a.ts', { priority: 'p0' }).admit(1, 'scripts/b.ts').admit(6, 'scripts/b.ts', { depends: [1], priority: 'p0' }).admit(2, 'scripts/a.ts')
    expect(lanes.after(2)).not.toContain(1)
    lanes.admit(9, 'scripts/b.ts', { priority: 'p1' })
    expect(lanes.after(1)).not.toContain(9)
    expect(lanes.after(9)).toContain(1)
  })

  it('a started card keeps its assignment when a higher-priority card joins its lane', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts', { priority: 'p1' }).start(1)
    const before = lanes.after(1)
    lanes.admit(2, 'scripts/a.ts', { priority: 'p0' })
    expect(lanes.after(1)).toEqual(before)
    expect(lanes.after(2)).toEqual([1])
  })

  it('cards of one priority keep their admission chain and a second lay writes nothing', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts').admit(2, 'scripts/a.ts').admit(3, 'scripts/a.ts')
    expect([lanes.after(1), lanes.after(2), lanes.after(3)]).toEqual([[], [1], [1, 2]])
    expect(lanes.laid()).toBe(0)
  })

  it('the head of a lane laid by priority is not released by the next lay', () => {
    const lanes = new Lanes().admit(1, 'scripts/a.ts', { priority: 'p1' }).admit(2, 'scripts/a.ts', { priority: 'p0' })
    expect(lanes.reason(2)).toBe('chain')
    expect(lanes.laid()).toBe(0)
    expect(lanes.lane(2)).toBe(lanes.lane(1))
  })
})
