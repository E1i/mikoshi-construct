import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { bodySha } from '../../../src/commands/intake/confirm.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { plannedStallLines } from '../../cli/board-warnings.js'
import { latestAssignment } from '../../core/bus-readings.js'
import { DEFERRED_CARD, unsatisfiedDependencies } from '../../core/card-automaton.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DEFERRED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, DEFERRED_TARGET, PR_OBSERVED } from '../../core/events.js'
import { prefixOf } from '../../core/node.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { assignMovedLane, laneOverlapRecorder, LAUNCH_LOG_PREFIX, layLanes, liveLanes, SkipLog } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-05T10:00:00.000Z'
const HEAD = 'c'.repeat(40)
const MINUTE_MS = 60_000
const LANES = 3
const STALLED_MINUTES = 20
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: readonly number[]): string {
  const dependsOn = depends.length === 0 ? '—' : depends.map(parent => `#${parent}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${dependsOn} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly db: DatabaseSync
  readonly root = mkdtempSync(path.join(tmpdir(), 'card-deferred-'))
  private readonly texts = new Map<number, string>()

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches = `src/card-${id}.ts`, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    this.texts.set(id, text)
    busCardEvents(this.db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db, 'pending', busProjections())
    return this
  }

  move(id: number, to: string, ts: string = TS): string {
    const text = this.texts.get(id)!
    const result = runMove({
      move: `#${id}`,
      to,
      draft: undefined,
      taken: undefined,
      admit: undefined,
      parking: path.join(this.root, 'parking'),
      events: busCardEvents(this.db, 's1', () => LANES),
      admissions: () => ({ card: `#${id}`, bodySha: bodySha(text), ts: TS, confirmation: null, source: null, text }),
    }, () => new Date(ts))
    reduce(this.db, 'pending', busProjections())
    return result.status === 'moved' ? result.event : result.status
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

  openPrOnDeferred(id: number): this {
    const pr = id + 1000
    this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, HEAD)
    return this
  }

  state(id: number): string | null {
    return (this.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(id) as { state: string | null } | undefined)?.state ?? null
  }

  count(type: string, id: number): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(type, id) as { n: number }).n)
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, []).map(candidate => candidate.cardId)
  }

  boardLines(): string[] {
    return plannedStallLines(this.db, new Date(Date.parse(TS) + STALLED_MINUTES * MINUTE_MS))
  }

  loggedSkips(): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    launchCandidates(this.db, () => false, () => Date.parse(TS) + STALLED_MINUTES * MINUTE_MS, laneOverlapRecorder(this.db, TS, 'policy'), [])
    const lines = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    return lines
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null): void {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId, pr, head, dedupeKey, payload, legacy: false })
    reduce(this.db, 'pending', busProjections())
  }
}

function reasonOf(boardLine: string): string {
  return boardLine.slice(boardLine.indexOf('minutes: ') + 'minutes: '.length)
}

describe('a move to later defers the card', () => {
  it('a move to later records card.deferred and a move to dropped still records card.dropped', () => {
    const bench = new Bench().admit(1).admit(2)
    expect(bench.move(1, DEFERRED_TARGET)).toBe(CARD_DEFERRED)
    expect(bench.state(1)).toBe(DEFERRED_CARD)
    expect(bench.count(CARD_DROPPED, 1)).toBe(0)
    expect(bench.move(2, 'dropped')).toBe(CARD_DROPPED)
    expect(bench.state(2)).toBe('dropped')
    expect(bench.count(CARD_DEFERRED, 2)).toBe(0)
  })

  it('a card depending on a deferred card sees it alive and keeps waiting', () => {
    const bench = new Bench().admit(1).admit(2, 'src/card-2.ts', [1])
    bench.move(1, DEFERRED_TARGET)
    expect(bench.state(1)).toBe(DEFERRED_CARD)
    expect(unsatisfiedDependencies(bench.db)([1])).toEqual([1])
    expect(bench.candidates()).toEqual([])
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
    layLanes(bench.db, LANES, TS, 'policy', null, [])
    expect(latestAssignment(bench.db, 2)?.reason).toBe('chain')
  })

  it('a deferred card does not start and returns to its lane by a move with no new intake', () => {
    const bench = new Bench().admit(1)
    bench.move(1, DEFERRED_TARGET)
    expect(bench.candidates()).toEqual([])
    expect(liveLanes(bench.db).map(card => card.cardId)).toEqual([])
    expect(layLanes(bench.db, LANES, TS, 'policy', null, [])).toBe(0)
    expect(bench.boardLines()).toEqual([])

    expect(bench.move(1, 'lane-2')).toBe(CARD_MOVED)
    expect(bench.state(1)).toBe('queued')
    expect(bench.candidates()).toEqual([1])
    expect(latestAssignment(bench.db, 1)).toMatchObject({ lane: 'lane-2', reason: 'moved' })
  })

  it('a pull request of a deferred card still takes it into review', () => {
    const bench = new Bench().admit(1)
    bench.move(1, DEFERRED_TARGET)
    bench.openPrOnDeferred(1)
    expect(bench.state(1)).toBe('in_review')
  })
})

describe('a startable planned card states why it has not started', () => {
  it('a startable card overlapping an open pull request warns overlap with open PR on its path', () => {
    const bench = new Bench().admit(1, 'apps/web/**, construct.json').openPr(1).admit(2, 'src/own.ts, apps/web/package.json')
    expect(bench.boardLines()).toEqual([`#2 planned and startable, not started for ${STALLED_MINUTES} minutes: overlap with open PR #1001 on apps/web/package.json`])
    expect(bench.loggedSkips().at(-1)).toContain('skip #2: overlap with open PR #1001 on apps/web/package.json')
  })

  it('the launch skip line carries the same reason as the board for the head of the lane and for occupied slots', () => {
    const lane = new Bench().admit(1).start(1).admit(2).moveTo(2, 'lane-1')
    const laneReason = reasonOf(lane.boardLines()[0]!)
    expect(laneReason).toBe('#1 at the head of lane-1')
    expect(lane.loggedSkips()).toEqual([expect.stringContaining(`skip #2: ${laneReason}`)])

    const slots = new Bench().admit(3)
    queueTask(slots.db, TS, { queue: 'launch', cardId: 3, generation: 'admit-3' })
    reduce(slots.db, 'pending', busProjections())
    const slotsReason = reasonOf(slots.boardLines()[0]!)
    expect(slotsReason).toBe('occupied slots')
    expect(slots.loggedSkips()).toEqual([expect.stringContaining(`skip #3: ${slotsReason}`)])
  })

  it('the skip line carries the prefix of the launch node log', () => {
    expect(LAUNCH_LOG_PREFIX).toBe(prefixOf('launch'))
  })

  it('the skip log writes a card again only when its reason changes', () => {
    const lines: string[] = []
    const log = new SkipLog(line => lines.push(line))
    log.skipped(1, 'occupied slots')
    log.skipped(1, 'occupied slots')
    log.skipped(1, '#2 at the head of lane-1')
    expect(lines).toEqual(['skip #1: occupied slots', 'skip #1: #2 at the head of lane-1'])
  })
})
