import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, PR_CLOSED, PR_OBSERVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'

const TS = '2026-10-29T10:00:00.000Z'
const HEAD = 'a'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: number[]): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'lane-release-'))
  private admissions = 0

  constructor(readonly lanes: number) {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  private events(): ReturnType<typeof busCardEvents> {
    return busCardEvents(this.db, 's1', () => this.lanes)
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
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
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    return this
  }

  drop(id: number): this {
    this.append(CARD_DROPPED, id, null, `${CARD_DROPPED}:${id}`, {})
    return this
  }

  merge(id: number): this {
    const pr = id + 1000
    this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
    this.append(PR_CLOSED, id, pr, `${PR_CLOSED}:${pr}`, { merged: true })
    return this
  }

  lay(): this {
    layLanes(this.db, this.lanes, TS, 'policy')
    return this
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  launchable(): number[] {
    return launchCandidates(this.db, () => false).map(candidate => candidate.cardId)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null): void {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId, pr, head, dedupeKey, payload, legacy: false })
    reduce(this.db)
  }
}

describe('a chain is lifted once its parents are gone', () => {
  it('a card chained only through merged parents gets its own lane while the chain lane is busy', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts', [1]).admit(4, 'src/a.ts')
    expect([bench.lane(1), bench.lane(2), bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-2', 'lane-1', 'lane-1'])
    bench.start(1).merge(1).drop(2).start(4).lay()
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-2', 'lane-1'])
    expect(bench.launchable()).toEqual([3])
  })

  it('a released card that depends on a live parent joins that parent lane', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts', [1, 2]).admit(4, 'src/a.ts')
    expect(bench.lane(3)).toBe('lane-1')
    bench.start(1).merge(1).start(4).lay()
    expect(bench.lane(3)).toBe('lane-2')
  })

  it('a queued card that depends on a released card does not pull it back', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts', [1]).admit(4, 'src/a.ts').admit(5, 'src/e.ts', [3])
    expect(bench.lane(5)).toBe('lane-1')
    bench.start(1).merge(1).drop(2).start(4).lay()
    expect(bench.lane(3)).toBe('lane-2')
    expect(bench.launchable()).toEqual([3])
  })
})

describe('a move changes the lane launch reads', () => {
  it('launch takes a moved card from its new lane', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).admit(2, 'src/b.ts')
    expect(bench.lane(2)).toBe('lane-1')
    expect(bench.launchable()).toEqual([])
    bench.move(2, 'lane-21').lay()
    expect(bench.lane(2)).toBe('lane-21')
    expect(bench.launchable()).toEqual([2])
  })
})

describe('shared touches across lanes', () => {
  it('cards sharing touches still launch one at a time', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts', [1]).admit(5, 'src/c.ts')
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-1', 'lane-1'])
    bench.start(1).merge(1).drop(2).lay()
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-2', 'lane-1'])
    expect(bench.launchable()).toEqual([3])
    bench.start(3)
    expect(bench.launchable()).toEqual([])
  })
})
