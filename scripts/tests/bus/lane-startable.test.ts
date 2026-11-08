import type { DatabaseSync } from 'node:sqlite'
import type { StartableHold } from '../../nodes/launch/launch-candidates.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { boardWarnings, plannedStallLines } from '../../cli/board-warnings.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, PR_OBSERVED } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { assignMovedLane, currentLane, layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, launchCandidates, PLANNED_STALL_MINUTES, plannedStalls } from '../../nodes/launch/launch-candidates.js'

const TS = '2026-11-05T10:00:00.000Z'
const HEAD = 'b'.repeat(40)
const MINUTE_MS = 60_000
const LANES = 3
const MACHINE_CORES = 16
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface AdmitOptions {
  touches?: string
  who?: 'shift' | 'window'
  depends?: number[]
  dedupe?: string
}

function cardText(id: number, touches: string, who: string, depends: readonly number[]): string {
  const dependsOn = depends.length === 0 ? '—' : depends.map(parent => `#${parent}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${dependsOn} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: ${who}\n\nDo the thing.\n`
}

function eventsOfStop(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS stops FROM events WHERE type = ?').get(CARD_STOPPED) as { stops: number }).stops)
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'lane-startable-'))

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, { touches = `src/card-${id}.ts`, who = 'shift', depends = [], dedupe = 'first' }: AdmitOptions = {}): this {
    const text = cardText(id, touches, who, depends)
    busCardEvents(this.db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${dedupe}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db)
    return this
  }

  moveTo(id: number, lane: string): this {
    assignMovedLane(this.db, id, lane, LANES, TS, 'policy')
    return this
  }

  start(id: number): this {
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    return this
  }

  openPr(id: number): this {
    this.start(id)
    const pr = id + 1000
    this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
    return this
  }

  stop(id: number): this {
    this.append(CARD_STOPPED, id, null, `${CARD_STOPPED}:${id}`, { reason: 'fault' })
    return this
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, [], () => LANES, new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)).map(candidate => candidate.cardId)
  }

  holds(): StartableHold[] {
    return plannedStalls(this.db, Date.parse(TS), () => false, [], () => LANES, new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)).map(card => card.hold)
  }

  linesAfter(minutes: number): string[] {
    return plannedStallLines(this.db, new Date(Date.parse(TS) + minutes * MINUTE_MS))
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null): void {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId, pr, head, dedupeKey, payload, legacy: false })
    reduce(this.db)
  }
}

describe('launch takes the first startable card of a lane', () => {
  it('a line with a card waiting on unmet depends starts the free card behind it', () => {
    const bench = new Bench()
      .admit(1, { who: 'window' })
      .admit(2, { depends: [1] })
      .admit(3)
      .moveTo(1, 'lane-1')
      .moveTo(2, 'lane-1')
      .moveTo(3, 'lane-1')
    expect(bench.candidates()).toEqual([3])
  })
})

describe('a lane outside the lanes count', () => {
  it('a card moved into a lane numbered above lanes does not start', () => {
    const outside = new Bench().admit(1).moveTo(1, `lane-${LANES + 1}`)
    expect(outside.candidates()).toEqual([])
    const within = new Bench().admit(1).moveTo(1, `lane-${LANES}`)
    expect(within.candidates()).toEqual([1])
  })

  it('the board names the lane and the count that hold the card, at once', () => {
    const bench = new Bench().admit(1).moveTo(1, `lane-${LANES + 1}`)
    expect(bench.holds()).toEqual([{ kind: 'lane-outside', lane: `lane-${LANES + 1}`, lanes: LANES }])
    expect(holdReason(bench.holds()[0]!)).toBe(`lane-${LANES + 1} is outside the ${LANES} lanes this repository runs; the card starts once it is moved into a lane within that count or the count grows`)
  })

  it('a held card starts when it is moved back within the count', () => {
    const bench = new Bench().admit(1).moveTo(1, `lane-${LANES + 1}`)
    expect(bench.candidates()).toEqual([])
    bench.moveTo(1, 'lane-1')
    expect(bench.candidates()).toEqual([1])
  })

  it('a named lane that is not numbered is not touched by the rule', () => {
    const bench = new Bench().admit(1).moveTo(1, 'lane-window')
    expect(bench.holds().filter(hold => hold.kind === 'lane-outside')).toEqual([])
  })

  it('a card already running in a lane outside the count is never stopped by the rule', () => {
    const bench = new Bench().admit(1).moveTo(1, `lane-${LANES + 1}`).start(1)
    expect(eventsOfStop(bench.db)).toBe(0)
    expect(bench.holds()).toEqual([])
  })
})

describe('a fault-stopped head of a lane', () => {
  it('a lane with a fault-stopped head with no session and no pull request starts the independent card behind it', () => {
    const bench = new Bench().admit(1).start(1).stop(1).admit(2).moveTo(1, 'lane-1').moveTo(2, 'lane-1')
    expect(bench.candidates()).toEqual([2])
    expect(bench.linesAfter(20)).toEqual(['#2 planned and startable, not started for 20 minutes: occupied slots'])
  })

  it('a card that depends on the stopped head does not start', () => {
    const bench = new Bench().admit(1).start(1).stop(1).admit(2, { depends: [1] }).moveTo(2, 'lane-1')
    expect(bench.candidates()).toEqual([])
  })

  it('a shared touch binds the lane assignment and not the start: with every lane occupied the card chains behind the stopped head, and the launch starts it', () => {
    const bench = new Bench().admit(1, { touches: 'src/shared.ts' }).start(1).stop(1).admit(10).start(10).admit(11).start(11).admit(2, { touches: 'src/shared.ts' })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
    expect(currentLane(bench.db, 2)).toBe(currentLane(bench.db, 1))
    expect(bench.candidates()).toEqual([2])
  })

  it('a shared touch binds the lane assignment and not the start: with an empty lane the reflow takes the card off the stopped head, and the launch starts it', () => {
    const bench = new Bench().admit(1, { touches: 'src/shared.ts' }).start(1).stop(1).admit(2, { touches: 'src/shared.ts' })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('reflowed')
    expect(currentLane(bench.db, 2)).not.toBe(currentLane(bench.db, 1))
    expect(bench.candidates()).toEqual([2])
  })

  it('the open pull request and not the stop is what held #1596 behind #1586: a fault-stopped head with an open pull request keeps its lane', () => {
    const bench = new Bench().admit(1).openPr(1).stop(1).admit(2).moveTo(1, 'lane-1').moveTo(2, 'lane-1')
    expect(bench.candidates()).toEqual([])
    expect(bench.linesAfter(20)).toEqual(['#2 planned and startable, not started for 20 minutes: #1 at the head of lane-1'])
  })
})

describe('a card the bus will not start takes no position in a lane', () => {
  it('a not-started who window card does not chain another card into its lane', () => {
    const bench = new Bench().admit(1, { touches: 'src/shared.ts', who: 'window' }).admit(2, { touches: 'src/shared.ts' })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('free')
    expect(latestAssignment(bench.db, 2)?.after ?? '[]').toBe('[]')
  })

  it('a card that depends on a deferred card still chains to it', () => {
    const bench = new Bench().admit(1, { who: 'window' }).admit(2, { depends: [1] })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
    expect(currentLane(bench.db, 2)).toBe(currentLane(bench.db, 1))
  })

  it('a started who window card binds as any running card does', () => {
    const bench = new Bench().admit(1, { touches: 'src/shared.ts', who: 'window' }).start(1).admit(2, { touches: 'src/shared.ts' })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
  })

  it('a deferred card amended to who shift binds again', () => {
    const bench = new Bench()
      .admit(1, { touches: 'src/shared.ts', who: 'window' })
      .admit(1, { touches: 'src/shared.ts', who: 'shift', dedupe: 'amended' })
      .admit(2, { touches: 'src/shared.ts' })
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
  })

  it('deferred cards do not count as occupying a lane, and laying lanes again moves nothing', () => {
    const bench = new Bench().admit(1, { who: 'window' }).admit(2, { who: 'window' }).admit(3, { who: 'window' }).admit(4).admit(5)
    expect(new Set([currentLane(bench.db, 4), currentLane(bench.db, 5)]).size).toBe(2)
    expect(currentLane(bench.db, 4)).toBe('lane-1')
    expect(layLanes(bench.db, LANES, TS, 'policy', null, [])).toBe(0)
    expect(layLanes(bench.db, LANES, TS, 'policy', null, [])).toBe(0)
  })
})

describe('the board warns about a startable planned card that has not started', () => {
  it('the board names the open pull request that holds a startable planned card and the path they share', () => {
    const bench = new Bench()
      .admit(27, { touches: 'apps/web/**, construct.json' })
      .openPr(27)
      .admit(1454, { touches: 'apps/web/package.json, construct.json' })
    expect(bench.linesAfter(PLANNED_STALL_MINUTES)).toEqual([`#1454 planned and startable, not started for ${PLANNED_STALL_MINUTES} minutes: overlap with open PR #1027 on apps/web/package.json`])
    expect(boardWarnings({ contexts: [], contextLimit: null, warnRatio: null, openPrs: 0, openPrLimit: null, ownerWaits: 0, stalls: bench.linesAfter(PLANNED_STALL_MINUTES), savingOff: false }).map(warning => warning.level)).toEqual(['amber'])
  })

  it('the board names the running session that overlaps the touches', () => {
    const bench = new Bench().admit(1, { touches: 'src/shared.ts' }).start(1).admit(2, { touches: 'src/shared.ts' })
    expect(bench.linesAfter(20)).toEqual(['#2 planned and startable, not started for 20 minutes: overlap with the session of #1 on src/shared.ts'])
  })

  it('the board names the card keeping the lane busy when no touches overlap', () => {
    const bench = new Bench().admit(1).start(1).admit(2).moveTo(2, 'lane-1')
    expect(bench.linesAfter(20)).toEqual(['#2 planned and startable, not started for 20 minutes: #1 at the head of lane-1'])
  })

  it('the board reads occupied slots when no card holds the planned card', () => {
    const bench = new Bench().admit(1)
    expect(bench.linesAfter(20)).toEqual(['#1 planned and startable, not started for 20 minutes: occupied slots'])
  })

  it('the board gives no line for a card held by depends or who window or younger than the constant', () => {
    const bench = new Bench().admit(1, { who: 'window' }).admit(2, { depends: [1] })
    expect(bench.linesAfter(PLANNED_STALL_MINUTES * 10)).toEqual([])
    const young = new Bench().admit(3)
    expect(young.linesAfter(PLANNED_STALL_MINUTES - 1)).toEqual([])
  })
})
