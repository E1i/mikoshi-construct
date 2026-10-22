import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { busCardEvents } from '../../bus/intake.js'
import { chainLaneNumber, currentLane, DEFAULT_LANE_COUNT, laneCount, layLanes, liveLanes } from '../../bus/lane-assign.js'
import { launchCandidates } from '../../bus/launch-candidates.js'
import { reduce } from '../../bus/reducer.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, LANE_ASSIGNED } from '../../core/events.js'

const TS = '2026-10-22T10:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'lane-assign-'))
  roots.push(root)
  return root
}

function cardText(id: number, touches: string, depends: number[] = []): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  private admissions = 0

  constructor(private readonly lanes: number) {
    this.db = openBus(path.join(tempRoot(), 'bus.db'))
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    this.admissions += 1
    busCardEvents(this.db, 's1', () => this.lanes)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db)
    return this
  }

  start(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
    reduce(this.db)
    return this
  }

  drop(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_DROPPED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${id}`, payload: {}, legacy: false })
    reduce(this.db)
    return this
  }

  lane(id: number): string | null {
    return currentLane(this.db, id)
  }

  launchable(): number[] {
    return launchCandidates(this.db, () => false).map(candidate => candidate.cardId)
  }
}

describe('a lane is a chain written by lane.assigned', () => {
  it('two cards with a shared file get one lane and the second waits for the first', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/a.ts')
    expect(bench.lane(2)).toBe(bench.lane(1))
    expect(bench.launchable()).toEqual([1])
    bench.start(1)
    expect(bench.launchable()).toEqual([])
  })

  it('two independent cards get different lanes and run in parallel', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts')
    expect([bench.lane(1), bench.lane(2)]).toEqual(['lane-1', 'lane-2'])
    expect(bench.launchable()).toEqual([1, 2])
  })

  it('a card that depends on a live card takes that card lane', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts', [1])
    expect(bench.lane(2)).toBe('lane-1')
  })

  it('with all N lanes busy with independent cards a new independent card waits for a free lane', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/c.ts')
    expect(['lane-1', 'lane-2']).toContain(bench.lane(3))
    expect(bench.launchable()).toEqual([])
  })

  it('an emptied lane gives its number to the next independent card', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts').drop(1).admit(3, 'src/c.ts')
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual([null, 'lane-2', 'lane-1'])
  })

  it('an amend that adds an overlap moves the card into that card lane', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts')
    expect(bench.lane(2)).toBe('lane-2')
    bench.admit(2, 'src/a.ts')
    expect(bench.lane(2)).toBe('lane-1')
  })

  it('an amend that keeps its touches writes no new lane', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(1, 'src/a.ts')
    expect((bench.db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${LANE_ASSIGNED}'`).get() as { n: number }).n).toBe(1)
  })

  // eslint-disable-next-line test/prefer-lowercase-title
  it('N=1 runs strictly one card at a time', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts')
    expect([bench.lane(1), bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1', 'lane-1'])
    expect(bench.launchable()).toEqual([1])
  })

  it('no field in construct.json means N=3', () => {
    const root = tempRoot()
    expect(laneCount(root)).toBe(DEFAULT_LANE_COUNT)
    writeFileSync(path.join(root, 'construct.json'), JSON.stringify({ construct: '0.1.0' }))
    expect(laneCount(root)).toBe(3)
    writeFileSync(path.join(root, 'construct.json'), JSON.stringify({ construct: '0.1.0', lanes: 5 }))
    expect(laneCount(root)).toBe(5)
  })

  it('after the re-layout no live card has a lane number above N', () => {
    const bench = new Bench(2)
    for (const id of [1, 2, 3, 4, 5]) {
      const text = cardText(id, `src/${id}.ts`)
      appendEvent(bench.db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `legacy-${id}`, payload: { lane: `lane-0${id + 4}`, depends: [], text, textSha: textSha(text) }, legacy: false })
    }
    reduce(bench.db)
    bench.drop(5)
    expect(layLanes(bench.db, 2, TS, 'policy')).toBe(4)
    expect(layLanes(bench.db, 2, TS, 'policy')).toBe(0)
    const live = liveLanes(bench.db)
    expect(live.map(card => card.cardId)).toEqual([1, 2, 3, 4])
    expect(live.every(card => (chainLaneNumber(card.lane) ?? Infinity) <= 2)).toBe(true)
    expect(bench.lane(5)).toBeNull()
  })
})
