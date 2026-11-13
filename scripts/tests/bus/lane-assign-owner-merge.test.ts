import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, PR_OBSERVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { chooseLane, currentLane, ownerMergeHolders } from '../../nodes/launch/lane-assign.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-03T10:00:00.000Z'
const HEAD = 'b'.repeat(40)
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
  readonly root = mkdtempSync(path.join(tmpdir(), 'lane-owner-merge-'))

  constructor(readonly lanes: number) {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches: string): this {
    const text = cardText(id, touches)
    busCardEvents(this.db, 's1', () => this.lanes)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  waitForOwnerMerge(id: number): this {
    const pr = id + 1000
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
    this.append(CARD_STOPPED, id, null, `${CARD_STOPPED}:${id}`, { reason: 'merge.owner' })
    openOwnerWait(this.db, TS, 'policy', { need: 'merge', text: `PR #${pr} is an owner-merged kind`, card: id, pr })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null): void {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId, pr, head, dedupeKey, payload, legacy: false })
    reduce(this.db, 'pending', busProjections())
  }
}

describe('a lane held by an owner merge', () => {
  it('least-loaded skips a lane whose open pull request waits for an owner merge', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts')
    expect([bench.lane(1), bench.lane(2)]).toEqual(['lane-1', 'lane-2'])
    bench.waitForOwnerMerge(1)
    expect([...ownerMergeHolders(bench.db)]).toEqual([1])
    bench.admit(3, 'src/c.ts')
    expect(bench.lane(3)).toBe('lane-2')
    expect(latestAssignment(bench.db, 3)?.reason).toBe('least-loaded')
  })

  it('least-loaded still takes the lightest lane when every lane waits for an owner merge', () => {
    const one = { cardId: 1, depends: [], task: null, lane: 'lane-1' }
    const two = { cardId: 2, depends: [], task: null, lane: 'lane-2' }
    const three = { cardId: 3, depends: [], task: null, lane: 'lane-2' }
    const card = { cardId: 4, depends: [], task: null }
    const live = [one, two, three]
    expect(chooseLane(card, live, 2, null, live, new Set([1, 2]))).toEqual({ lane: 'lane-1', reason: 'least-loaded', after: [] })
    expect(chooseLane(card, live, 2, null, live, new Set([1]))).toEqual({ lane: 'lane-2', reason: 'least-loaded', after: [] })
  })
})
