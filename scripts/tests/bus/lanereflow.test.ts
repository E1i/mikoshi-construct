import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, PR_CLOSED, PR_OBSERVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'

const TS = '2026-11-03T10:00:00.000Z'
const HEAD = 'b'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface CardShape {
  touches: string
  depends?: number[]
  priority?: 'p0'
}

function cardText(id: number, shape: CardShape): string {
  const depends = shape.depends ?? []
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  const priority = shape.priority === undefined ? '' : `priority: ${shape.priority}\n`
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${shape.touches}\ncontinue: stop\nwho: shift\n${priority}\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'lanereflow-'))
  private admissions = 0

  constructor(private lanes: number) {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  private events(): ReturnType<typeof busCardEvents> {
    return busCardEvents(this.db, 's1', () => this.lanes)
  }

  admit(id: number, shape: CardShape): this {
    const text = cardText(id, shape)
    const depends = shape.depends ?? []
    this.admissions += 1
    this.events()({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db)
    return this
  }

  move(id: number, lane: string): this {
    this.events()({ type: CARD_MOVED, cardId: id, ts: TS, dedupeKey: `${CARD_MOVED}:${id}:${lane}`, payload: { from: null, to: path.join(this.root, lane), bodySha: 'moved', lane } })
    reduce(this.db)
    return this
  }

  start(id: number): this {
    return this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
  }

  drop(id: number): this {
    return this.append(CARD_DROPPED, id, null, `${CARD_DROPPED}:${id}`, {})
  }

  openPr(id: number): this {
    const pr = id + 1000
    return this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
  }

  merge(id: number): this {
    const pr = id + 1000
    return this.openPr(id).append(PR_CLOSED, id, pr, `${PR_CLOSED}:${pr}`, { merged: true })
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
    reduce(this.db)
    return this
  }
}

describe('a not-started card leaves a busy lane for an empty one', () => {
  it('a not-started card in a busy lane with an empty lane beside it and no touches overlap gets the empty lane on the next tick', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts' }).start(1).admit(3, { touches: 'src/c.ts' })
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.drop(2).tick()
    expect(bench.lane(3)).toBe('lane-2')
    expect(bench.reason(3)).toBe('reflowed')
    expect(bench.launchable()).toEqual([3])
  })

  it('a not-started card whose touches overlap a running card stays in its lane', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).start(1).admit(3, { touches: 'src/a.ts' }).admit(4, { touches: 'src/d.ts' })
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-1'])
    bench.grow(2).tick()
    expect([bench.lane(1), bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-1', 'lane-2'])
    expect(bench.reason(4)).toBe('reflowed')
  })

  it('a not-started card whose touches overlap a card with an open pull request stays in its lane', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts' }).openPr(2).admit(3, { touches: 'src/b.ts' })
    bench.grow(2).tick()
    expect(bench.lane(3)).toBe('lane-1')
  })

  it('a lane the owner set with a move is not reflowed', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts' }).move(2, 'lane-1').tick()
    expect([bench.lane(2), bench.reason(2)]).toEqual(['lane-1', 'moved'])
  })

  it('a card alone in its lane stays', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).grow(3).tick()
    expect(bench.lane(1)).toBe('lane-1')
  })

  it('a chain of not-started cards moves together, after the card that blocks more cards', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/c.ts' }).admit(4, { touches: 'src/d.ts', depends: [3] })
    bench.grow(2).tick()
    expect([bench.lane(2), bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-2', 'lane-2'])
  })

  it('of two equal candidates the p0 card takes the empty lane', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/c.ts', priority: 'p0' })
    bench.grow(2).tick()
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2'])
  })
})

describe('a chain that holds a not-ready card', () => {
  function readyBehindWaiting(lanes: number): Bench {
    return new Bench(lanes).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/parent.ts' }).admit(3, { touches: 'src/shared.ts' }).admit(4, { touches: 'src/shared.ts', depends: [2] })
  }

  it('a ready card behind a not-ready card whose touches it overlaps moves to the empty lane and the waiting card stays', () => {
    const bench = readyBehindWaiting(2)
    expect([bench.lane(1), bench.lane(2), bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-2', 'lane-1', 'lane-1'])
    expect(bench.launchable()).toEqual([2])
    bench.grow(3).tick()
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-3', 'lane-1'])
    expect(bench.reason(3)).toBe('reflowed')
    expect(bench.launchable()).toEqual([2, 3])
  })

  it('launch holds the waiting card back while the ready card that left its lane runs', () => {
    const bench = readyBehindWaiting(2).grow(3).tick().start(3).drop(1).merge(2)
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-3', 'lane-1'])
    expect(bench.launchable()).toEqual([])
    bench.drop(3)
    expect(bench.launchable()).toEqual([4])
  })

  it('a not-ready card keeps its parent in the lane', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/c.ts', depends: [1, 2] })
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.grow(3).tick()
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    expect(bench.launchable()).toEqual([1, 2])
  })

  it('a card a not-ready card precedes stays with it', () => {
    const bench = readyBehindWaiting(2).admit(5, { touches: 'src/e.ts', depends: [4] })
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-2', 'lane-1'])
    bench.grow(3).tick()
    expect([bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-1'])
  })

  it('a ready card whose touches overlap a ready card moves with it', () => {
    const bench = readyBehindWaiting(2).admit(5, { touches: 'src/shared.ts,src/f.ts' }).admit(6, { touches: 'src/f.ts' })
    expect([bench.lane(5), bench.lane(6)]).toEqual(['lane-1', 'lane-1'])
    bench.grow(3).tick()
    expect([bench.lane(3), bench.lane(4), bench.lane(5), bench.lane(6)]).toEqual(['lane-3', 'lane-1', 'lane-3', 'lane-3'])
  })

  it('a ready card whose touches overlap the parent a not-ready card keeps stays with that parent', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/c.ts', depends: [1, 2] }).admit(4, { touches: 'src/a.ts' })
    expect(bench.lane(4)).toBe('lane-1')
    bench.grow(3).tick()
    expect([bench.lane(1), bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
  })

  function twoReadyBesideOneWaiting(): Bench {
    return new Bench(2).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/parent.ts' }).admit(3, { touches: 'src/x.ts' }).admit(6, { touches: 'src/z.ts', depends: [2] }).admit(4, { touches: 'src/y.ts' }).admit(5, { touches: 'src/x.ts,src/y.ts', depends: [2] })
  }

  it('two ready cards that share only the not-ready card become two chains, each with its own empty lane', () => {
    const bench = twoReadyBesideOneWaiting()
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
    bench.grow(4).tick()
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-3', 'lane-4', 'lane-1'])
  })

  it('of two ready chains only the first takes the one empty lane', () => {
    const bench = twoReadyBesideOneWaiting().grow(3).tick()
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-3', 'lane-1', 'lane-1'])
  })

  it('a ready member whose touches overlap a running card stays and the member past it moves', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/a.ts,src/b.ts' }).admit(3, { touches: 'src/b.ts' })
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1'])
    bench.grow(2).tick()
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2'])
  })

  it('a ready member whose touches overlap an open pull request stays and the member past it moves', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).openPr(1).admit(2, { touches: 'src/a.ts,src/b.ts' }).admit(3, { touches: 'src/b.ts' })
    bench.grow(2).tick()
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-2'])
  })

  it('a card that depends on a running card of its lane stays', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts', depends: [1] })
    bench.grow(2).tick()
    expect(bench.lane(2)).toBe('lane-1')
  })

  it('a ready card whose touches overlap a card the owner moved stays beside it', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts' }).move(2, 'lane-1').admit(3, { touches: 'src/b.ts' })
    expect(bench.lane(3)).toBe('lane-1')
    bench.tick()
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1'])
    expect(bench.reason(2)).toBe('moved')
  })

  it('a ready card leaves a not-ready card the owner moved, and that card keeps its lane', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/parent.ts' }).admit(4, { touches: 'src/shared.ts', depends: [2] }).move(4, 'lane-1').admit(3, { touches: 'src/shared.ts' })
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-1'])
    bench.grow(3).tick()
    expect([bench.lane(3), bench.lane(4), bench.reason(4)]).toEqual(['lane-3', 'lane-1', 'moved'])
  })

  it('the cards stay where the split put them on the next tick', () => {
    const bench = readyBehindWaiting(2).grow(4).tick().tick()
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-3', 'lane-1'])
  })

  it('the ready card stays when no lane is empty', () => {
    const bench = readyBehindWaiting(2).tick()
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-1'])
  })
})

describe('the launch order of not-started cards', () => {
  it('of two not-started candidates the one that blocks more cards starts first', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/c.ts', depends: [2] })
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
    expect(bench.launchable()).toEqual([2])
  })

  it('a p0 card starts before a card with a lower number and no priority', () => {
    const bench = new Bench(1).admit(1, { touches: 'src/a.ts' }).admit(2, { touches: 'src/b.ts', priority: 'p0' })
    expect(bench.launchable()).toEqual([2])
  })

  it('a p0 card that overlaps a running card reserves nothing and the next card still starts', () => {
    const bench = new Bench(2).admit(1, { touches: 'src/a.ts' }).start(1).admit(2, { touches: 'src/b.ts' }).admit(3, { touches: 'src/a.ts', priority: 'p0' })
    expect(bench.launchable()).toEqual([2])
  })
})
