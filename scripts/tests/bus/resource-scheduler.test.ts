import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { boardWarnings, plannedStallLines } from '../../cli/board-warnings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_HELD, CARD_STARTED, LANE_ASSIGNED, PR_OBSERVED, SESSION_HEARTBEAT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { assignMovedLane, laneOverlapRecorder } from '../../nodes/launch/lane-assign.js'
import { launchCandidates, UNEXPLAINED_HOLD } from '../../nodes/launch/launch-candidates.js'
import { openPrWarnings } from '../../nodes/launch/overlap.js'
import { sharedAppendFiles } from '../../nodes/launch/shared-files.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-18T08:00:00.000Z'
const HEAD = 'c'.repeat(40)
const MINUTE_MS = 60_000
const STALLED_MINUTES = 20
const LANES = 4
const MACHINE_CORES = 16
const OWNER = 'owner'
const GENERATED_CONTRACT = 'contract/factory.json'
const GENERATED_NOT_REBUILT = 'architecture/add-population.md'
const ADDITIVE_REGISTRY = 'scripts/core/events.ts'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

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

function cardText(id: number, touches: readonly string[], shape: Shape): string {
  const after = shape.depends === undefined || shape.depends.length === 0 ? '—' : shape.depends.map(each => `#${each}`).join(', ')
  const priority = shape.priority === undefined ? '' : `priority: ${shape.priority}\n`
  const unclear = shape.unclear === undefined ? '' : `unclear: ${shape.unclear}\n`
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: ${shape.who ?? 'shift'}\n${priority}\n${unclear}Do the thing.\n`
}

class Bench {
  readonly root = scratch()
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))

  constructor(private readonly shared: readonly string[] = []) {}

  admit(id: number, touches: readonly string[], shape: Shape = {}): this {
    const text = cardText(id, touches, shape)
    busCardEvents(this.db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: shape.depends ?? [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
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
    assignMovedLane(this.db, id, lane, LANES, TS, 'policy')
    return this.reduced()
  }

  laneOf(id: number): { lane: string, reason: string } {
    const row = this.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(id) as { payload: string }
    return JSON.parse(row.payload) as { lane: string, reason: string }
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, this.shared, () => LANES, this.machine()).map(candidate => candidate.cardId)
  }

  loggedSkips(): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    launchCandidates(this.db, () => false, () => Date.parse(TS) + STALLED_MINUTES * MINUTE_MS, laneOverlapRecorder(this.db, TS, 'policy'), this.shared, () => LANES, this.machine())
    const lines = log.mock.calls.map(call => String(call[0]))
    log.mockRestore()
    return lines
  }

  boardLines(): string[] {
    return plannedStallLines(this.db, new Date(Date.parse(TS) + STALLED_MINUTES * MINUTE_MS))
  }

  private machine(): MachineSessions {
    return new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)
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

function lineOf(lines: readonly string[], id: number): string {
  return lines.find(line => line.startsWith(`#${id} `)) ?? ''
}

describe('a card holds only the resources it touches', () => {
  it('two cards with disjoint touches start together', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts']).admit(2, ['scripts/b.ts'])

    expect(bench.candidates().sort()).toEqual([1, 2])
  })

  it('a card that cannot start does not hold a ready card behind it', () => {
    const bench = new Bench().admit(9, ['scripts/z.ts']).holdForOwner(9).admit(1, ['scripts/a.ts'], { depends: [9] }).admit(2, ['scripts/a.ts', 'scripts/b.ts'])

    expect(bench.laneOf(2).lane).toBe(bench.laneOf(1).lane)
    expect(bench.candidates()).toEqual([2])
  })

  it('an open pull request holds only the files of its diff', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts', 'scripts/b.ts']).openPr(1, ['scripts/b.ts']).admit(2, ['scripts/a.ts']).admit(3, ['scripts/b.ts'])

    expect(bench.candidates()).toContain(2)
    expect(bench.candidates()).not.toContain(3)
    expect(lineOf(bench.boardLines(), 3)).toContain('overlap with open PR #1001 on scripts/b.ts')
  })

  it('an open pull request whose recorded file list is truncated holds all its touches, not the partial list', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts', 'scripts/b.ts']).openPr(1, ['scripts/b.ts'], true).admit(2, ['scripts/a.ts'])

    expect(bench.candidates()).not.toContain(2)
    expect(lineOf(bench.boardLines(), 2)).toContain('overlap with open PR #1001 on scripts/a.ts')
  })

  it('a card behind a card with an open pull request in its lane starts when its touches meet none of that diff', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts', 'scripts/c.ts']).admit(2, ['scripts/a.ts'])
    bench.moveTo(2, bench.laneOf(1).lane).openPr(1, ['scripts/c.ts'])

    expect(bench.laneOf(2).lane).toBe(bench.laneOf(1).lane)
    expect(bench.candidates()).toEqual([2])
  })
})

describe('a card that can start and does not start names its holder on the board', () => {
  it('a card that can start and does not start shows on the board a reason naming its holder, and red without one', () => {
    const bench = new Bench()
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
    const bench = new Bench()
      .admit(8, ['scripts/z.ts'])
      .drop(8)
      .admit(1, ['scripts/a.ts'], { depends: [8] })
      .admit(2, ['scripts/b.ts'], { depends: [1] })
      .admit(3, ['scripts/a.ts', 'scripts/c.ts'])
      .admit(4, ['scripts/b.ts', 'scripts/d.ts'])

    expect(bench.candidates().sort()).toEqual([3, 4])
  })

  it('of two cards sharing a resource the higher release priority starts first whatever their admission order', () => {
    const bench = new Bench().admit(1, ['scripts/a.ts'], { priority: 'p2' }).admit(2, ['scripts/a.ts'], { priority: 'p0' })

    expect(bench.candidates()).toEqual([2])
  })
})

describe('what is no resource', () => {
  it('two cards that share only a generated contract file start together', () => {
    expect(sharedAppendFiles()).toContain(GENERATED_NOT_REBUILT)
    const lanes = new Bench(sharedAppendFiles())
      .admit(1, ['scripts/a.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])
      .admit(2, ['scripts/b.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])

    expect(lanes.laneOf(2).reason).not.toBe('chain')
    expect(lanes.candidates().sort()).toEqual([1, 2])

    const launch = new Bench(sharedAppendFiles()).admit(1, ['scripts/a.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT]).start(1).beat(1).admit(2, ['scripts/b.ts', GENERATED_CONTRACT, GENERATED_NOT_REBUILT])
    expect(launch.candidates()).toEqual([2])
  })

  it('the open pull request of a card held for the owner does not hold its files against a higher-priority card', () => {
    const bench = new Bench()
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
    const bench = new Bench(shared).admit(1, ['scripts/a.ts', ADDITIVE_REGISTRY]).start(1).beat(1).admit(2, ['scripts/b.ts', ADDITIVE_REGISTRY])

    expect(bench.candidates()).toEqual([2])
    expect(bench.loggedSkips().join('\n')).not.toContain('overlap')
    expect(openPrWarnings([{ file: '2.md', touches: [ADDITIVE_REGISTRY] } as Parameters<typeof openPrWarnings>[0][number]], [{ number: 1001, headRefName: 'feat/card-1', files: [ADDITIVE_REGISTRY] }])).toEqual([])
  })
})
