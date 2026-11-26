import type { DatabaseSync } from 'node:sqlite'
import type { StartableHold } from '../../nodes/launch/launch-candidates.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, LANE_ASSIGNED, LANE_OVERLAP, SESSION_HEARTBEAT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { assignMovedLane, laneOverlapRecorder, layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, launchCandidates, startHold } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-26T09:37:00.000Z'
const LATER_MS = Date.parse(TS) + 20 * 60_000
const LANES = 4
const SHARED_FILE = 'contracts/api/openapi.yaml'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Tick {
  started: number[]
  skips: string[]
  overlaps: number[]
}

function cardText(id: number, touches: readonly string[], priority: string): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\npriority: ${priority}\n\nDo the thing.\n`
}

class Bench {
  readonly root = mkdtempSync(path.join(tmpdir(), 'one-overlap-verdict-'))
  readonly db: DatabaseSync

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches: readonly string[], priority = 'p1'): this {
    const text = cardText(id, touches, priority)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', id)
    return this.reduced()
  }

  moveTo(id: number, lane: string): this {
    assignMovedLane(this.db, id, lane, LANES, TS, 'policy')
    return this.reduced()
  }

  start(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
    appendEvent(this.db, { ts: TS, type: SESSION_HEARTBEAT, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${SESSION_HEARTBEAT}:${id}`, payload: { step: 'launch', session: `s-${id}` }, legacy: false })
    return this.reduced()
  }

  laneOf(id: number): string {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string }
    return (JSON.parse(row.payload) as { lane: string }).lane
  }

  queueLaunch(id: number): this {
    queueTask(this.db, TS, { queue: 'launch', cardId: id, generation: `admit-${id}` })
    return this.reduced()
  }

  startHold(id: number): StartableHold | null {
    return startHold(this.db, id, LANES, this.machine(), LATER_MS, [])
  }

  tick(): Tick {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const started = launchCandidates(this.db, () => false, () => LATER_MS, laneOverlapRecorder(this.db, TS, 'worker:launch:w1'), [], () => LANES, this.machine()).map(candidate => candidate.cardId)
    const skips = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    const overlaps = (this.db.prepare(`SELECT card_id FROM events WHERE type = '${LANE_OVERLAP}'`).all() as { card_id: number }[]).map(row => row.card_id)
    return { started, skips, overlaps }
  }

  private machine(): MachineSessions {
    return new MachineSessions(path.join(this.root, 'machine'), () => false, 16)
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function overlapSkipped(tick: Tick): number[] {
  const logged = tick.skips.filter(line => line.includes('overlap')).map(line => Number(/skip #(\d+)/.exec(line)![1]))
  return [...new Set([...logged, ...tick.overlaps])].sort()
}

describe('one overlap verdict per launch tick', () => {
  it('two cards sharing a file exactly one starts', () => {
    for (const [first, second, sameLane] of [[112, 118, true], [212, 218, false]] as const) {
      const bench = new Bench().admit(first, [SHARED_FILE, 'src/a.ts']).admit(second, [SHARED_FILE, 'src/b.ts'])
      if (!sameLane)
        bench.moveTo(second, bench.laneOf(first) === 'lane-1' ? 'lane-2' : 'lane-1')
      const tick = bench.tick()

      expect(tick.started).toEqual([first])
      expect(tick.skips).toEqual([`[bus:launch] skip #${second}: overlap with the session of #${first} on ${SHARED_FILE}`])
    }

    const queued = new Bench().admit(312, [SHARED_FILE, 'src/a.ts']).admit(318, [SHARED_FILE, 'src/b.ts']).queueLaunch(312).queueLaunch(318)
    expect([312, 318].filter(id => queued.startHold(id) === null)).toEqual([312])
    expect(holdReason(queued.startHold(318)!)).toBe(`overlap with the session of #312 on ${SHARED_FILE}`)
  })

  it('a card the launch logs as an overlap skip is not started in the same tick', () => {
    const fresh = new Bench().admit(412, [SHARED_FILE, 'src/a.ts']).admit(418, [SHARED_FILE, 'src/b.ts']).tick()
    expect(overlapSkipped(fresh)).toEqual([418])
    expect(fresh.started).toEqual([412])

    const queued = new Bench().admit(512, [SHARED_FILE, 'src/a.ts']).admit(518, [SHARED_FILE, 'src/b.ts']).queueLaunch(512).queueLaunch(518)
    const tick = queued.tick()

    expect(overlapSkipped(tick)).toEqual([518])
    expect([512, 518].filter(id => queued.startHold(id) === null)).toEqual([512])
    expect(tick.started).toEqual([])
  })

  it('two cards with disjoint touches both start', () => {
    const tick = new Bench().admit(612, ['src/a.ts']).admit(618, ['src/b.ts']).tick()

    expect(tick.started.sort()).toEqual([612, 618])
    expect(overlapSkipped(tick)).toEqual([])

    const queued = new Bench().admit(712, ['src/a.ts']).admit(718, ['src/b.ts']).queueLaunch(712).queueLaunch(718)
    expect(overlapSkipped(queued.tick())).toEqual([])
    expect([712, 718].map(id => queued.startHold(id))).toEqual([null, null])
  })
})
