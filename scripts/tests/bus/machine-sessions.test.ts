import type { DatabaseSync } from 'node:sqlite'
import type { MachineClaimant, MachineRecord } from '../../core/machine-sessions.js'
import type { AnswerRun } from '../../nodes/answer/duties/index.js'
import type { CardStart, CardStarter, LaunchDenial, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { SpawnSessionParams } from '../../ports/session.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CONTINUED, CARD_STOPPED } from '../../core/events.js'
import { MACHINE_DIR_VARIABLE, MACHINE_LIMIT_FILE, MACHINE_POLL_MS, machineDir, machineGate, machineHoldLine, MachineSessions, sessionLiveness } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { AnswerWithdrawn, claudeAnswerer } from '../../nodes/answer/answerer.js'
import { holdReason, launchCandidates, plannedStalls } from '../../nodes/launch/launch-candidates.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { claudeReviewer, ReviewTrees } from '../../nodes/review/reviewer.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const TS = '2026-11-06T10:00:00.000Z'
const HEAD = 'a'.repeat(40)
const BUS_A = '/home/.construct/bus.db'
const BUS_B = '/home/.construct/owner--repo/bus.db'
const ABOVE_THIS_PROCESS = process.pid + 1
const FIRST_PID = ABOVE_THIS_PROCESS + 1000
const LIMIT = 3
const CORES = 16
const DEFAULT_LIMIT = 4
const LANES = 3
const ENDED_PID = ABOVE_THIS_PROCESS + 4241
const CONTINUED_PID = ABOVE_THIS_PROCESS + 4242
const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-sessions-'))
  roots.push(root)
  return root
}

class MachineBench {
  readonly dir = path.join(scratch(), 'machine')
  readonly live = new Set<number>()
  readonly machine = new MachineSessions(this.dir, (record: MachineRecord) => record.pid === process.pid || this.live.has(record.pid), CORES, () => new Date(TS))

  limitedTo(sessions: unknown): this {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path.join(this.dir, MACHINE_LIMIT_FILE), JSON.stringify({ sessions }))
    return this
  }

  occupied(...claimants: MachineClaimant[]): this {
    claimants.forEach((claimant, at) => {
      this.live.add(FIRST_PID + at)
      expect(this.machine.claim(claimant, FIRST_PID + at).kind).toBe('claimed')
    })
    return this
  }

  full(): this {
    return this.limitedTo(LIMIT).occupied({ bus: BUS_A, role: 'launch', cardId: 1 }, { bus: BUS_A, role: 'answer', cardId: 2 }, { bus: BUS_B, role: 'review', cardId: 3 })
  }
}

function admittedBus(cardId: number): DatabaseSync {
  const db = openBus(path.join(scratch(), 'bus.db'))
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  reduce(db)
  return db
}

function candidatesIn(db: DatabaseSync, machine: MachineSessions): number[] {
  return launchCandidates(db, () => false, () => Date.parse(TS), () => {}, [], () => LANES, machine).map(candidate => candidate.cardId)
}

class CountingStarter implements CardStarter {
  starts: QueuedCard[] = []
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: process.pid, pgid: process.pid } }
  }

  stop(_card: StartedCard): void {}
}

async function runLaunchNode(machine: MachineSessions, cardId: number): Promise<{ starter: CountingStarter, again: () => Promise<void> }> {
  const made = mergeBench()
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const starter = new CountingStarter()
  const node = new LaunchNode({
    db: made.db,
    starter,
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: { commandLine: () => null, signalGroup: () => {} },
    resulted: () => true,
    handedOff: () => true,
    warned: () => true,
    atContextLine: () => false,
    committed: () => true,
    publish: () => {},
    disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    lanes: () => LANES,
    machine,
  })
  const again = async (): Promise<void> => {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
  await again()
  return {
    starter,
    again: async () => {
      made.clock.advance(MACHINE_POLL_MS * 2)
      made.tick()
      await again()
    },
  }
}

class ContinuingStarter implements CardStarter, SessionContinuer {
  continued = 0

  constructor(private readonly refusal: LaunchDenial | null = null) {}

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: ENDED_PID, pgid: ENDED_PID } }
  }

  stop(_card: StartedCard): void {}

  continueFrom(_card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    if (this.refusal !== null)
      return { kind: 'refused', denial: this.refusal }
    return { kind: 'started', card: { ...from, session: `${from.session}-c${this.continued}`, pid: CONTINUED_PID, pgid: CONTINUED_PID } }
  }
}

async function endedAtTheContextLine(machine: MachineSessions, cardId: number, starter: ContinuingStarter): Promise<{ node: LaunchNode, made: MergeBench }> {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const node = new LaunchNode({
    db: made.db,
    starter,
    continuer: starter,
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: { commandLine: () => null, signalGroup: () => {} },
    resulted: () => true,
    handedOff: () => true,
    warned: () => true,
    atContextLine: () => true,
    committed: () => true,
    publish: () => {},
    disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    lanes: () => LANES,
    machine,
  })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  made.tick()
  return { node, made }
}

function answerRequest(root: string) {
  const worktree = path.join(root, 'mc-2')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(worktree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' } })}\n`)
  return {
    lease: { taskKey: 'answer:2:1300', queue: 'answer' as const, cardId: 2, pr: 1300, head: HEAD, leaseGen: 1, actor: 'worker:answer:w' },
    source: { kind: 'changes' as const, findings: ['a finding'], events: [], decisions: [] },
    widened: null,
    card: { session: 'card-session', worktree, branch: 'feat/card-2' },
  }
}

function answererWith(root: string, runs: AnswerRun[], tools: Partial<Parameters<typeof claudeAnswerer>[1]>) {
  const heads = [HEAD, 'e'.repeat(40)]
  return claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => 'the card body',
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      runs.push(run)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: () => {},
    context: () => 1,
    contextWarn: () => 200_000,
    diff: () => '',
    ...tools,
  })
}

function reviewerWith(dir: string, spawned: SpawnSessionParams[], pause: () => Promise<void>, machine: MachineSessions) {
  const trees = new ReviewTrees('/repo', dir, { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: HEAD, status: [] }) })
  return claudeReviewer(trees, async (params) => {
    spawned.push(params)
    writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
    return 0
  }, () => {}, 50, () => null, {
    gate: machineGate(BUS_B, 'review', { machine, pause, say: () => {} }),
    keep: () => true,
    joinWorkers: () => 1,
    leaveWorkers: () => {},
  })
}

const reviewLease = { taskKey: `review:9:950:${HEAD}`, queue: 'review' as const, cardId: 9, pr: 950, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }

describe('the machine limit', () => {
  it('at the machine limit no launch answer or review session starts in any bus', async () => {
    const bench = new MachineBench().full()

    expect(candidatesIn(admittedBus(7), bench.machine)).toEqual([])
    expect(candidatesIn(admittedBus(8), bench.machine)).toEqual([])
    const { starter, again } = await runLaunchNode(bench.machine, 9)
    expect(starter.starts).toEqual([])

    const root = scratch()
    const answers: AnswerRun[] = []
    let answersWhilePaused = -1
    const answer = answererWith(root, answers, {
      machine: machineGate(BUS_B, 'answer', {
        machine: bench.machine,
        say: () => {},
        pause: async () => {
          answersWhilePaused = answers.length
          bench.live.delete(FIRST_PID)
        },
      }),
    })
    await answer(answerRequest(root))
    expect(answersWhilePaused).toBe(0)
    expect(answers).toHaveLength(1)

    bench.occupied({ bus: BUS_A, role: 'launch', cardId: 1 })
    const reviews: SpawnSessionParams[] = []
    let reviewsWhilePaused = -1
    const review = reviewerWith(scratch(), reviews, async () => {
      reviewsWhilePaused = reviews.length
      bench.live.delete(FIRST_PID)
    }, bench.machine)
    await review(reviewLease, fullReview('a fixed plan'))
    expect(reviewsWhilePaused).toBe(0)
    expect(reviews).toHaveLength(1)

    expect(candidatesIn(admittedBus(7), bench.machine)).toEqual([7])
    await again()
    expect(starter.starts.map(card => card.cardId)).toEqual([9])
  })

  it('one session ending frees a start in the other bus', () => {
    const bench = new MachineBench().full()
    expect(bench.machine.claim({ bus: BUS_B, role: 'launch', cardId: 5 }).kind).toBe('refused')
    bench.live.delete(FIRST_PID)
    expect(bench.machine.claim({ bus: BUS_B, role: 'launch', cardId: 5 }).kind).toBe('claimed')
  })

  it('with no value set the default limit holds', () => {
    const bench = new MachineBench().occupied({ bus: BUS_A, role: 'launch', cardId: 1 }, { bus: BUS_B, role: 'review', cardId: 2 })
    expect(bench.machine.limit()).toBe(DEFAULT_LIMIT)
    expect(bench.machine.held()).toBeNull()
    expect(bench.machine.free()).toBe(DEFAULT_LIMIT - 2)
    expect(bench.machine.claim({ bus: BUS_A, role: 'answer', cardId: 3 }).kind).toBe('claimed')
  })

  it.each([[0], [-1], [1.5], ['3'], [null]])('a limit of %j takes the default', (value) => {
    expect(new MachineBench().limitedTo(value).machine.limit()).toBe(DEFAULT_LIMIT)
  })

  it('a limit file that does not parse takes the default', () => {
    const bench = new MachineBench()
    mkdirSync(bench.dir, { recursive: true })
    writeFileSync(path.join(bench.dir, MACHINE_LIMIT_FILE), 'not json')
    expect(bench.machine.limit()).toBe(DEFAULT_LIMIT)
  })

  it('the same claimant holds one place, however often it claims', () => {
    const bench = new MachineBench().limitedTo(1)
    const claimant: MachineClaimant = { bus: BUS_A, role: 'launch', cardId: 1 }
    expect(bench.machine.claim(claimant).kind).toBe('claimed')
    expect(bench.machine.claim(claimant).kind).toBe('claimed')
    expect(bench.machine.live()).toBe(1)
  })

  it('a dead record stops counting', () => {
    const bench = new MachineBench().full()
    expect(bench.machine.live()).toBe(LIMIT)
    bench.live.delete(FIRST_PID + 1)
    expect(bench.machine.live()).toBe(LIMIT - 1)
    expect(bench.machine.held()).toBeNull()
  })

  it('the refusal and the board name the value and the count they read', () => {
    const bench = new MachineBench().full()
    const line = `machine session limit: ${LIMIT} of ${LIMIT} live sessions across every bus on this machine; the start waits until one ends`
    expect(bench.machine.claim({ bus: BUS_B, role: 'answer', cardId: 5 })).toEqual({ kind: 'refused', hold: { live: LIMIT, limit: LIMIT } })
    expect(machineHoldLine({ live: LIMIT, limit: LIMIT })).toBe(line)
    expect(holdReason({ kind: 'machine', live: LIMIT, limit: LIMIT })).toBe(line)
    expect(plannedStalls(admittedBus(7), Date.parse(TS), () => false, [], () => LANES, bench.machine).map(card => [card.cardId, holdReason(card.hold)])).toEqual([[7, line]])
  })

  it('the board names a held answer or review session of its own bus', () => {
    const bench = new MachineBench().full()
    const db = openBus(path.join(scratch(), 'bus.db'))
    bench.machine.waits({ bus: db.location()!, role: 'answer', cardId: 5 })
    bench.machine.waits({ bus: BUS_B, role: 'review', cardId: 6 })
    expect(plannedStalls(db, Date.parse(TS), () => false, [], () => LANES, bench.machine).map(card => card.cardId)).toEqual([5])
  })

  it('a running session is never ended by the limit, even when the value drops below the count', () => {
    const bench = new MachineBench().full().limitedTo(1)
    expect(bench.machine.live()).toBe(LIMIT)
    expect(bench.machine.claim({ bus: BUS_A, role: 'launch', cardId: 1 }, FIRST_PID).kind).toBe('claimed')
    expect(bench.machine.live()).toBe(LIMIT)
  })

  it('a registry that cannot be written lets the start go', () => {
    const blocked = path.join(scratch(), 'a-file')
    writeFileSync(blocked, '')
    expect(new MachineSessions(path.join(blocked, 'below'), () => false, CORES).claim({ bus: BUS_A, role: 'launch', cardId: 1 }).kind).toBe('claimed')
  })

  it('an answer withdrawn while it waits never spawns and throws AnswerWithdrawn', async () => {
    const bench = new MachineBench().full()
    const root = scratch()
    const answers: AnswerRun[] = []
    const answer = answererWith(root, answers, {
      held: () => false,
      machine: machineGate(BUS_B, 'answer', { machine: bench.machine, say: () => {}, pause: async () => {} }),
    })
    await expect(answer(answerRequest(root))).rejects.toBeInstanceOf(AnswerWithdrawn)
    expect(answers).toEqual([])
    expect(bench.machine.waiting(BUS_B)).toEqual([])
  })

  it('the wait is told once while the reading stays the same, and goes on when the check of the task fails', async () => {
    const bench = new MachineBench().full()
    const said: string[] = []
    let pauses = 0
    const gate = machineGate(BUS_A, 'answer', {
      machine: bench.machine,
      say: line => said.push(line),
      pause: async () => {
        pauses += 1
        if (pauses === 2)
          bench.live.delete(FIRST_PID)
      },
    })
    expect(await gate.start(5, () => {
      throw new Error('database is locked')
    })).toBe(true)
    expect(said.filter(line => line.startsWith('#5 answer: machine session limit'))).toHaveLength(1)
    expect(said.filter(line => line.includes('database is locked'))).toHaveLength(2)
  })

  it('a started session is live while its process group leader exists, and a claim while its own pid does', () => {
    const live = sessionLiveness(pid => [20, 30].includes(pid))
    const started = { bus: BUS_A, role: 'launch' as const, cardId: 1, pid: 99, session: 's-1' }
    expect(live({ ...started, pgid: 20 })).toBe(true)
    expect(live({ ...started, pgid: 21 })).toBe(false)
    expect(live({ bus: BUS_A, role: 'launch', cardId: 1, pid: 30 })).toBe(true)
    expect(live({ bus: BUS_A, role: 'launch', cardId: 1, pid: 31 })).toBe(false)
  })

  it('every bus on the machine reads one directory, and the variable moves it', () => {
    expect(machineDir({}, '/home/x')).toBe('/home/x/.construct/machine')
    expect(machineDir({ [MACHINE_DIR_VARIABLE]: '/moved' }, '/home/x')).toBe('/moved')
  })
})

describe('a session that continues from one that ended', () => {
  it('at the machine limit it waits unstopped, and continues under its own process when a place frees', async () => {
    const bench = new MachineBench()
    const starter = new ContinuingStarter()
    const { node, made } = await endedAtTheContextLine(bench.machine, 1701, starter)
    bench.full()

    expect(node.stopOverdue()).toEqual([])
    expect(starter.continued).toBe(0)
    expect(eventsOf(made.db, CARD_CONTINUED)).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])

    bench.live.delete(FIRST_PID)
    bench.live.add(CONTINUED_PID)
    expect(node.stopOverdue()).toEqual([])
    expect(starter.continued).toBe(1)
    expect(eventsOf(made.db, CARD_CONTINUED)).toMatchObject([{ session: 's-1701-c1', continuation: 1, from: 's-1701' }])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])

    expect(bench.machine.live()).toBe(LIMIT)
    bench.live.delete(CONTINUED_PID)
    expect(bench.machine.live()).toBe(LIMIT - 1)
  })

  it('a continuation that is refused stops the card and gives its machine place back', async () => {
    const bench = new MachineBench()
    const starter = new ContinuingStarter({ kind: 'technical', reason: 'start_failed', detail: 'the tree holds changes no session named' })
    const { node, made } = await endedAtTheContextLine(bench.machine, 1702, starter)
    bench.limitedTo(LIMIT).occupied({ bus: BUS_A, role: 'launch', cardId: 1 }, { bus: BUS_B, role: 'answer', cardId: 2 })

    expect(node.stopOverdue()).toEqual([1702])

    expect(starter.continued).toBe(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', detail: expect.stringContaining('continuation-refused') })])
    expect(eventsOf(made.db, CARD_CONTINUED)).toEqual([])
    expect(bench.machine.live()).toBe(LIMIT - 1)
    expect(bench.machine.held()).toBeNull()
  })
})
