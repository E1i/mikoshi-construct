import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent, OwnerWaitNeed } from '../../bus/db.js'
import type { CardStarter } from '../../bus/launch-executor.js'
import type { QueuedTask } from '../../bus/queue.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, closeOwnerWait, openBus, openOwnerWait } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { busCardEvents, busIntakePorts } from '../../bus/intake.js'
import { chainLaneNumber, currentLane, DEFAULT_LANE_COUNT, laneCount, laneOverlapRecorder, layLanes, liveLanes, OWNER_MERGE, repositoryLanes, STALLED } from '../../bus/lane-assign.js'
import { launchCandidates } from '../../bus/launch-candidates.js'
import { LaunchNode } from '../../bus/launch-worker.js'
import { failTask, leaseQueued } from '../../bus/lease.js'
import { queueTask, supersedeTask } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, CARD_STOPPED, LANE_ASSIGNED, LANE_OVERLAP, POLICY_DENIED, PR_CLOSED, PR_OBSERVED } from '../../core/events.js'

const TS = '2026-10-22T10:00:00.000Z'
const HEAD = 'a'.repeat(40)
const NEW_HEAD = 'b'.repeat(40)
const NO_COUNT_LINE = { kind: 'authority', rule: 'no_matrix_count_line', detail: 'no count line' }
const roots: string[] = []
const startDir = process.cwd()

afterEach(() => {
  process.chdir(startDir)
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
  private denials = 0

  constructor(readonly lanes: number) {
    this.db = openBus(path.join(tempRoot(), 'bus.db'))
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    this.admissions += 1
    busCardEvents(this.db, 's1', () => this.lanes)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    reduce(this.db)
    return this
  }

  amendAround(id: number, touches: string): this {
    const text = cardText(id, touches)
    this.admissions += 1
    appendEvent(this.db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `amend-${id}-${this.admissions}`, payload: { lane: null, depends: [], text, textSha: textSha(text) }, legacy: false })
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

  overlapsCaught(): number[] {
    const caught: number[] = []
    launchCandidates(this.db, () => false, Date.now, cardId => caught.push(cardId))
    return caught
  }

  openPr(id: number, head = HEAD): number {
    const pr = id + 1000
    appendEvent(this.db, { ts: TS, type: PR_OBSERVED, actor: 'netwatch', cardId: id, pr, head, dedupeKey: `${PR_OBSERVED}:${pr}:${head}`, payload: { card_id: id, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    reduce(this.db)
    return pr
  }

  admitWithoutBody(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `bodiless-${id}`, payload: { lane: null, depends: [] }, legacy: false })
    reduce(this.db)
    layLanes(this.db, this.lanes, TS, 'policy')
    return this
  }

  queued(task: QueuedTask): this {
    queueTask(this.db, TS, task)
    reduce(this.db)
    return this
  }

  withdrawn(task: QueuedTask, reason = 'not_mine', context: BusEvent[] = []): this {
    queueTask(this.db, TS, task)
    const lease = leaseQueued(this.db, TS, taskKey(task), `worker:${task.queue}:w1`)!
    failTask(this.db, TS, lease, { reason, withdraw: true }, context)
    reduce(this.db)
    return this
  }

  leased(task: QueuedTask): this {
    queueTask(this.db, TS, task)
    leaseQueued(this.db, TS, taskKey(task), `worker:${task.queue}:w1`)
    reduce(this.db)
    return this
  }

  superseded(task: QueuedTask): this {
    queueTask(this.db, TS, task)
    supersedeTask(this.db, TS, task)
    reduce(this.db)
    return this
  }

  deniedMerge(id: number, denial: Record<string, unknown>): this {
    const pr = this.openPr(id)
    return this.withdrawn({ queue: 'merge', cardId: id, pr, head: HEAD }, String(denial.rule ?? denial.reason), [this.denialEvent(id, pr, denial)])
  }

  denied(id: number, denial: Record<string, unknown>, command = 'merge'): this {
    appendEvent(this.db, this.denialEvent(id, id + 1000, denial, command))
    return this
  }

  awaitingOwnerMerge(id: number, denied = true): this {
    const pr = this.openPr(id)
    if (denied)
      appendEvent(this.db, this.denialEvent(id, pr, { kind: 'authority', rule: 'no_shard_merge', detail: 'changes .claude/agents/x.md, which stays the owner\'s' }))
    return this.ownerWait(id, 'merge', pr)
  }

  ownerWait(id: number, need: OwnerWaitNeed, pr: number, closed = false): this {
    const wait = openOwnerWait(this.db, TS, 'policy', { need, text: 'over to the owner', card: id, pr })
    if (closed)
      closeOwnerWait(this.db, TS, 'owner', wait, 'done', 1)
    reduce(this.db)
    return this
  }

  closedPr(id: number, merged: boolean): this {
    const pr = id + 1000
    appendEvent(this.db, { ts: TS, type: PR_CLOSED, actor: 'netwatch', cardId: id, pr, head: null, dedupeKey: `${PR_CLOSED}:${pr}`, payload: { merged }, legacy: false })
    reduce(this.db)
    return this
  }

  private denialEvent(id: number, pr: number, denial: Record<string, unknown>, command = 'merge'): BusEvent {
    this.denials += 1
    return { ts: TS, type: POLICY_DENIED, actor: 'policy', cardId: id, pr, head: HEAD, dedupeKey: `${POLICY_DENIED}:${id}:${this.denials}`, payload: { command, ...denial }, legacy: false }
  }

  stallDetails(): unknown[] {
    return (this.db.prepare(`SELECT payload FROM events WHERE type = '${BOARD_ALARM}' AND json_extract(payload, '$.reason') = ? ORDER BY id`).all(STALLED) as { payload: string }[])
      .map(row => (JSON.parse(row.payload) as Record<string, unknown>).detail)
  }

  stallAlarms(): { card: number, cause: unknown }[] {
    return (this.db.prepare(`SELECT card_id, payload FROM events WHERE type = '${BOARD_ALARM}' ORDER BY id`).all() as { card_id: number, payload: string }[])
      .map(row => ({ card: row.card_id, payload: JSON.parse(row.payload) as Record<string, unknown> }))
      .filter(alarm => alarm.payload.reason === STALLED)
      .map(alarm => ({ card: alarm.card, cause: alarm.payload.cause }))
  }

  count(type: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n
  }
}

class LayingLaunchNode extends LaunchNode {
  laid(): QueuedTask[] {
    return this.candidates()
  }
}

function launchNode(db: DatabaseSync, lanes?: () => number): LayingLaunchNode {
  return new LayingLaunchNode({ db, starter: {} as CardStarter, clock: () => new Date(TS), session: 'w1', mode: 'live', env: {}, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), ...(lanes === undefined ? {} : { lanes }) })
}

function repositoryWithLanes(lanes: number): string {
  const repo = tempRoot()
  execFileSync('git', ['-C', repo, 'init', '-q'])
  writeFileSync(path.join(repo, 'construct.json'), JSON.stringify({ lanes }))
  return repo
}

function admittedWithoutLane(db: DatabaseSync, id: number): void {
  const text = cardText(id, `src/${id}.ts`)
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `bare-${id}`, payload: { lane: null, depends: [], text, textSha: textSha(text) }, legacy: false })
  reduce(db)
}

function assignedCounts(db: DatabaseSync): number[] {
  return (db.prepare(`SELECT json_extract(payload, '$.lanes') AS lanes FROM events WHERE type = '${LANE_ASSIGNED}' ORDER BY id`).all() as { lanes: number }[]).map(row => row.lanes)
}

function admitThroughPort(db: DatabaseSync, events: ReturnType<typeof busCardEvents>, id: number): void {
  const text = cardText(id, `src/${id}.ts`)
  events({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `port-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
  reduce(db)
}

describe('the bus reads N where it assigns', () => {
  it('a live launch node lays lanes with the N it is given', () => {
    const bench = new Bench(3)
    admittedWithoutLane(bench.db, 1)
    launchNode(bench.db, () => 2).laid()
    expect(assignedCounts(bench.db)).toEqual([2])
  })

  it('a launch node given no N reads it from the construct.json of the repository it runs in', () => {
    process.chdir(repositoryWithLanes(2))
    const bench = new Bench(3)
    admittedWithoutLane(bench.db, 1)
    launchNode(bench.db).laid()
    expect(assignedCounts(bench.db)).toEqual([2])
  })

  it('the intake ports lay lanes with the N they are given', () => {
    const bench = new Bench(3)
    admitThroughPort(bench.db, busIntakePorts(bench.db, 's1', () => 4).cardEvents, 1)
    expect(assignedCounts(bench.db)).toEqual([4])
  })

  it('intake ports given no N read it from the construct.json of the repository they run in', () => {
    process.chdir(repositoryWithLanes(2))
    const bench = new Bench(3)
    admitThroughPort(bench.db, busIntakePorts(bench.db, 's1').cardEvents, 1)
    expect(assignedCounts(bench.db)).toEqual([2])
  })
})

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

  it('a dropped card is assigned no lane by its earlier admission', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').start(1)
    appendEvent(bench.db, { ts: TS, type: CARD_DROPPED, actor: 'policy', cardId: 1, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:1`, payload: {}, legacy: false })
    appendEvent(bench.db, { ts: TS, type: CARD_STOPPED, actor: 'worker:launch:w1', cardId: 1, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:1`, payload: { reason: 'fault', detail: 'session-end' }, legacy: false })
    expect(layLanes(bench.db, 3, TS, 'policy')).toBe(0)
    expect(bench.count(LANE_ASSIGNED)).toBe(1)
    expect(bench.lane(1)).toBeNull()
    bench.admit(1, 'src/a.ts')
    expect(bench.lane(1)).toBe('lane-1')
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

  it('the bus reads the lane count from construct.json or from the attach record', () => {
    const attached = tempRoot()
    mkdirSync(path.join(attached, '.construct'), { recursive: true })
    writeFileSync(path.join(attached, '.construct/attach.json'), JSON.stringify({ recordVersion: 3, lanes: 6 }))
    expect(laneCount(attached)).toBe(6)

    const constructed = tempRoot()
    writeFileSync(path.join(constructed, 'construct.json'), JSON.stringify({ construct: '0.1.0', lanes: 4 }))
    expect(laneCount(constructed)).toBe(4)

    const neither = tempRoot()
    mkdirSync(path.join(neither, '.construct'), { recursive: true })
    writeFileSync(path.join(neither, '.construct/attach.json'), JSON.stringify({ recordVersion: 3 }))
    expect(laneCount(neither)).toBe(DEFAULT_LANE_COUNT)
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

  it('lowering N re-lays the cards whose lane is above it', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts')
    expect(bench.lane(3)).toBe('lane-3')
    expect(layLanes(bench.db, 2, TS, 'policy')).toBe(1)
    expect(liveLanes(bench.db).every(card => (chainLaneNumber(card.lane) ?? Infinity) <= 2)).toBe(true)
    expect(layLanes(bench.db, 2, TS, 'policy')).toBe(0)
  })

  it('two chained cards above a lowered N land in one lane', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts').admit(3, 'src/c.ts').admit(4, 'src/c.ts')
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-3', 'lane-3'])
    layLanes(bench.db, 2, TS, 'policy')
    expect(bench.lane(4)).toBe(bench.lane(3))
    expect(['lane-1', 'lane-2']).toContain(bench.lane(3))
  })

  it('a card laid out before the card it depends on is joined by that card', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts', [2]).admit(2, 'src/b.ts')
    expect([bench.lane(1), bench.lane(2)]).toEqual(['lane-1', 'lane-1'])
  })

  it('a first-run layout chains a card to a dependency with a higher number', () => {
    const bench = new Bench(3)
    for (const [id, depends] of [[1, [3]], [2, []], [3, []]] as [number, number[]][]) {
      const text = cardText(id, `src/${id}.ts`, depends)
      appendEvent(bench.db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `legacy-${id}`, payload: { lane: null, depends, text, textSha: textSha(text) }, legacy: false })
    }
    reduce(bench.db)
    layLanes(bench.db, 3, TS, 'policy')
    expect(bench.lane(3)).toBe(bench.lane(1))
    expect(bench.lane(2)).not.toBe(bench.lane(1))
  })

  it('two overlapping cards in different lanes trip the safety net for the second, once its body is folded', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts').amendAround(2, 'src/a.ts')
    expect([bench.lane(1), bench.lane(2)]).toEqual(['lane-1', 'lane-2'])
    expect(bench.overlapsCaught()).toEqual([])
    reduce(bench.db)
    expect(bench.overlapsCaught()).toEqual([2])
    expect(bench.launchable()).toEqual([1])
  })

  it('the safety net records one lane.overlap per generation', () => {
    const bench = new Bench(3).admit(1, 'src/a.ts').admit(2, 'src/b.ts').amendAround(2, 'src/a.ts')
    reduce(bench.db)
    const record = laneOverlapRecorder(bench.db, TS, 'policy')
    launchCandidates(bench.db, () => false, Date.now, record)
    launchCandidates(bench.db, () => false, Date.now, record)
    expect(bench.count(LANE_OVERLAP)).toBe(1)
    expect(JSON.parse((bench.db.prepare(`SELECT payload FROM events WHERE type = '${LANE_OVERLAP}'`).get() as { payload: string }).payload)).toMatchObject({ lane: 'lane-2' })
  })

  it('n is read from the construct.json of the main checkout, also from a worktree', () => {
    const repo = tempRoot()
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root')
    const tree = path.join(tempRoot(), 'tree')
    git('worktree', 'add', '-q', tree)
    writeFileSync(path.join(repo, 'construct.json'), JSON.stringify({ lanes: 2 }))
    writeFileSync(path.join(tree, 'construct.json'), JSON.stringify({ lanes: 7 }))
    const lanes = repositoryLanes(tree)
    expect(lanes()).toBe(2)
    writeFileSync(path.join(repo, 'construct.json'), JSON.stringify({ lanes: 4 }))
    expect(lanes()).toBe(4)
  })
})

describe('a card that cannot move by itself frees its lane', () => {
  function launched(bench: Bench, lanes: number): number[] {
    return launchNode(bench.db, () => lanes).laid().map(task => task.cardId)
  }

  it('a card denied no_matrix_count_line raises an alarm and frees its lane for a card whose touches do not overlap', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).admit(2, 'src/a.ts').admit(3, 'src/b.ts')
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1'])
    expect(launched(bench, 1)).toEqual([3])
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'no_matrix_count_line' }])
  })

  it('a card whose PR only the owner merges frees its lane for a card whose touches do not overlap', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).awaitingOwnerMerge(1).admit(2, 'src/a.ts').admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([3])
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'no_shard_merge' }])
  })

  it('a technical merge denial raises an alarm and frees its lane for a card whose touches do not overlap', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, { kind: 'technical', reason: 'witness', detail: 'no witness.recorded' }).admit(2, 'src/a.ts').admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([3])
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'witness' }])
  })

  it('a card that is still moving keeps its lane and raises no alarm', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1)
    bench.openPr(1)
    bench.admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('the stall alarm is raised once however often the lanes are laid', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, { kind: 'technical', reason: 'witness', detail: 'no witness.recorded' })
    launched(bench, 1)
    launched(bench, 1)
    expect(bench.stallAlarms()).toHaveLength(1)
  })

  it('queued cards laid behind a stalled card are re-laid into a lane that has emptied', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/c.ts').admit(4, 'src/d.ts').admit(5, 'src/e.ts')
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.drop(2).drop(4).deniedMerge(1, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([3, 5])
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-2', 'lane-1'])
  })

  it('a withdrawn merge task at a head the card has since pushed past is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE)
    bench.openPr(1, NEW_HEAD)
    bench.admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('a withdrawn merge task beside a queued answer task of the card is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).queued({ queue: 'answer', cardId: 1, pr: 1001, head: HEAD }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('a stalled card with a launch task in the queue keeps its lane', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).queued({ queue: 'launch', cardId: 1, generation: 'again' }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
  })

  it('a queued card that depends on the stalled card stays held, also when it is re-laid', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/c.ts', [1]).admit(4, 'src/d.ts').admit(5, 'src/e.ts')
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.drop(2).drop(4).deniedMerge(1, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([5])
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-1', 'lane-2'])
  })

  it('a queued card without a body stays held behind a stalled card', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).admitWithoutBody(3)
    expect(bench.lane(3)).toBe('lane-1')
    expect(launched(bench, 1)).toEqual([])
  })

  it('a stalled card without a body holds its lane for every queued card', () => {
    const bench = new Bench(1).admitWithoutBody(1).start(1).deniedMerge(1, NO_COUNT_LINE).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'no_matrix_count_line' }])
  })

  it('an owner merge wait with no recorded denial names the owner merge as the cause', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).awaitingOwnerMerge(1, false).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([3])
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: OWNER_MERGE }])
    expect(bench.stallDetails()).toEqual(['card #1 cannot move by itself: PR #1001 waits for the owner to merge it'])
  })

  it('a queued card whose touches overlap the stalled card is not re-laid', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/a.ts').admit(4, 'src/d.ts').admit(5, 'src/e.ts')
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.drop(2).drop(4).deniedMerge(1, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([5])
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-1', 'lane-2'])
  })

  it('a queued card behind a stalled card is not re-laid when no lane is free', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2)
    for (const id of [3, 4, 5, 6, 7])
      bench.admit(id, `src/${id}.ts`)
    expect([3, 4, 5, 6, 7].map(id => bench.lane(id))).toEqual(['lane-1', 'lane-2', 'lane-1', 'lane-2', 'lane-1'])
    bench.drop(4).drop(6).deniedMerge(1, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([3])
    expect([3, 5, 7].map(id => bench.lane(id))).toEqual(['lane-1', 'lane-1', 'lane-1'])
  })

  it('a queued card alone behind a stalled card keeps its lane', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/c.ts').admit(4, 'src/d.ts')
    expect([bench.lane(3), bench.lane(4)]).toEqual(['lane-1', 'lane-2'])
    bench.drop(1).drop(3).deniedMerge(2, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([4])
    expect(bench.lane(4)).toBe('lane-2')
  })

  it('a withdrawn merge task beside a leased answer task of the card is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).leased({ queue: 'answer', cardId: 1, pr: 1001, head: HEAD }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('a merge task that was superseded, not withdrawn, is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1)
    bench.openPr(1)
    bench.superseded({ queue: 'merge', cardId: 1, pr: 1001, head: HEAD }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('a withdrawn task of another queue at the pull request head is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1)
    bench.openPr(1)
    bench.withdrawn({ queue: 'review', cardId: 1, pr: 1001, head: HEAD }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('a withdrawn merge task of another pull request at the same head is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1)
    bench.openPr(1)
    bench.withdrawn({ queue: 'merge', cardId: 1, pr: 1002, head: HEAD }).admit(3, 'src/b.ts')
    expect(launched(bench, 1)).toEqual([])
    expect(bench.stallAlarms()).toEqual([])
  })

  it('an owner merge wait that is closed, of another need or of another pull request is no stall', () => {
    for (const [need, pr, closed] of [['merge', 1001, true], ['decision', 1001, false], ['merge', 1002, false]] as [OwnerWaitNeed, number, boolean][]) {
      const bench = new Bench(1).admit(1, 'src/a.ts').start(1)
      bench.openPr(1)
      bench.ownerWait(1, need, pr, closed).admit(3, 'src/b.ts')
      expect(launched(bench, 1)).toEqual([])
      expect(bench.stallAlarms()).toEqual([])
    }
  })

  it('a merged pull request with a withdrawn merge task is no stall', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).closedPr(1, true)
    launched(bench, 1)
    expect(bench.stallAlarms()).toEqual([])
  })

  it('the alarm names the latest merge denial of the card, not an older one and not a denial of another command', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').start(1).deniedMerge(1, NO_COUNT_LINE).denied(1, { kind: 'technical', reason: 'witness', detail: 'the latest merge denial' }).denied(1, { kind: 'denied', rule: 'not_open', detail: 'a close denial' }, 'close')
    launched(bench, 1)
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'witness' }])
    expect(bench.stallDetails()).toEqual(['card #1 cannot move by itself: the latest merge denial'])
  })

  it('two stalled cards raise one alarm each, once', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).deniedMerge(1, NO_COUNT_LINE).deniedMerge(2, { kind: 'technical', reason: 'witness', detail: 'no witness.recorded' })
    launched(bench, 2)
    launched(bench, 2)
    expect(bench.stallAlarms()).toEqual([{ card: 1, cause: 'no_matrix_count_line' }, { card: 2, cause: 'witness' }])
  })

  it('a started card in the stalled card lane is not re-laid', () => {
    const bench = new Bench(2).admit(1, 'src/a.ts').admit(2, 'src/b.ts').start(1).start(2).admit(3, 'src/c.ts').admit(4, 'src/d.ts').admit(5, 'src/e.ts')
    expect([bench.lane(3), bench.lane(4), bench.lane(5)]).toEqual(['lane-1', 'lane-2', 'lane-1'])
    bench.drop(2).drop(4).start(3).deniedMerge(1, NO_COUNT_LINE)
    expect(launched(bench, 2)).toEqual([5])
    expect([bench.lane(3), bench.lane(5)]).toEqual(['lane-1', 'lane-2'])
  })

  it('a queued card in a lane no stalled card holds is not re-laid', () => {
    const bench = new Bench(3)
    for (const id of [1, 2, 3])
      bench.admit(id, `src/${id}.ts`).start(id)
    for (const id of [4, 5, 6, 7])
      bench.admit(id, `src/${id}.ts`)
    expect([4, 5, 6, 7].map(id => bench.lane(id))).toEqual(['lane-1', 'lane-2', 'lane-3', 'lane-1'])
    bench.drop(3).drop(6).deniedMerge(2, NO_COUNT_LINE)
    expect(launched(bench, 3)).toEqual([5])
    expect([4, 5, 7].map(id => bench.lane(id))).toEqual(['lane-1', 'lane-2', 'lane-1'])
  })

  it('every stalled card in a lane holds it, a bodiless one for every queued card', () => {
    const bench = new Bench(1).admitWithoutBody(1).start(1).admit(2, 'src/b.ts').start(2).deniedMerge(1, NO_COUNT_LINE).deniedMerge(2, { kind: 'technical', reason: 'witness', detail: 'no witness.recorded' }).admit(3, 'src/c.ts')
    expect(launched(bench, 1)).toEqual([])
  })

  it('a stalled card that never started holds its lane for an overlapping card and frees it for another', () => {
    const bench = new Bench(1).admit(1, 'src/a.ts').deniedMerge(1, NO_COUNT_LINE).admit(2, 'src/a.ts').admit(3, 'src/b.ts')
    expect([bench.lane(2), bench.lane(3)]).toEqual(['lane-1', 'lane-1'])
    expect(launched(bench, 1)).toEqual([3])
  })
})
