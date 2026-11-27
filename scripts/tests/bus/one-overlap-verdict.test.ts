import type { DatabaseSync } from 'node:sqlite'
import type { StartableHold } from '../../nodes/launch/launch-candidates.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { boardWarnings, plannedStallLines } from '../../cli/board-warnings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_HELD, CARD_STARTED, LANE_ASSIGNED, LANE_OVERLAP, PR_OBSERVED, SESSION_HEARTBEAT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { assignMovedLane, laneOverlapRecorder, layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, launchCandidates, startHold, UNEXPLAINED_HOLD } from '../../nodes/launch/launch-candidates.js'
import { openPrWarnings } from '../../nodes/launch/overlap.js'
import { sharedAppendFiles } from '../../nodes/launch/shared-files.js'
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

const SCHEDULER_TS = '2026-11-18T08:00:00.000Z'
const HEAD = 'c'.repeat(40)
const MINUTE_MS = 60_000
const STALLED_MINUTES = 20
const MACHINE_CORES = 16
const OWNER = 'owner'
const GENERATED_CONTRACT = 'contract/factory.json'
const UNDECLARED_CONTRACT = 'contract/surface.json'
const GENERATED_NOT_REBUILT = 'architecture/add-population.md'
const ADDITIVE_REGISTRY = 'scripts/core/events.ts'
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-scheduler-'))
  roots.push(root)
  return root
}

interface Shape {
  depends?: number[]
  priority?: string
  who?: string
  unclear?: string
}

function shapedCardText(id: number, touches: readonly string[], shape: Shape): string {
  const after = shape.depends === undefined || shape.depends.length === 0 ? '—' : shape.depends.map(each => `#${each}`).join(', ')
  const priority = shape.priority === undefined ? '' : `priority: ${shape.priority}\n`
  const unclear = shape.unclear === undefined ? '' : `unclear: ${shape.unclear}\n`
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: ${shape.who ?? 'shift'}\n${priority}\n${unclear}Do the thing.\n`
}

class SchedulerBench {
  readonly root = scratch()
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))

  constructor(private readonly shared: readonly string[] = []) {}

  admit(id: number, touches: readonly string[], shape: Shape = {}): this {
    const text = shapedCardText(id, touches, shape)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: SCHEDULER_TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: shape.depends ?? [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, LANES, SCHEDULER_TS, 'worker:launch:s1', id)
    return this.reduced()
  }

  start(id: number): this {
    return this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
  }

  beat(id: number): this {
    return this.append(SESSION_HEARTBEAT, id, null, `${SESSION_HEARTBEAT}:${id}`, { step: 'launch', session: `s-${id}` })
  }

  openPr(id: number, diff: readonly string[], truncated = false): this {
    this.start(id)
    const pr = id + 1000
    return this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, paths: diff, pathsTruncated: truncated }, HEAD)
  }

  holdForOwner(id: number): this {
    return this.append(CARD_HELD, id, null, `${CARD_HELD}:${id}`, { request: 1, reason: 'held' }, null, OWNER)
  }

  drop(id: number): this {
    return this.append(CARD_DROPPED, id, null, `${CARD_DROPPED}:${id}`, {})
  }

  moveTo(id: number, lane: string): this {
    assignMovedLane(this.db, id, lane, LANES, SCHEDULER_TS, 'policy')
    return this.reduced()
  }

  laneOf(id: number): { lane: string, reason: string } {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string }
    return JSON.parse(row.payload) as { lane: string, reason: string }
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(SCHEDULER_TS), () => {}, this.shared, () => LANES, this.machine()).map(candidate => candidate.cardId)
  }

  loggedSkips(): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    launchCandidates(this.db, () => false, () => Date.parse(SCHEDULER_TS) + STALLED_MINUTES * MINUTE_MS, laneOverlapRecorder(this.db, SCHEDULER_TS, 'policy'), this.shared, () => LANES, this.machine())
    const lines = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    return lines
  }

  boardLines(): string[] {
    return plannedStallLines(this.db, new Date(Date.parse(SCHEDULER_TS) + STALLED_MINUTES * MINUTE_MS))
  }

  private machine(): MachineSessions {
    return new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null, actor = 'policy'): this {
    appendEvent(this.db, { ts: SCHEDULER_TS, type, actor, cardId, pr, head, dedupeKey, payload, legacy: false })
    return this.reduced()
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function lineOf(lines: readonly string[], id: number): string {
  return lines.find(line => line.startsWith(`#${id} `)) ?? ''
}

describe('a card holds only the resources it touches', () => {
  it('two cards with disjoint touches start together', () => {
    const bench = new SchedulerBench().admit(1, ['scripts/a.ts']).admit(2, ['scripts/b.ts'])

    expect(bench.candidates().sort()).toEqual([1, 2])
  })

  it('a card that cannot start does not hold a ready card behind it', () => {
    const bench = new SchedulerBench().admit(9, ['scripts/z.ts']).holdForOwner(9).admit(1, ['scripts/a.ts'], { depends: [9] }).admit(2, ['scripts/a.ts', 'scripts/b.ts'])

    expect(bench.laneOf(2).lane).toBe(bench.laneOf(1).lane)
    expect(bench.candidates()).toEqual([2])
  })

  it('an open pull request holds only the files of its diff', () => {
    const bench = new SchedulerBench().admit(1, ['scripts/a.ts', 'scripts/b.ts']).openPr(1, ['scripts/b.ts']).admit(2, ['scripts/a.ts']).admit(3, ['scripts/b.ts'])

    expect(bench.candidates()).toContain(2)
    expect(bench.candidates()).not.toContain(3)
    expect(lineOf(bench.boardLines(), 3)).toContain('overlap with open PR #1001 on scripts/b.ts')
  })

  it('an open pull request whose recorded file list is truncated holds all its touches, not the partial list', () => {
    const bench = new SchedulerBench().admit(1, ['scripts/a.ts', 'scripts/b.ts']).openPr(1, ['scripts/b.ts'], true).admit(2, ['scripts/a.ts'])

    expect(bench.candidates()).not.toContain(2)
    expect(lineOf(bench.boardLines(), 2)).toContain('overlap with open PR #1001 on scripts/a.ts')
  })

  it('a card behind a card with an open pull request in its lane starts when its touches meet none of that diff', () => {
    const bench = new SchedulerBench().admit(1, ['scripts/a.ts', 'scripts/c.ts']).admit(2, ['scripts/a.ts'])
    bench.moveTo(2, bench.laneOf(1).lane).openPr(1, ['scripts/c.ts'])

    expect(bench.laneOf(2).lane).toBe(bench.laneOf(1).lane)
    expect(bench.candidates()).toEqual([2])
  })
})

describe('a card that can start and does not start names its holder on the board', () => {
  it('a card that can start and does not start shows on the board a reason naming its holder, and red without one', () => {
    const bench = new SchedulerBench()
      .admit(1, ['scripts/a.ts', 'scripts/b.ts'])
      .openPr(1, ['scripts/a.ts'])
      .admit(2, ['scripts/a.ts'])
      .admit(3, ['scripts/c.ts'])
      .start(3)
      .beat(3)
      .admit(4, ['scripts/d.ts'])
      .admit(5, ['scripts/e.ts'], { who: 'window' })
      .admit(6, ['scripts/f.ts'], { who: 'window', unclear: 'which allowlist holds the gate' })
      .admit(7, ['scripts/g.ts'])
    bench.moveTo(4, bench.laneOf(3).lane)
    const lines = bench.boardLines()

    expect(lineOf(lines, 2)).toContain('overlap with open PR #1001 on scripts/a.ts')
    expect(lineOf(lines, 4)).toContain(`#3 at the head of ${bench.laneOf(3).lane}`)
    expect(lineOf(lines, 5)).toContain('who: window')
    expect(lineOf(lines, 6)).toContain('unclear field: which allowlist holds the gate')
    expect(lineOf(lines, 7)).toContain(UNEXPLAINED_HOLD)
    expect(lines.join('\n')).not.toContain('occupied slots')
    const warnings = boardWarnings({ contexts: [], contextLimit: null, warnRatio: null, openPrs: 0, openPrLimit: null, ownerWaits: 0, stalls: lines, savingOff: false })
    expect(warnings.filter(warning => warning.level === 'red').map(warning => warning.text)).toEqual([lineOf(lines, 7)])
  })
})

describe('the start order', () => {
  it('a card that depends on a dropped or never-launchable card holds no card after it', () => {
    const bench = new SchedulerBench()
      .admit(8, ['scripts/z.ts'])
      .drop(8)
      .admit(1, ['scripts/a.ts'], { depends: [8] })
      .admit(2, ['scripts/b.ts'], { depends: [1] })
      .admit(3, ['scripts/a.ts', 'scripts/c.ts'])
      .admit(4, ['scripts/b.ts', 'scripts/d.ts'])

    expect(bench.candidates().sort()).toEqual([3, 4])
  })

  it('of two cards sharing a resource the higher release priority starts first whatever their admission order', () => {
    const bench = new SchedulerBench().admit(1, ['scripts/a.ts'], { priority: 'p2' }).admit(2, ['scripts/a.ts'], { priority: 'p0' })

    expect(bench.candidates()).toEqual([2])
  })
})

describe('what is no resource', () => {
  it('two cards that share only a generated contract file start together', () => {
    expect(sharedAppendFiles()).toContain(GENERATED_NOT_REBUILT)
    const lanes = new SchedulerBench(sharedAppendFiles())
      .admit(1, ['scripts/a.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])
      .admit(2, ['scripts/b.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])

    expect(lanes.laneOf(2).reason).not.toBe('chain')
    expect(lanes.candidates().sort()).toEqual([1, 2])

    const launch = new SchedulerBench(sharedAppendFiles()).admit(1, ['scripts/a.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT]).start(1).beat(1).admit(2, ['scripts/b.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])
    expect(launch.candidates()).toEqual([2])
  })

  it('in a repository with no declarations and no shared list, two cards that share only a contract file start together', () => {
    const bench = new SchedulerBench()
    vi.spyOn(process, 'cwd').mockReturnValue(bench.root)
    bench.admit(1, ['scripts/a.ts', UNDECLARED_CONTRACT]).admit(2, ['scripts/b.ts', UNDECLARED_CONTRACT])

    expect(bench.laneOf(2).reason).not.toBe('chain')
    expect(bench.candidates().sort()).toEqual([1, 2])

    bench.start(1).beat(1)
    expect(bench.candidates()).toEqual([2])
  })

  it('the open pull request of a card held for the owner does not hold its files against a higher-priority card', () => {
    const bench = new SchedulerBench()
      .admit(1, ['scripts/a.ts'], { priority: 'p2' })
      .openPr(1, ['scripts/a.ts'])
      .holdForOwner(1)
      .admit(2, ['scripts/a.ts'], { priority: 'p0' })
      .admit(3, ['scripts/a.ts', 'scripts/x.ts'], { priority: 'p2' })

    expect(bench.candidates()).toContain(2)
    expect(bench.candidates()).not.toContain(3)
  })

  it('two cards whose touches meet only on a file an owner decision declares additive both start with no overlap skip', () => {
    const shared = sharedAppendFiles()
    expect(shared).toContain(ADDITIVE_REGISTRY)
    const bench = new SchedulerBench(shared).admit(1, ['scripts/a.ts', ADDITIVE_REGISTRY]).start(1).beat(1).admit(2, ['scripts/b.ts', ADDITIVE_REGISTRY])

    expect(bench.candidates()).toEqual([2])
    expect(bench.loggedSkips().join('\n')).not.toContain('overlap')
    expect(openPrWarnings([{ file: '2.md', touches: [ADDITIVE_REGISTRY] } as Parameters<typeof openPrWarnings>[0][number]], [{ number: 1001, headRefName: 'feat/card-1', files: [ADDITIVE_REGISTRY] }])).toEqual([])
  })
})
