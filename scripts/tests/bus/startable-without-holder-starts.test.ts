import type { DatabaseSync } from 'node:sqlite'
import type { HostThermal } from '../../ports/host-thermal.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_STARTED, CARD_STOPPED, OUTSIDE_TOUCHES, PR_OBSERVED, QUESTION_AGENT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { laneOverlapRecorder, layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, launchCandidates, startableCards, UNEXPLAINED_HOLD } from '../../nodes/launch/launch-candidates.js'
import { UNREAD_THERMAL } from '../../ports/host-thermal.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-27T22:57:00.000Z'
const LATER_MS = Date.parse(TS) + 20 * 60_000
const LANES = 4
const MACHINE_CORES = 16
const ONE_SLOT_CORES = 1
const HEAD = 'd'.repeat(40)
const MISSED_PATH = 'scripts/z.ts'
const HOT: HostThermal = { level: () => 'heavy' }
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Tick {
  started: number[]
  skips: string[]
}

function cardText(id: number, touches: readonly string[], priority: string): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\npriority: ${priority}\n\nDo the thing.\n`
}

class Bench {
  readonly root = mkdtempSync(path.join(tmpdir(), 'startable-starts-'))
  readonly db: DatabaseSync

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches: readonly string[], priority = 'p1', source?: string): this {
    const text = cardText(id, touches, priority)
    const amend = source === undefined ? {} : { source }
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${textSha(text)}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text), ...amend } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', id)
    return this.reduced()
  }

  stopOutsideTouches(id: number): this {
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    return this.append(CARD_STOPPED, id, null, `${CARD_STOPPED}:${id}`, { reason: QUESTION_AGENT, code: OUTSIDE_TOUCHES, paths: [MISSED_PATH], widen: [MISSED_PATH] })
  }

  openPr(id: number, diff: readonly string[]): this {
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    const pr = id + 1000
    return this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, paths: diff, pathsTruncated: false }, HEAD)
  }

  holdForOwner(id: number): this {
    return this.append(CARD_HELD, id, null, `${CARD_HELD}:${id}`, { request: 1, reason: 'held' }, null, 'owner')
  }

  tick(cores = MACHINE_CORES, thermal: HostThermal = UNREAD_THERMAL): Tick {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const started = launchCandidates(this.db, () => false, () => LATER_MS, laneOverlapRecorder(this.db, TS, 'worker:launch:w1'), [], () => LANES, this.machine(cores), thermal).map(candidate => candidate.cardId)
    const skips = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    return { started, skips }
  }

  withoutHolder(): number[] {
    return startableCards(this.db, () => false, () => LATER_MS, [], () => LANES, this.machine(MACHINE_CORES)).filter(card => card.hold.kind === 'none').map(card => card.cardId).sort()
  }

  reasonOf(id: number): string {
    const card = startableCards(this.db, () => false, () => LATER_MS, [], () => LANES, this.machine(MACHINE_CORES)).find(each => each.cardId === id)
    return card === undefined ? '' : holdReason(card.hold)
  }

  private machine(cores: number): MachineSessions {
    return new MachineSessions(path.join(this.root, 'machine'), () => false, cores)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null, actor = 'policy'): this {
    appendEvent(this.db, { ts: TS, type, actor, cardId, pr, head, dedupeKey, payload, legacy: false })
    return this.reduced()
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function unexplained(tick: Tick): string[] {
  return tick.skips.filter(line => line.endsWith(UNEXPLAINED_HOLD))
}

describe('a startable card with no holder starts on the tick', () => {
  it('every card the launch candidates mark startable with no holder is started on that tick', () => {
    const bench = new Bench()
      .admit(2142, ['scripts/a.ts', 'scripts/b.ts'], 'p2')
      .openPr(2142, ['scripts/a.ts', 'scripts/b.ts'])
      .holdForOwner(2142)
      .admit(2324, ['scripts/a.ts'], 'p0')
      .admit(2365, ['scripts/c.ts'], 'p2')
    const unheld = bench.withoutHolder()
    const tick = bench.tick()

    expect(unheld).toEqual([2324, 2365])
    expect(tick.started.sort()).toEqual(unheld)
    expect(unexplained(tick)).toEqual([])
  })

  it('a card left out only because the tick spent the last free slot is not skipped with no reason, and starts on the next tick with a free slot', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts']).admit(2, ['scripts/b.ts'])
    const full = bench.tick(ONE_SLOT_CORES)

    expect(full.started).toEqual([1])
    expect(unexplained(full)).toEqual([])
    expect(bench.tick().started.sort()).toEqual([1, 2])
  })

  it('a card left out because a card started this tick took its lane names that card, not no reason', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts']).admit(2, ['scripts/a.ts', 'scripts/b.ts'])
    const tick = bench.tick()

    expect(tick.started).toEqual([1])
    expect(unexplained(tick)).toEqual([])
    expect(tick.skips.find(line => line.includes('#2:'))).toContain('#1')
  })

  it('a card left out by thermal pressure is not skipped with no reason, and starts on the next tick once the pressure falls', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts'])
    const hot = bench.tick(MACHINE_CORES, HOT)

    expect(hot.started).toEqual([])
    expect(unexplained(hot)).toEqual([])
    expect(bench.tick().started).toEqual([1])
  })

  it('a card whose session stopped outside its touches is named as held by that stop, and starts once its touches cover the path', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts']).stopOutsideTouches(1).admit(1, ['scripts/a.ts', 'scripts/y.ts'], 'p1', 'amend')

    expect(bench.withoutHolder()).toEqual([])
    expect(bench.reasonOf(1)).toContain(MISSED_PATH)
    expect(bench.tick().started).toEqual([])

    bench.admit(1, ['scripts/a.ts', MISSED_PATH], 'p1', 'amend')
    expect(bench.withoutHolder()).toEqual([1])
    expect(bench.tick().started).toEqual([1])
  })
})
