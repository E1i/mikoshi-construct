import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, CARD_STOPPED, PR_OBSERVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-06T10:00:00.000Z'
const HEAD = 'c'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: readonly number[]): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'independent-card-'))
  private admissions = 0

  constructor(private lanes: number) {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  private events(): ReturnType<typeof busCardEvents> {
    return busCardEvents(this.db, 's1', () => this.lanes)
  }

  admit(id: number, touches: string, depends: readonly number[] = []): this {
    const text = cardText(id, touches, depends)
    this.admissions += 1
    this.events()({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  move(id: number, lane: string): this {
    this.events()({ type: CARD_MOVED, cardId: id, ts: TS, dedupeKey: `${CARD_MOVED}:${id}:${lane}`, payload: { from: null, to: path.join(this.root, lane), bodySha: 'moved', lane } })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  start(id: number): this {
    return this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
  }

  stop(id: number): this {
    return this.append(CARD_STOPPED, id, null, `${CARD_STOPPED}:${id}`, { reason: 'question.agent' })
  }

  drop(id: number): this {
    return this.append(CARD_DROPPED, id, null, `${CARD_DROPPED}:${id}`, {})
  }

  waitForOwnerMerge(id: number): this {
    const pr = id + 1000
    this.start(id)
    this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
    this.stop(id)
    openOwnerWait(this.db, TS, 'policy', { need: 'merge', text: `PR #${pr} is an owner-merged kind`, card: id, pr })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  grow(lanes: number): this {
    this.lanes = lanes
    return this
  }

  tick(): this {
    layLanes(this.db, this.lanes, TS, 'policy')
    return this
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  reason(id: number): unknown {
    return latestAssignment(this.db, id)?.reason
  }

  launchable(): number[] {
    return launchCandidates(this.db, () => false).map(candidate => candidate.cardId)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null): this {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId, pr, head, dedupeKey, payload, legacy: false })
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function longChainBesideOneWaiting(): Bench {
  return new Bench(2).admit(1, 'src/a.ts').start(1).admit(2, 'src/z.ts').admit(3, 'src/a.ts,src/b.ts').admit(5, 'src/a.ts,src/c.ts')
}

describe('a ready part when no lane is empty', () => {
  it('a ready card overlapping only waiting cards leaves a long chain when no lane is empty', () => {
    const bench = longChainBesideOneWaiting().admit(4, 'src/b.ts')
    expect([bench.lane(1), bench.lane(2), bench.lane(3), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1', 'lane-1'])
    expect(bench.lane(4)).toBe('lane-2')
    expect(bench.reason(4)).toBe('reflowed')
  })

  it('whichever starts first holds the touches the moved card shares with the chain', () => {
    const bench = longChainBesideOneWaiting().admit(4, 'src/b.ts').drop(2)
    expect(bench.launchable()).toEqual([4])
    bench.start(4).drop(1)
    expect(bench.launchable()).not.toContain(3)
  })

  it('the moved card stays where it went on the next tick', () => {
    const bench = longChainBesideOneWaiting().admit(4, 'src/b.ts').tick().tick()
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
  })

  it('the part goes to the lane holding the fewest waiting cards', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').start(1).admit(2, 'src/z.ts').admit(9, 'src/y.ts').admit(10, 'src/z.ts').admit(3, 'src/a.ts,src/b.ts').admit(5, 'src/a.ts,src/c.ts').admit(4, 'src/b.ts')
    expect([bench.lane(2), bench.lane(10), bench.lane(9)]).toEqual(['lane-2', 'lane-2', 'lane-3'])
    expect(bench.lane(4)).toBe('lane-3')
  })

  it('a part of two moves together when the gap is wider than its size', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).admit(3, 'src/a.ts,src/b.ts').admit(5, 'src/a.ts,src/d.ts').admit(6, 'src/a.ts,src/e.ts').admit(7, 'src/b.ts,src/c.ts').admit(8, 'src/c.ts')
    bench.grow(2).admit(2, 'src/z.ts')
    expect([bench.lane(2), bench.lane(7), bench.lane(8)]).toEqual(['lane-2', 'lane-2', 'lane-2'])
    expect([bench.lane(3), bench.lane(5), bench.lane(6)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
  })

  it('a part stays when the gap only equals its size', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).admit(3, 'src/a.ts,src/b.ts').admit(7, 'src/b.ts,src/c.ts').admit(8, 'src/c.ts')
    bench.grow(2).admit(2, 'src/z.ts')
    expect([bench.lane(7), bench.lane(8)]).toEqual(['lane-1', 'lane-1'])
  })

  it('a card stays out of a lane holding a card it overlaps', () => {
    const bench = longChainBesideOneWaiting().admit(6, 'src/a.ts,src/d.ts').admit(4, 'src/b.ts,src/z.ts')
    expect(bench.lane(4)).toBe('lane-1')
  })

  it('a card stays out of a lane whose pull request waits for an owner merge', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/z.ts').waitForOwnerMerge(2).start(1).admit(3, 'src/a.ts,src/b.ts').admit(5, 'src/a.ts,src/c.ts').admit(4, 'src/b.ts')
    expect(bench.lane(2)).toBe('lane-2')
    expect(bench.lane(4)).toBe('lane-1')
  })
})

describe('what holds a card in its lane', () => {
  it('a card overlapping a running card stays where it is', () => {
    const bench = longChainBesideOneWaiting().admit(4, 'src/a.ts,src/e.ts')
    expect(bench.lane(4)).toBe('lane-1')
    expect(bench.reason(4)).toBe('chain')
  })

  it('a card overlapping a started card that stopped stays where it is', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').start(1).stop(1).admit(2, 'src/z.ts').admit(3, 'src/a.ts').admit(5, 'src/a.ts', [2]).admit(6, 'src/a.ts', [2])
    expect([bench.lane(3), bench.lane(5), bench.lane(6)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
    expect(bench.reason(3)).toBe('chain')
  })

  it('a card a waiting card depends on stays in its chain', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).admit(6, 'src/a.ts,src/b.ts').admit(7, 'src/a.ts,src/e.ts').admit(8, 'src/a.ts,src/f.ts').admit(3, 'src/b.ts').admit(4, 'src/d.ts', [3])
    bench.grow(2).admit(2, 'src/z.ts')
    expect([bench.lane(2), bench.lane(3), bench.lane(4)]).toEqual(['lane-2', 'lane-1', 'lane-1'])
  })

  it('a card the owner moved stays where the owner put it', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).admit(3, 'src/a.ts,src/b.ts').admit(5, 'src/a.ts,src/c.ts').admit(4, 'src/b.ts').move(4, 'lane-1')
    bench.grow(2).admit(2, 'src/z.ts')
    expect([bench.lane(4), bench.reason(4)]).toEqual(['lane-1', 'moved'])
  })
})
