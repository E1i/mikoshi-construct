import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED, LANE_ASSIGNED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-16T10:00:00.000Z'
const LANES = 3
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, depends: readonly number[], priority: string | null): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  const line = priority === null ? '' : `priority: ${priority}\n`
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n${line}\nDo the thing.\n`
}

class CycleLanes {
  readonly db: DatabaseSync

  constructor() {
    const root = mkdtempSync(path.join(tmpdir(), 'lane-cycle-'))
    roots.push(root)
    this.db = openBus(path.join(root, 'bus.db'))
  }

  admit(id: number, depends: readonly number[], priority: string | null = null): this {
    const text = cardText(id, depends, priority)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [...depends], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', id)
    this.lay()
    return this
  }

  lay(): number {
    reduce(this.db, 'pending', busProjections())
    const laid = layLanes(this.db, LANES, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return laid
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  after(id: number): number[] {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string } | undefined
    const after = row === undefined ? [] : (JSON.parse(row.payload) as { after?: unknown }).after
    return Array.isArray(after) ? after as number[] : []
  }
}

describe('two cards that each precede the other keep their release order', () => {
  it('a dependency cycle on a shared file keeps the admission chain and a second lay writes nothing', () => {
    const lanes = new CycleLanes().admit(1, [2]).admit(2, [1])
    expect(lanes.lane(2)).toBe(lanes.lane(1))
    expect([lanes.after(1), lanes.after(2)]).toEqual([[], [1]])
    expect(lanes.lay()).toBe(0)
    expect([lanes.after(1), lanes.after(2)]).toEqual([[], [1]])
  })

  it('a dependency cycle whose later card carries the higher priority is not reordered by it', () => {
    const lanes = new CycleLanes().admit(1, [2], 'p1').admit(2, [1], 'p0')
    expect(lanes.lane(2)).toBe(lanes.lane(1))
    expect([lanes.after(1), lanes.after(2)]).toEqual([[], [1]])
    expect(lanes.lay()).toBe(0)
  })
})
