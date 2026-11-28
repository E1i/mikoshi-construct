import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { ownerHolds } from '../../cli/board-page/live-cards.js'
import { cardHoldOf, outsideTouchesReason, outsideTouchesStops } from '../../core/card-hold.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OPEN_QUESTION, OUTSIDE_TOUCHES, QUESTION_AGENT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { laneOverlapRecorder, layLanes } from '../../nodes/launch/lane-assign.js'
import { heldSessionStop, launchCandidates, UNEXPLAINED_HOLD } from '../../nodes/launch/launch-candidates.js'
import { BusRead } from '../../ports/bus-read.js'
import { UNREAD_THERMAL } from '../../ports/host-thermal.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-27T22:57:00.000Z'
const LATER_MS = Date.parse(TS) + 20 * 60_000
const LANES = 4
const MACHINE_CORES = 16
const CARD = 2324
const MISSED = ['scripts/cli/card.ts', 'scripts/cli/mutate.ts']
const BOARD_NO_REASON = 'the hold names no reason'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: readonly string[]): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\npriority: p1\n\nDo the thing.\n`
}

class Bench {
  readonly root = mkdtempSync(path.join(tmpdir(), 'outside-touches-reason-'))
  readonly db: DatabaseSync
  private stops = 0

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(touches: readonly string[], source?: string): this {
    const text = cardText(CARD, touches)
    const amend = source === undefined ? {} : { source }
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: CARD, ts: TS, dedupeKey: `admit-${CARD}-${textSha(text)}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text), ...amend } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', CARD)
    return this.reduced()
  }

  stopOutsideTouches(paths: readonly string[] = MISSED, code: string = OUTSIDE_TOUCHES): this {
    const stop = ++this.stops
    this.append(CARD_STARTED, `${CARD_STARTED}:${CARD}:${stop}`, {})
    return this.append(CARD_STOPPED, `${CARD_STOPPED}:${CARD}:${stop}`, { reason: QUESTION_AGENT, code, paths, widen: paths })
  }

  decideOnTheCard(): this {
    return this.append(DECISION_RECORDED, `${DECISION_RECORDED}:${CARD}`, { decisionId: 1, text: '[owner] no widening is needed', scope: [CARD] }, 'owner')
  }

  latestStop(): number {
    return new BusRead(this.db).where({ card: CARD }).slice(CARD_STOPPED, [], 'last')[0]!.id
  }

  holdNamingNoReason(): this {
    return this.append(CARD_HELD, `${CARD_HELD}:${CARD}`, { request: 1 }, 'owner')
  }

  release(): this {
    return this.append(CARD_RELEASED, `${CARD_RELEASED}:${CARD}`, { request: 2 }, 'owner')
  }

  boardReason(): string | undefined {
    const read = new BusRead(this.db)
    return ownerHolds(read.slice(CARD_HELD, ['reason', 'takeover']), read.slice(CARD_RELEASED, ['takeover']), outsideTouchesStops(this.db, read.slice(CARD_STOPPED, ['code', 'paths']))).get(CARD)
  }

  launchLine(): string | undefined {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    launchCandidates(this.db, () => false, () => LATER_MS, laneOverlapRecorder(this.db, TS, 'worker:launch:w1'), [], () => LANES, new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES), UNREAD_THERMAL)
    const lines = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    return lines.find(line => line.includes(`#${CARD}`))
  }

  private append(type: string, dedupeKey: string, payload: Record<string, unknown>, actor = 'policy'): this {
    appendEvent(this.db, { ts: TS, type, actor, cardId: CARD, pr: null, head: null, dedupeKey, payload, legacy: false })
    return this.reduced()
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function namesTheStop(line: string | undefined): void {
  expect(line).toContain('outside its touches')
  for (const missed of MISSED)
    expect(line).toContain(missed)
}

describe('a card stopped on paths outside its touches names that stop', () => {
  it('the board names outside touches and both paths for a hold that names no reason, never that the hold names no reason', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches().holdNamingNoReason()
    const reason = bench.boardReason()

    namesTheStop(reason)
    expect(reason).not.toContain(BOARD_NO_REASON)
    namesTheStop(cardHoldOf(bench.db, CARD) ?? undefined)
    expect(cardHoldOf(bench.db, CARD)).not.toContain(BOARD_NO_REASON)
  })

  it('the launch log line names outside touches and both paths in the same words the board uses, never that the scheduler names no reason', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches().holdNamingNoReason()
    const board = bench.boardReason()
    bench.release().admit(['scripts/a.ts', 'scripts/y.ts'], 'amend')
    const line = bench.launchLine()

    expect(board).toBe(outsideTouchesReason(bench.latestStop(), MISSED))
    expect(line).toContain(board)
    expect(line).not.toContain(UNEXPLAINED_HOLD)
  })

  it('once an amend covers the paths, the board, the card hold and the launch all stop naming the stop', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches().admit(['scripts/a.ts', ...MISSED], 'amend').holdNamingNoReason()

    expect(bench.boardReason()).toBe(BOARD_NO_REASON)
    expect(cardHoldOf(bench.db, CARD)).toContain(BOARD_NO_REASON)
    expect(heldSessionStop(bench.db, CARD)).toBeNull()
  })

  it('an amend that covers one path leaves the board naming only the path still outside', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches().admit(['scripts/a.ts', MISSED[0]!], 'amend').holdNamingNoReason()

    expect(bench.boardReason()).toBe(outsideTouchesReason(bench.latestStop(), [MISSED[1]!]))
    expect(heldSessionStop(bench.db, CARD)?.paths).toEqual([MISSED[1]])
  })

  it('a decision bound to the card after the stop answers it on the board as in the launch', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches().decideOnTheCard().holdNamingNoReason()

    expect(bench.boardReason()).toBe(BOARD_NO_REASON)
    expect(heldSessionStop(bench.db, CARD)).toBeNull()
  })

  it('a latest stop on an open question that names paths is no outside-touches reason', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches(MISSED, OPEN_QUESTION).holdNamingNoReason()

    expect(bench.boardReason()).toBe(BOARD_NO_REASON)
  })

  it('of two outside-touches stops the latest names the reason', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches([MISSED[0]!]).stopOutsideTouches([MISSED[1]!]).holdNamingNoReason()

    expect(bench.boardReason()).toBe(outsideTouchesReason(bench.latestStop(), [MISSED[1]!]))
  })

  it('an outside-touches stop that names no path, or only an empty one, leaves the hold naming no reason', () => {
    expect(new Bench().admit(['scripts/a.ts']).stopOutsideTouches([]).holdNamingNoReason().boardReason()).toBe(BOARD_NO_REASON)
    expect(new Bench().admit(['scripts/a.ts']).stopOutsideTouches(['']).holdNamingNoReason().boardReason()).toBe(BOARD_NO_REASON)
  })

  it('a hold that names its own reason keeps it on the board', () => {
    const bench = new Bench().admit(['scripts/a.ts']).stopOutsideTouches()
    appendEvent(bench.db, { ts: TS, type: CARD_HELD, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_HELD}:named`, payload: { request: 3, reason: 'D-1' }, legacy: false })

    expect(bench.boardReason()).toBe('D-1')
  })
})
