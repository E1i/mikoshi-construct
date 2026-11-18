import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, LANE_ASSIGNED, OWNER_WAIT_OPENED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { cannotLaunch, currentLane, laneOverlapRecorder, layLanes, relayBehindStalls } from '../../nodes/launch/lane-assign.js'
import { droppedDependencyWaitText, launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-16T10:00:00.000Z'
const LANES = 3
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: number[]): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Board {
  readonly db: DatabaseSync
  private admissions = 0

  constructor(private readonly lanes: number = LANES) {
    const root = mkdtempSync(path.join(tmpdir(), 'lane-dead-'))
    roots.push(root)
    this.db = openBus(path.join(root, 'bus.db'))
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    this.admissions += 1
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, this.lanes, TS, 'worker:launch:s1', id)
    return this.lay()
  }

  drop(id: number): this {
    return this.dropUnlaid(id).lay()
  }

  dropUnlaid(id: number): this {
    return this.append(CARD_DROPPED, id)
  }

  start(id: number): this {
    return this.append(CARD_STARTED, id)
  }

  relayBehind(stalled: number): number {
    return relayBehindStalls(this.db, [{ cardId: stalled, pr: stalled + 1000, head: null, cause: 'test', detail: 'test' }], this.lanes, TS, 'policy', [])
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  reason(id: number): unknown {
    return latestAssignment(this.db, id)?.reason
  }

  everyAfter(id: number): number[] {
    return (this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id`).all(id) as { payload: string }[])
      .flatMap((row) => {
        const after = (JSON.parse(row.payload) as { after?: unknown }).after
        return Array.isArray(after) ? after as number[] : []
      })
  }

  private append(type: string, id: number): this {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${type}:${id}`, payload: {}, legacy: false })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  lay(): this {
    reduce(this.db, 'pending', busProjections())
    layLanes(this.db, this.lanes, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return this
  }

  after(id: number): number[] {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string } | undefined
    const after = row === undefined ? [] : (JSON.parse(row.payload) as { after?: unknown }).after
    return Array.isArray(after) ? after as number[] : []
  }

  tick(): void {
    launchCandidates(this.db, () => false, Date.now, laneOverlapRecorder(this.db, TS, 'worker:launch:w1'))
    reduce(this.db, 'pending', busProjections())
  }

  waitsOf(id: number): string[] {
    return (this.db.prepare(`SELECT payload FROM events WHERE type = '${OWNER_WAIT_OPENED}' AND card_id = ? ORDER BY id`).all(id) as { payload: string }[])
      .map(row => String((JSON.parse(row.payload) as { text?: unknown }).text))
  }

  count(type: string, id: number): number {
    return (this.db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(type, id) as { n: number }).n
  }
}

describe('a lane chain orders a card only after cards that can still launch', () => {
  it('a card is never chained behind a card whose dependency is dropped', () => {
    const fresh = new Board().admit(1, 'scripts/a.ts').admit(2, 'scripts/a.ts', [1]).drop(1).admit(3, 'scripts/a.ts')
    expect(cannotLaunch(fresh.db)).toEqual(new Set([1, 2]))
    expect(fresh.after(3)).not.toContain(1)
    expect(fresh.after(3)).not.toContain(2)

    const assigned = new Board().admit(1, 'scripts/a.ts').admit(2, 'scripts/a.ts', [1]).admit(3, 'scripts/a.ts')
    expect(assigned.after(3)).toEqual(expect.arrayContaining([1, 2]))
    assigned.drop(1)
    expect(assigned.after(3)).not.toContain(1)
    expect(assigned.after(3)).not.toContain(2)
    expect(currentLane(assigned.db, 3)).not.toBeNull()
  })

  it('a card depending on a dropped card through another card cannot launch either', () => {
    const board = new Board().admit(1, 'scripts/a.ts').admit(2, 'scripts/b.ts', [1]).admit(4, 'scripts/c.ts', [2]).drop(1)
    expect(cannotLaunch(board.db)).toEqual(new Set([1, 2, 4]))
  })

  it('a re-laid card counts no card that cannot launch as an occupant of a lane', () => {
    const board = new Board(2).admit(1, 'scripts/a.ts').admit(2, 'scripts/a.ts', [1]).admit(5, 'scripts/x.ts').admit(3, 'scripts/a.ts')
    expect([board.lane(1), board.lane(2), board.lane(5), board.lane(3)]).toEqual(['lane-1', 'lane-1', 'lane-2', 'lane-1'])
    expect(board.after(3)).toEqual([1, 2])
    board.drop(1)
    expect(board.lane(3)).toBe('lane-1')
    expect(board.reason(3)).toBe('free')
  })

  it('the reflow counts a lane held only by a card that cannot launch as empty', () => {
    const board = new Board(2).admit(1, 'scripts/a.ts').start(1).admit(9, 'scripts/z.ts').admit(2, 'scripts/b.ts', [9]).admit(3, 'scripts/c.ts')
    expect([board.lane(1), board.lane(9), board.lane(2), board.lane(3)]).toEqual(['lane-1', 'lane-2', 'lane-2', 'lane-1'])
    board.drop(9)
    expect(board.lane(2)).toBe('lane-2')
    expect(board.lane(3)).toBe('lane-2')
    expect(board.reason(3)).toBe('reflowed')
  })

  it('an amended card is never re-laid behind a card that cannot launch', () => {
    const board = new Board(2).admit(9, 'scripts/z.ts').admit(2, 'scripts/y.ts', [9]).admit(3, 'scripts/c.ts')
    expect([board.lane(9), board.lane(2), board.lane(3)]).toEqual(['lane-1', 'lane-1', 'lane-2'])
    board.dropUnlaid(9).admit(3, 'scripts/y.ts')
    expect(board.everyAfter(3)).not.toContain(2)
    expect(board.lane(3)).toBe('lane-2')
  })

  it('a card behind a stall counts a lane held only by a card that cannot launch as free', () => {
    const board = new Board(2).admit(1, 'scripts/a.ts').admit(9, 'scripts/z.ts').admit(2, 'scripts/y.ts', [9]).admit(3, 'scripts/c.ts').admit(4, 'scripts/d.ts')
    expect([board.lane(1), board.lane(9), board.lane(2), board.lane(3), board.lane(4)]).toEqual(['lane-1', 'lane-2', 'lane-2', 'lane-1', 'lane-1'])
    board.dropUnlaid(9)
    expect(board.relayBehind(1)).toBeGreaterThan(0)
    expect(board.lane(3)).toBe('lane-2')
  })

  it('a dependency on a dropped card opens one owner wait', () => {
    const board = new Board().admit(1, 'scripts/a.ts').admit(2, 'scripts/b.ts', [1]).drop(1)
    const admissions = board.count(CARD_ADMITTED, 2)
    board.tick()
    board.tick()
    board.tick()
    expect(board.waitsOf(2)).toEqual([droppedDependencyWaitText(2, 1)])
    expect(board.waitsOf(2)[0]).toContain('#2')
    expect(board.waitsOf(2)[0]).toContain('#1')
    expect(board.count(CARD_DROPPED, 2)).toBe(0)
    expect(board.count(CARD_ADMITTED, 2)).toBe(admissions)
  })
})
