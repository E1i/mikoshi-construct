import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { CardStart, CardStarter, LaunchOutcome, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { StarterPlaces, StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { IsolationReader } from '../../ports/isolation.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runIntake } from '../../../src/commands/intake/index.js'
import { shiftGateOf } from '../../../src/manifest.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, CARD_STOPPED, GHOST_ROW } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { parkingLane } from '../../intake/admissions.js'
import { ARCHIVE_DIR } from '../../intake/card-archive.js'
import { importJournal, importJournalFile, legacyEventOf } from '../../intake/import.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from '../../intake/intake.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { launchableCard, launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { cardCommand, killQuietly, pathTokens, psPgid, ShiftCardStarter, spawnDetached } from '../../nodes/launch/launch-starter.js'
import { withdrawLegacyLaunchTasks } from '../../nodes/launch/launch-withdraw.js'
import { busStarterPorts, LAUNCH_LIMIT_MINUTES, LaunchNode } from '../../nodes/launch/launch-worker.js'
import { taskConflicts } from '../../nodes/launch/overlap.js'
import { renderPrompt } from '../../nodes/launch/prompt.js'
import { recordDecision } from '../../policy/decisions.js'
import { sessionEnv } from '../../ports/session.js'
import { shiftSettings } from '../../ports/shift-settings.js'
import { recordHeartbeat } from '../../supervisor/heartbeat.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { busLaunches } from '../../supervisor/workers.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { waitFor } from '../wait-for.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const ARRIVAL_GUARD_MS = 25_000
const UNDER_FULL_SUITE_LOAD_MS = 5 * 60_000
const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const admission = (cardId: number): string => `admission-${cardId}`
const launch = (cardId: number, generation = admission(cardId)): string => taskKey({ queue: 'launch', cardId, generation })

class FakeStarter implements CardStarter {
  starts: QueuedCard[] = []
  stops: StartedCard[] = []
  constructor(private readonly answer: (card: QueuedCard) => CardStart = card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } })) {}
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return this.answer(card)
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }
}

function launchBench(starter: CardStarter = new FakeStarter(), intake?: Parameters<typeof mergeBench>[0]) {
  const bench = mergeBench(intake)
  const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, isolation: sandboxed })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    admit: (cardId: number, lane: string, depends: number[] = [], contour = 'cheap'): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour, depends, admission: admission(cardId) }, legacy: false })
    },
    admitTouching: (cardId: number, lane: string, touches: string[]): void => {
      const text = parkingFileText({ card: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches, continue: 'stop', who: 'shift', body: 'Do the card.' })
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: admission(cardId), text }, legacy: false })
    },
    ghostRow: (cardId: number, id: string, state: string): void => {
      appendEvent(bench.db, { ts: ts(), type: GHOST_ROW, actor: 'worker:ladder:session-1', cardId, pr: null, head: null, dedupeKey: `${GHOST_ROW}:${id}:${state}`, payload: { id, state, row: `| ${id} | ${state} |` }, legacy: false })
    },
    started: (cardId: number): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: 'earlier' }, legacy: false })
    },
    mergedPr: (pr: number): void => {
      bench.gitHub.open({ number: pr })
      bench.tick()
      bench.gitHub.close(pr, true)
      bench.tick()
    },
    leaseLaunch: (actor = 'worker:launch:worker-1'): Lease | null => leaseNext(bench.db, ts(), 'launch', actor),
    launch: (lease: Lease): LaunchOutcome => executor.launch(lease),
  }
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-launch-'))
  roots.push(root)
  return root
}

function stubClaude(root: string): { command: string, argsFile: string } {
  const argsFile = path.join(root, 'claude-args.txt')
  const command = path.join(root, 'claude-stub.sh')
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$*" "card=$CONSTRUCT_CARD" > '${argsFile}'\ncat > /dev/null\nexec sleep 30\n`)
  chmodSync(command, 0o755)
  return { command, argsFile }
}

async function written(file: string): Promise<string> {
  await waitFor(() => existsSync(file), () => `the stub to write ${file}`, ARRIVAL_GUARD_MS)
  return readFileSync(file, 'utf8')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForExit(pid: number): Promise<void> {
  await waitFor(() => !alive(pid), () => `process ${pid} to exit`, ARRIVAL_GUARD_MS)
}

function realStarter(root: string, shiftClaude: string | undefined, cardId: number, overrides: Partial<StarterPorts> = {}, places: Partial<StarterPlaces> = {}): ShiftCardStarter {
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
  writeFileSync(path.join(parking, 'lane-x', `${cardId}.md`), parkingFileText({ card: `#${cardId} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
  const worktree = path.join(root, `mc-${cardId}`)
  mkdirSync(worktree)
  const env: NodeJS.ProcessEnv = { ...process.env, SHIFT_CLAUDE: shiftClaude }
  if (shiftClaude === undefined)
    delete env.SHIFT_CLAUDE
  const ports: StarterPorts = {
    read: (read) => {
      const file = path.join(parking, 'lane-x', `${read}.md`)
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    },
    cut: () => worktree,
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      const pid = spawnDetached(run)
      groups.push(pid)
      return pid
    },
    pgidOf: psPgid,
    kill: killQuietly,
    uuid: () => `session-${cardId}`,
    envOf: id => sessionEnv(env, id),
    prompt: (task, at) => renderPrompt('card {{card}} in {{worktree}}, report {{report}}\n\n', task, at),
    changedPaths: () => [],
    readReport: () => null,
    cardSessions: () => [],
    readTranscript: () => null,
    treeFile: () => null,
    ...overrides,
  }
  return new ShiftCardStarter({ launchDir: path.join(root, 'launch'), claude: shiftClaude ?? 'claude', treePr: 'true', ...places }, ports)
}

describe('the launch queue', () => {
  it('the shift starter returns as its input the prompt it pipes to the card session', () => {
    let piped: string | undefined
    const starter = realStarter(tempRoot(), undefined, 905, { spawnDetached: (run) => {
      piped = run.input
      return 4242
    }, pgidOf: () => 4242 })

    const start = starter.start({ cardId: 905, lane: 'lane-x' })
    expect(start.kind).toBe('started')
    expect(piped).toContain('card #905')
    expect((start as Extract<CardStart, { kind: 'started' }>).card.input).toEqual({ prompt: piped })
  })

  it('a queued card whose depends are merged and whose lane is free enters launch', () => {
    const bench = launchBench()
    bench.mergedPr(800)
    bench.admit(901, 'lane-a', [900])
    bench.admit(902, 'lane-b')
    bench.tick()

    expect(taskState(bench.db, launch(901))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(taskState(bench.db, launch(902))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.leaseLaunch()).toMatchObject({ taskKey: launch(901), queue: 'launch', cardId: 901, pr: null, head: null, leaseGen: 1 })
    bench.close()
  })

  it('a waiting card becomes a launch candidate when its last dependency merges', () => {
    const bench = launchBench()
    bench.admit(900, 'lane-a')
    bench.started(900)
    bench.admit(901, 'lane-b')
    bench.started(901)
    const root = tempRoot()
    const parking = path.join(root, 'parking')
    mkdirSync(parking)
    const file = path.join(parking, '1124.md')
    writeFileSync(file, parkingFileText({ card: '#1124 waiting-card [implement/netwatch/S/cheap/auto] · depends #900 #901 · blocks —', branch: 'feat/waiting-card', touches: ['scripts/nodes/launch/launch-candidates.ts'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
    const admitted = runAdmit({ file, dir: process.cwd(), dryRun: false, autoConfirm: true, parkingRoot: parking, contourMap: path.join(root, 'contour-map.json'), decisions: path.join(root, 'owner-decisions.md'), events: busCardEvents(bench.db), cardStates: () => busHeldCards(bench.db), admissions: busCardAdmissions(bench.db) })
    expect(admitted.status).toBe('admitted')
    expect(eventsOf(bench.db, 'card.waiting')).toEqual([{ depends: [900, 901] }])
    const candidate = (): boolean => launchCandidates(bench.db, () => false).some(each => each.cardId === 1124)
    const launchQueued = (): boolean => bench.db.prepare(`SELECT 1 FROM tasks WHERE queue = 'launch' AND card_id = 1124 AND state = 'queued'`).get() !== undefined
    bench.tick()
    expect([candidate(), launchQueued()]).toEqual([false, false])

    bench.mergedPr(800)
    expect([candidate(), launchQueued()]).toEqual([false, false])

    bench.mergedPr(801)
    expect(launchQueued()).toBe(true)
    bench.close()
  })

  it('a card with an unmerged depends or a busy lane does not enter launch', () => {
    const bench = launchBench()
    bench.gitHub.open({ number: 810 })
    bench.admit(910, 'lane-a')
    bench.started(910)
    bench.admit(911, 'lane-a')
    bench.admit(912, 'lane-b', [910])
    bench.admit(913, 'lane-c')
    bench.admit(914, 'lane-c')
    bench.tick()

    expect(taskState(bench.db, launch(911))).toBeUndefined()
    expect(taskState(bench.db, launch(912))).toBeUndefined()
    expect(taskState(bench.db, launch(913))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(914))).toBeUndefined()

    bench.gitHub.close(810, true)
    bench.tick()
    expect(taskState(bench.db, launch(911))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(912))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a card.admitted of a who: window card enqueues no launch task', () => {
    const bench = launchBench()
    const admitAs = (cardId: number, lane: string, who: string): void => {
      const text = parkingFileText({ card: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches: [`scripts/card-${cardId}.ts`], continue: 'stop', who, body: 'Do the card.' })
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: admission(cardId), text }, legacy: false })
    }
    admitAs(915, 'lane-a', 'window')
    admitAs(916, 'lane-b', 'shift')
    bench.tick()

    expect(taskState(bench.db, launch(915))).toBeUndefined()
    expect(launchableCard(bench.db, 915)).toBeNull()
    expect(launchCandidates(bench.db, () => false).map(each => each.cardId)).not.toContain(915)
    expect(taskState(bench.db, launch(916))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('the launch node does not take two cards of different lanes with overlapping touches', () => {
    const bench = launchBench()
    bench.admitTouching(920, 'lane-a', ['scripts/core/queue.ts', '.changeset/**'])
    bench.admitTouching(921, 'lane-b', ['scripts/core/**', '.changeset/**'])
    bench.admitTouching(922, 'lane-c', ['scripts/core/lease.ts', '.changeset/**'])
    bench.admitTouching(923, 'lane-d', ['scripts/window/**'])
    bench.started(923)
    bench.admitTouching(924, 'lane-e', ['scripts/window/watch.ts'])
    bench.admitTouching(925, 'lane-f', ['scripts/ci/update-branch.ts', '.changeset/**'])
    bench.tick()

    expect(taskState(bench.db, launch(920))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(921))).toBeUndefined()
    expect(taskState(bench.db, launch(922))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(924))).toBeUndefined()
    expect(taskState(bench.db, launch(925))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('launch never starts two cards whose touches overlap', () => {
    const bench = launchBench()
    bench.admitTouching(1190, 'lane-a', ['src/card/risk.ts', 'tests/intake-risk.test.ts'])
    bench.admitTouching(1191, 'lane-b', ['src/card/**'])
    bench.admitTouching(1192, 'lane-c', ['src/commands/intake/check.ts'])
    bench.tick()

    expect(taskState(bench.db, launch(1190))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(1191))).toBeUndefined()
    expect(taskState(bench.db, launch(1192))).toMatchObject({ state: 'queued' })
    bench.started(1190)
    bench.tick()
    expect(taskState(bench.db, launch(1191))).toBeUndefined()
    bench.close()
  })

  it('a dropped card that had started holds neither its lane nor its touches', () => {
    const bench = launchBench()
    bench.admitTouching(889, 'lane-a', ['scripts/core/queue.ts', 'scripts/nodes/answer/answer-worker.ts'])
    bench.started(889)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_MOVED, actor: 'policy', cardId: 889, pr: null, head: null, dedupeKey: `${CARD_MOVED}:889:dropped`, payload: { lane: 'dropped' }, legacy: false })
    bench.admitTouching(1112, 'lane-b', ['scripts/nodes/answer/answer-worker.ts', '.changeset/**'])
    bench.admitTouching(1113, 'lane-a', ['scripts/window/watch.ts'])
    bench.tick()

    expect(taskState(bench.db, launch(1112))).toMatchObject({ state: 'queued' })
    expect(taskState(bench.db, launch(1113))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a dropped card is no candidate and holds no touches', () => {
    const bench = launchBench()
    const drop = (cardId: number): void => {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${cardId}`, payload: { lane: 'dropped' }, legacy: false })
    }
    bench.admitTouching(1170, 'lane-a', ['scripts/core/queue.ts'])
    bench.started(1170)
    drop(1170)
    bench.admitTouching(1171, 'lane-c', ['scripts/core/lease.ts'])
    drop(1171)
    bench.admitTouching(1172, 'lane-a', ['scripts/core/queue.ts', '.changeset/**'])
    bench.tick()

    expect(taskState(bench.db, launch(1170))).toBeUndefined()
    expect(taskState(bench.db, launch(1171))).toBeUndefined()
    expect(taskState(bench.db, launch(1172))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a card started, dropped and admitted again is a launch candidate and its old run holds neither lane nor touches', () => {
    const bench = launchBench()
    const touches = ['scripts/nodes/launch/launch-candidates.ts']
    const readmit = (cardId: number, lane: string, cardTouches: string[], depends: number[]): void => {
      const text = parkingFileText({ card: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches: cardTouches, continue: 'stop', who: 'shift', body: 'Do the card.' })
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:again`, payload: { lane, decision: 'auto', contour: 'cheap', depends, admission: `${admission(cardId)}-again`, text }, legacy: false })
    }
    const drop = (cardId: number): void => {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${cardId}`, payload: { lane: 'dropped' }, legacy: false })
    }
    bench.gitHub.open({ number: 1312 })
    bench.admitTouching(1213, 'lane-a', touches)
    bench.started(1213)
    drop(1213)
    readmit(1213, 'lane-a', touches, [1312])
    bench.admitTouching(1219, 'lane-a', touches)
    bench.tick()
    expect(taskState(bench.db, launch(1219))).toMatchObject({ state: 'queued' })

    bench.admitTouching(1214, 'lane-b', ['scripts/window/watch.ts'])
    bench.started(1214)
    drop(1214)
    readmit(1214, 'lane-b', ['scripts/window/watch.ts'], [])
    bench.tick()
    expect(taskState(bench.db, launch(1214, `${admission(1214)}-again`))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a dropped card whose dependency just merged is no launch candidate', () => {
    const bench = launchBench()
    bench.gitHub.open({ number: 1026 })
    bench.admit(1132, 'lane-a', [1126])
    bench.tick()
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_MOVED, actor: 'policy', cardId: 1132, pr: null, head: null, dedupeKey: `${CARD_MOVED}:1132:dropped`, payload: { lane: 'dropped' }, legacy: false })
    bench.tick()

    bench.gitHub.close(1026, true)
    bench.tick()
    expect(taskState(bench.db, launch(1132))).toBeUndefined()
    bench.close()
  })

  it('in parallel the cards intake made from card A of probe 1075 lay out over lanes and launch takes no two with overlapping touches', () => {
    const bench = launchBench()
    const root = tempRoot()
    const parking = path.join(root, 'parking')
    const slice = (name: string, touches: string[]): Record<string, unknown> => ({ name, kind: 'implement', milestone: 'operator', size: 'M', contour: 'cheap', decision: 'auto', who: 'shift', touches, task: `The ${name} part of card A.`, witnesses: ['`pnpm run quality` is green'] })
    const draft = path.join(root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [
      slice('owner-loop-r1', ['scripts/ladder/hash.ts', 'scripts/ladder/approval.ts', 'scripts/tests/ghosts/hash.test.ts', 'scripts/core/queue.ts', 'scripts/tests/bus/merge-queue.test.ts', 'scripts/construct/check-acceptance.mjs', 'templates/ai/claude/scripts/construct/check-acceptance.mjs', 'scripts/ladder/launch.ts', '.changeset/**']),
      slice('owner-loop-r3', ['scripts/core/inbox.ts', 'scripts/policy/round-limit-decision.ts', 'scripts/nodes/update/update-done.ts', 'scripts/nodes/merge/merge-executor.ts', 'scripts/nodes/answer/answerer.ts', 'scripts/core/lease.ts', 'scripts/window/watch.ts', 'scripts/nodes/launch/launch-worker.ts', '.changeset/**']),
      slice('owner-loop-item-3', ['scripts/core/queue.ts', 'scripts/policy/round-limit-decision.ts', '.changeset/**']),
    ] }))
    const refuse = (): never => {
      throw new Error('a mode request uses no tool')
    }
    requestFromWindow(bench.db, new Date().toISOString(), 'test', { kind: 'mode', mode: 'parallel' })
    new WindowRequests(bench.db, () => new Date(), { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }).run()
    const result = runIntake({ draft, taken: '-', readStdin: () => '1075', parking, parkingRoot: parking, dir: process.cwd(), dryRun: false, autoConfirm: true, events: busCardEvents(bench.db) })
    expect(result.status).toBe('written')
    const cards = result.status === 'written' ? result.cards : []
    expect(existsSync(parking)).toBe(false)
    bench.tick()
    const bodies = cards.map(card => bench.db.prepare('SELECT text, lane FROM card_bodies WHERE card_id = ?').get(card.id) as { text: string, lane: string })
    const tasks = bodies.map(({ text }, index) => {
      const parsed = parseParkingFile(cards[index]!.file, text)
      return parsed.kind === 'parked' ? parsed.parked.task : null
    })
    const lanes = bodies.map(body => body.lane)
    expect(lanes.every(lane => /^lane-\d{2}$/.test(lane))).toBe(true)
    expect(new Set(lanes).size).toBeGreaterThan(1)
    expect(tasks.every(task => task !== null)).toBe(true)

    const queued = new Set((bench.db.prepare(`SELECT card_id FROM tasks WHERE queue = 'launch'`).all() as { card_id: number }[]).map(row => row.card_id))
    const launched = tasks.flatMap(task => task !== null && queued.has(task.card.id) ? [task] : [])
    expect(launched.length).toBeGreaterThan(1)
    expect(taskConflicts(launched)).toEqual([])
    const held = tasks.flatMap((task, index) => task !== null && !queued.has(task.card.id) ? [{ task, lane: lanes[index] }] : [])
    expect(held.length).toBeGreaterThan(0)
    for (const { task, lane } of held) {
      const reason = launched.some(other => taskConflicts([other, task]).length > 0) || launched.some(other => lanes[tasks.indexOf(other)] === lane) || task.card.depends.length > 0
      expect(reason).toBe(true)
    }
    bench.close()
  }, UNDER_FULL_SUITE_LOAD_MS)

  it('a card whose pull request is merged or that a legacy shift started is not offered for launch', () => {
    const bench = launchBench()
    bench.mergedPr(815)
    bench.admit(915, 'lane-a')
    bench.admit(916, 'lane-b')
    bench.admit(917, 'lane-c')
    bench.admit(918, 'lane-d')
    importJournal(bench.db, [
      JSON.stringify({ event: 'path', task: '916', path: 'cheap', started: '2026-10-01T05:00:00Z', branch: 'feat/card-916', ts: '2026-10-01T05:00:00Z' }),
      JSON.stringify({ event: 'merge', task: '917', pr: 817, by: 'eli', commit: 'abc', ts: '2026-10-01T06:00:00Z' }),
    ].join('\n'))
    bench.tick()

    expect(taskState(bench.db, launch(915))).toBeUndefined()
    expect(taskState(bench.db, launch(916))).toBeUndefined()
    expect(taskState(bench.db, launch(917))).toBeUndefined()
    expect(taskState(bench.db, launch(918))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a card with an open pull request does not join the launch queue the #1094 case, PR #935', () => {
    const bench = launchBench()
    bench.gitHub.open({ number: 935, body: '#1094 ladder-risks-named [implement/netwatch/S/cheap/auto] · depends — · blocks —' })
    bench.tick()
    bench.admit(1094, 'lane-a')
    bench.admit(1095, 'lane-b')
    bench.tick()

    expect(taskState(bench.db, launch(1094))).toBeUndefined()
    expect(taskState(bench.db, launch(1095))).toMatchObject({ state: 'queued' })

    bench.gitHub.close(935, false)
    bench.tick()
    expect(taskState(bench.db, launch(1094))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  function launchedWithPr(bench: ReturnType<typeof launchBench>, cardId: number, pr: number): void {
    bench.admit(cardId, 'lane-a')
    bench.tick()
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: launch(cardId) })
    bench.gitHub.open({ number: pr, body: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —` })
    bench.tick()
  }

  function readmitted(bench: ReturnType<typeof launchBench>, cardId: number): void {
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:again`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `again-${cardId}` }, legacy: false })
    bench.tick()
  }

  it('a card whose pull request closed without merge is launched again after its next admission', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1290, 1087)
    bench.gitHub.close(1087, false)
    bench.tick()
    expect(launchCandidates(bench.db)).toEqual([])

    readmitted(bench, 1290)
    expect(taskState(bench.db, launch(1290, 'again-1290'))).toMatchObject({ state: 'queued' })
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: launch(1290, 'again-1290') })
    bench.close()
  })

  it('a card whose pull request is still open is not launched again by a new admission', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1229, 1064)

    readmitted(bench, 1229)
    expect(launchCandidates(bench.db)).toEqual([])
    expect(taskState(bench.db, launch(1229, 'again-1229'))).toBeUndefined()
    bench.close()
  })

  it('a card whose pull request closed without merge frees its lane for another card', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1277, 1110)
    bench.admit(1278, 'lane-a')
    bench.tick()
    expect(taskState(bench.db, launch(1278))).toBeUndefined()

    bench.gitHub.close(1110, false)
    bench.tick()
    expect(taskState(bench.db, launch(1278))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  function reopened(bench: ReturnType<typeof launchBench>, cardId: number, pr: number): void {
    bench.gitHub.open({ number: pr, head: 'b'.repeat(40), body: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —` })
    bench.tick()
  }

  function keepsItsRun(bench: ReturnType<typeof launchBench>, cardId: number, neighbour: number): void {
    bench.admit(neighbour, 'lane-a')
    bench.tick()
    expect(taskState(bench.db, launch(neighbour))).toBeUndefined()
    readmitted(bench, cardId)
    expect(launchableCard(bench.db, cardId)).toBeNull()
    expect(taskState(bench.db, launch(cardId, `again-${cardId}`))).toBeUndefined()
  }

  it('a card whose pull request closed without merge and then reopened and merged keeps its run', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1320, 1120)
    bench.gitHub.close(1120, false)
    bench.tick()
    reopened(bench, 1320, 1120)
    bench.gitHub.close(1120, true)
    bench.tick()
    keepsItsRun(bench, 1320, 1321)
    bench.close()
  })

  it('a card with two pull requests keeps its run while one is open after the other closed without merge', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1322, 1122)
    bench.gitHub.open({ number: 1123, head: 'c'.repeat(40), body: `#1322 card-1322 [implement/netwatch/S/cheap/auto] · depends — · blocks —` })
    bench.tick()
    bench.gitHub.close(1122, false)
    bench.tick()
    keepsItsRun(bench, 1322, 1323)
    bench.close()
  })

  it('a card whose pull request is reopened after a close without merge keeps its run', () => {
    const bench = launchBench()
    launchedWithPr(bench, 1324, 1124)
    bench.gitHub.close(1124, false)
    bench.tick()
    reopened(bench, 1324, 1124)
    keepsItsRun(bench, 1324, 1325)
    bench.close()
  })

  function stoppedInTree(bench: ReturnType<typeof launchBench>, cardId: number, tree: string, contour = 'cheap'): void {
    const ts = bench.clock.now().toISOString()
    bench.admit(cardId, 'lane-a', [], contour)
    appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: 'earlier', worktree: tree }, legacy: false })
    appendEvent(bench.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'fault', detail: 'session-end' }, legacy: false })
    appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:again`, payload: { lane: 'lane-a', decision: 'auto', contour, depends: [], admission: `again-${cardId}` }, legacy: false })
  }

  it('a card with a live tree mc-N does not join the launch queue', () => {
    const bench = launchBench()
    const tree = path.join(tempRoot(), 'mc-1096')
    mkdirSync(tree)
    stoppedInTree(bench, 1096, tree)
    recordHeartbeat(bench.db, new Date().toISOString(), { card: 1096, pr: null, head: null, step: 'launch', session: 'earlier', lease: null })
    bench.tick()

    expect(taskState(bench.db, launch(1096, 'again-1096'))).toBeUndefined()

    rmSync(tree, { recursive: true })
    bench.tick()
    expect(taskState(bench.db, launch(1096, 'again-1096'))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a stopped cheap card with a tree and no live heartbeat becomes a launch candidate naming that tree', () => {
    const bench = launchBench()
    const tree = path.join(tempRoot(), 'mc-1160')
    mkdirSync(tree)
    stoppedInTree(bench, 1160, tree)
    const beatAt = Date.parse('2026-10-01T00:00:00.000Z')
    recordHeartbeat(bench.db, new Date(beatAt).toISOString(), { card: 1160, pr: null, head: null, step: 'launch', session: 'earlier', lease: null })

    expect(launchCandidates(bench.db, existsSync, () => beatAt + SILENT_MS)).toEqual([])
    expect(launchCandidates(bench.db, existsSync, () => beatAt + SILENT_MS + 1)).toEqual([{ cardId: 1160, generation: 'again-1160', continueIn: tree }])

    bench.tick()
    expect(taskState(bench.db, launch(1160, 'again-1160'))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a stopped ladder card with a standing tree is launched afresh, not continued in that tree', () => {
    const bench = launchBench()
    const tree = path.join(tempRoot(), 'mc-1161')
    mkdirSync(tree)
    stoppedInTree(bench, 1161, tree, 'ladder')

    expect(launchCandidates(bench.db, existsSync, () => Date.parse('2026-10-01T00:00:00.000Z'))).toEqual([{ cardId: 1161, generation: 'again-1161' }])
    bench.close()
  })

  function heldTreeStarter(cardId: number, changed: string[], report: string | null) {
    const root = tempRoot()
    const cardText = parkingFileText({ card: `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches: ['scripts/bus/**'], continue: 'auto', who: 'shift', body: 'Do the card.' })
    const launchDir = path.join(root, 'launch')
    const cuts: string[] = []
    const spawned: string[] = []
    const ports: StarterPorts = {
      read: read => read === cardId ? cardText : null,
      cut: (task) => {
        cuts.push(task.branch)
        return path.join(root, 'fresh')
      },
      base: () => 'n'.repeat(40),
      spawnDetached: (run) => {
        spawned.push(run.cwd)
        return 5151
      },
      pgidOf: () => 5151,
      kill: () => {},
      uuid: () => `sess-${cardId}`,
      envOf: () => ({}),
      prompt: task => task.body,
      changedPaths: () => changed,
      readReport: file => file === path.join(launchDir, `report-${cardId}.md`) ? report : null,
      cardSessions: () => [],
      readTranscript: () => null,
      treeFile: () => null,
    }
    return { starter: new ShiftCardStarter({ launchDir, claude: 'claude', treePr: 'true' }, ports), cuts, spawned }
  }

  it('a continueIn candidate is started in its named tree, never by task:start', () => {
    const held = heldTreeStarter(1172, ['notes.md'], 'result: stopped at a boundary\nnotes.md holds the half-written plan\n')
    const bench = launchBench(held.starter)
    const tree = path.join(tempRoot(), 'mc-1172')
    mkdirSync(tree)
    stoppedInTree(bench, 1172, tree)
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)

    expect(outcome).toMatchObject({ kind: 'started', card: { worktree: tree, session: 'sess-1172' } })
    expect(held.cuts).toEqual([])
    expect(held.spawned).toEqual([tree])
    expect(eventsOf(bench.db, CARD_STARTED).at(-1)).toMatchObject({ worktree: tree })
    bench.close()
  })

  it('a held tree with an unnamed changed path is stopped, not continued', () => {
    const held = heldTreeStarter(1136, ['notes.md', 'scripts/core/report.ts'], 'result: stopped at a boundary\nnotes.md holds the half-written plan\n')
    const bench = launchBench(held.starter)
    const tree = path.join(tempRoot(), 'mc-1136')
    mkdirSync(tree)
    stoppedInTree(bench, 1136, tree)
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'held_tree_changed', paths: ['scripts/core/report.ts'] }, next: 'withdrawn' })
    expect(held.cuts).toEqual([])
    expect(held.spawned).toEqual([])
    expect(eventsOf(bench.db, CARD_STOPPED).at(-1)).toMatchObject({ reason: 'fault', paths: ['scripts/core/report.ts'] })
    bench.tick()
    expect(launchCandidates(bench.db)).toEqual([])
    bench.close()
  })

  it('a changed path is named only as a whole path, never inside a longer one', () => {
    const held = heldTreeStarter(1137, ['report.ts', 'a.ts'], 'result: stopped at a boundary\nleft `scripts/core/report.ts` and data.ts as they were\n')
    const bench = launchBench(held.starter)
    const tree = path.join(tempRoot(), 'mc-1137')
    mkdirSync(tree)
    stoppedInTree(bench, 1137, tree)
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'denied', denial: { reason: 'held_tree_changed', paths: ['report.ts', 'a.ts'] } })
    expect(held.spawned).toEqual([])
    expect([...pathTokens('see `scripts/core/report.ts`, (notes.md). and "a b.ts":')]).toEqual(['see', 'scripts/core/report.ts', 'notes.md', 'and', 'a', 'b.ts'])
    bench.close()
  })

  it('a legacy card.started naming a live tree mc-N does not hold a card out of the launch queue', () => {
    const bench = launchBench()
    const tree = path.join(tempRoot(), 'mc-1097')
    mkdirSync(tree)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:legacy', cardId: 1097, pr: null, head: null, dedupeKey: `${CARD_STARTED}:legacy-1097`, payload: { session: 'legacy', worktree: tree }, legacy: true })
    bench.admit(1097, 'lane-a')
    bench.tick()

    expect(taskState(bench.db, launch(1097))).toMatchObject({ state: 'queued' })
    bench.close()
  })

  it('a launch is spawned detached as its own process group leader and records card.started', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, stub.command, 920))
    bench.admit(920, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome.kind).toBe('started')
    const card = (outcome as Extract<LaunchOutcome, { kind: 'started' }>).card
    await written(stub.argsFile)
    expect(card.pid).not.toBe(process.pid)
    expect(psPgid(card.pid)).toBe(card.pid)
    expect(card.pgid).toBe(card.pid)
    expect(psPgid(card.pid)).not.toBe(psPgid(process.pid))
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'session-920', worktree: path.join(root, 'mc-920'), branch: 'feat/card-920', base: 'b'.repeat(40), pid: card.pid, pgid: card.pid, contour: 'cheap', isolation: 'full', isolationGaps: [] }])
    expect(taskState(bench.db, launch(920))).toMatchObject({ state: 'completed' })
    bench.tick()
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a card with no file in the parking is launched from its bus body', () => {
    const root = tempRoot()
    let piped: string | undefined
    let bodyOf: (cardId: number) => string | null = () => null
    const starter = realStarter(root, undefined, 930, { read: cardId => bodyOf(cardId), spawnDetached: (run) => {
      piped = run.input
      return 4242
    }, pgidOf: () => 4242 })
    rmSync(path.join(root, 'parking', 'lane-x', '930.md'))
    const bench = launchBench(starter)
    bodyOf = cardId => cardBodyText(bench.db, cardId)
    const text = parkingFileText({ card: '#930 bus-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/bus-card', touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card from the bus.' })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: 930, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:930`, payload: { lane: 'lane-x', decision: 'auto', contour: 'cheap', depends: [], admission: admission(930), text, textSha: textSha(text) }, legacy: false })
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', card: { branch: 'feat/bus-card' } })
    expect(piped).toContain('#930 bus-card')
    bench.close()
  })

  describe('the card text launch reads', () => {
    const BUS_TEXT = parkingFileText({ card: '#931 bus-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/bus-card', touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'From the bus.' })
    const FILE_TEXT = BUS_TEXT.replace('From the bus.', 'From the parking file.')

    function busWithBody(root: string): string {
      const busPath = path.join(root, 'bus.db')
      const db = openBus(busPath)
      try {
        appendEvent(db, { ts: '2026-10-20T00:00:00.000Z', type: CARD_ADMITTED, actor: 'policy', cardId: 931, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:931`, payload: { lane: 'lane-x', decision: 'auto', contour: 'cheap', depends: [], admission: admission(931), text: BUS_TEXT, textSha: textSha(BUS_TEXT) }, legacy: false })
        reduce(db)
      }
      finally {
        db.close()
      }
      return busPath
    }

    function parked(root: string, name: string): string {
      const file = path.join(root, 'parking', 'lane-x', name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, FILE_TEXT)
      return file
    }

    it('busCardBodies reads the body from a real bus file and returns null without one', () => {
      const root = tempRoot()
      const busPath = busWithBody(root)
      expect(busCardBodies(busPath)(931)).toBe(BUS_TEXT)
      expect(busCardBodies(busPath)(932)).toBeNull()
      expect(busCardBodies(path.join(root, 'no-bus.db'))(931)).toBeNull()
      expect(existsSync(path.join(root, 'no-bus.db'))).toBe(false)
    })

    it('the ports the launch worker builds from its bus path read the bus body over a differing parking file', () => {
      const root = tempRoot()
      const busPath = busWithBody(root)
      parked(root, '931.md')
      expect(busStarterPorts(busPath, root, {}, '', () => 'u').read(931)).toBe(BUS_TEXT)
    })

    it('a parking file the bus holds no body of is never read', () => {
      const root = tempRoot()
      const busPath = busWithBody(root)
      parked(root, '933.md')
      expect(busStarterPorts(busPath, root, {}, '', () => 'u').read(933)).toBeNull()
    })
  })

  it('a process that is not its own group leader is denied and records no card.started', () => {
    const starter = new FakeStarter(card => ({ kind: 'started', card: { session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 5000 + card.cardId, pgid: 1 } }))
    const bench = launchBench(starter)
    bench.admit(925, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'denied', denial: { reason: 'not_detached' }, next: 'queued' })
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([])
    expect(starter.stops.map(card => card.pid)).toEqual([5925])
    bench.close()
  })

  it('a session denied as not detached is killed, so it does not run untracked in its worktree', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, stub.command, 926, { pgidOf: () => 1 }))
    bench.admit(926, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'not_detached' }, next: 'queued' })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    bench.close()
  })

  it('a session whose process group cannot be read is killed before start_failed', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const unreadableGroup = (): never => {
      throw new Error('ps: no such process')
    }
    const bench = launchBench(realStarter(root, stub.command, 927, { pgidOf: unreadableGroup }))
    bench.admit(927, 'lane-x')
    bench.tick()

    const outcome = bench.launch(bench.leaseLaunch()!)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'start_failed' }, next: 'queued' })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    bench.close()
  })

  it('a session started while its card was started elsewhere is killed with its process group', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    let bench: ReturnType<typeof launchBench> | undefined
    const real = realStarter(root, stub.command, 946)
    const starter: CardStarter = {
      start: (card) => {
        const start = real.start(card)
        bench!.started(card.cardId)
        return start
      },
      stop: card => real.stop(card),
    }
    bench = launchBench(starter)
    bench.admit(946, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!)).toEqual({ kind: 'fenced', taskKey: launch(946) })
    await waitForExit(groups.at(-1)!)
    expect(alive(groups.at(-1)!)).toBe(false)
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'earlier' }])
    bench.close()
  })

  it('a launch pins the card mode the way relaunch pins the Operator mode', () => {
    expect(cardCommand('claude')).toBe('claude --permission-mode dontAsk')
  })

  it('a launch worker started from an auto window starts the card session in dontAsk', async () => {
    const root = tempRoot()
    const stub = stubClaude(root)
    const bench = launchBench(realStarter(root, `${stub.command} --permission-mode auto`, 934, {}, { claude: stub.command }))
    bench.admit(934, 'lane-x')
    bench.tick()

    expect(bench.launch(bench.leaseLaunch()!).kind).toBe('started')
    const [args, card] = (await written(stub.argsFile)).trim().split('\n')
    expect(args).toBe(`--permission-mode dontAsk --settings ${JSON.stringify(shiftSettings(path.join(root, 'mc-934'), shiftGateOf(null)))} --strict-mcp-config -p --session-id session-934`)
    expect(card).toBe('card=934')
    bench.close()
  })

  it('a launch with a stale lease_gen is refused and writes nothing', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(940, 'lane-a')
    bench.tick()
    const lease = bench.leaseLaunch()!
    const stale: Lease = { ...lease, leaseGen: lease.leaseGen - 1 }
    const before = eventCount(bench.db)

    expect(bench.launch(stale)).toEqual({ kind: 'fenced', taskKey: launch(940) })
    expect(eventCount(bench.db)).toBe(before)
    expect(starter.starts).toEqual([])
    bench.close()
  })

  it('a card started by someone else while the launch ran is refused at complete', () => {
    const bench = launchBench()
    const starter = new FakeStarter((card) => {
      bench.started(card.cardId)
      return { kind: 'started', card: { session: 's', worktree: '/t', branch: 'b', base: 'f'.repeat(40), pid: 7, pgid: 7 } }
    })
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, isolation: sandboxed })
    bench.admit(945, 'lane-a')
    bench.tick()

    expect(executor.launch(bench.leaseLaunch()!)).toEqual({ kind: 'fenced', taskKey: launch(945) })
    expect(eventsOf(bench.db, CARD_STARTED)).toEqual([{ session: 'earlier' }])
    expect(starter.stops.map(card => card.pid)).toEqual([7])
    expect(taskState(bench.db, launch(945))).toMatchObject({ state: 'leased' })
    bench.close()
  })

  it('a card that is no longer queued when leased is withdrawn without a start', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(950, 'lane-a')
    bench.tick()
    const lease = bench.leaseLaunch()!
    bench.started(950)

    expect(bench.launch(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'card_not_queued' }, next: 'withdrawn' })
    expect(starter.starts).toEqual([])
    bench.close()
  })

  function requeuedAfterFaultStop(bench: ReturnType<typeof launchBench>, cardId: number, stop: Record<string, unknown> | null): void {
    const ts = (): string => bench.clock.now().toISOString()
    bench.admit(cardId, `lane-${cardId}`)
    bench.tick()
    for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1) {
      const lease = bench.leaseLaunch()!
      expect(bench.launch(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'start_failed' } })
    }
    if (stop !== null)
      appendEvent(bench.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:shift:1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:after-fault-${cardId}`, payload: stop, legacy: false })
    bench.tick()
    const refuse = (): never => {
      throw new Error('a requeue of a launch uses no tree tool')
    }
    requestFromWindow(bench.db, ts(), 'test', { kind: 'requeue', task_key: launch(cardId) })
    expect(new WindowRequests(bench.db, bench.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => null, closePr: refuse, closeDropped: () => [] }).run()).toMatchObject([{ kind: 'done' }])
    bench.tick()
  }

  it('a card stopped by fault whose launch the window requeued is launchable again', () => {
    const bench = launchBench(new FakeStarter(card => ({ kind: 'refused', denial: { kind: 'technical', reason: 'start_failed', detail: `no tree for card #${card.cardId}` } })))
    requeuedAfterFaultStop(bench, 1185, null)

    expect(taskState(bench.db, launch(1185))).toMatchObject({ state: 'queued' })
    expect(launchableCard(bench.db, 1185)).toEqual({ lane: 'lane-1185', contour: 'cheap' })
    bench.close()
  })

  it('a card stopped by question stays out of the candidates', () => {
    const bench = launchBench(new FakeStarter(card => ({ kind: 'refused', denial: { kind: 'technical', reason: 'start_failed', detail: `no tree for card #${card.cardId}` } })))
    requeuedAfterFaultStop(bench, 1186, { reason: 'question.owner', detail: 'which lane' })

    expect(taskState(bench.db, launch(1186))).toMatchObject({ state: 'queued' })
    expect(launchableCard(bench.db, 1186)).toBeNull()
    expect(launchCandidates(bench.db)).toEqual([])
    bench.close()
  })

  describe('the time limit of a launched session', () => {
    const LIMIT_MS = LAUNCH_LIMIT_MINUTES * 60_000

    function runningCard(commandLine: string | null | ((starter: FakeStarter) => string | null), mode: 'shadow' | 'live' = 'live', answer?: (card: QueuedCard) => CardStart) {
      const starter = new FakeStarter(answer)
      const bench = launchBench(starter)
      bench.admit(947, 'lane-a')
      bench.tick()
      const startedAt = bench.clock.now().getTime()
      expect(bench.launch(bench.leaseLaunch()!).kind).toBe('started')
      bench.tick()
      const processes: ProcessTable = { commandLine: () => typeof commandLine === 'function' ? commandLine(starter) : commandLine, signalGroup: () => {} }
      const node = new LaunchNode({ db: bench.db, starter, clock: bench.clock.now, session: 'w1', mode, env: {}, processes, isolation: sandboxed })
      const advanceToLimitPlus = (offsetMs: number): void => {
        bench.clock.advance(startedAt + LIMIT_MS + offsetMs - bench.clock.now().getTime())
        recordHeartbeat(bench.db, bench.clock.now().toISOString(), { card: 947, pr: null, head: null, step: 'PostToolUse', session: 's-947', lease: null })
      }
      return { bench, starter, node, advanceToLimitPlus }
    }

    const timeLimitStops = (bench: ReturnType<typeof launchBench>): unknown[] => eventsOf(bench.db, CARD_STOPPED).filter(payload => String(payload.detail).startsWith('time-limit'))

    it('stops a live session at the limit once and records time-limit once', () => {
      const { bench, starter, node, advanceToLimitPlus } = runningCard(starter => starter.stops.length > 0 ? null : 'sh -c claude -p --session-id s-947')
      const stoppedBeforeStop: number[] = []
      const stop = starter.stop.bind(starter)
      starter.stop = (card) => {
        stoppedBeforeStop.push(eventsOf(bench.db, CARD_STOPPED).length)
        stop(card)
      }

      advanceToLimitPlus(-1)
      expect(node.stopOverdue()).toEqual([])
      expect(starter.stops).toEqual([])

      advanceToLimitPlus(0)
      expect(node.stopOverdue()).toEqual([947])
      expect(node.stopOverdue()).toEqual([])
      expect(starter.stops.map(card => card.pgid)).toEqual([4242])
      expect(stoppedBeforeStop).toEqual([0])
      expect(timeLimitStops(bench)).toHaveLength(1)
      expect(timeLimitStops(bench)).toMatchObject([{ reason: 'fault' }])
      bench.close()
    })

    it('stops nothing and records nothing in shadow mode', () => {
      const { bench, starter, node, advanceToLimitPlus } = runningCard('sh -c claude -p --session-id s-947', 'shadow')

      advanceToLimitPlus(0)
      expect(node.stopOverdue()).toEqual([])
      expect(starter.stops).toEqual([])
      expect(timeLimitStops(bench)).toEqual([])
      bench.close()
    })

    it('a kill that does not take records nothing and is tried again on the next pause', () => {
      const { bench, starter, node, advanceToLimitPlus } = runningCard('sh -c claude -p --session-id s-947')

      advanceToLimitPlus(0)
      expect(node.stopOverdue()).toEqual([])
      expect(node.stopOverdue()).toEqual([])
      expect(starter.stops).toHaveLength(2)
      expect(timeLimitStops(bench)).toEqual([])
      bench.close()
    })

    it('skips a running card whose card.started payload is not a whole started card', () => {
      const { bench, starter, node, advanceToLimitPlus } = runningCard('sh -c claude -p --session-id s-947', 'live', () => ({ kind: 'started', card: { session: 's-947' } as StartedCard }))

      advanceToLimitPlus(0)
      expect(node.stopOverdue()).toEqual([])
      expect(starter.stops).toEqual([])
      expect(timeLimitStops(bench)).toEqual([])
      bench.close()
    })

    it('does not signal a session whose command line does not name its session id', () => {
      const { bench, starter, node, advanceToLimitPlus } = runningCard('/usr/bin/vim notes.md')

      advanceToLimitPlus(0)
      expect(node.stopOverdue()).toEqual([947])
      expect(starter.stops).toEqual([])
      expect(timeLimitStops(bench)).toEqual([])
      bench.close()
    })
  })

  it('the launch node takes the launch queue and ships switched off in bus:bg', async () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    bench.admit(960, 'lane-a')
    bench.tick()
    const node = new LaunchNode({ db: bench.db, starter, clock: bench.clock.now, session: 'w1', mode: 'live', env: {}, isolation: sandboxed })
    const controller = new AbortController()
    const once = async (): Promise<void> => node.run({ pause: async () => controller.abort(), signal: controller.signal })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await once()
    expect(starter.starts.map(card => card.cardId)).toEqual([960])
    expect(taskState(bench.db, launch(960))).toMatchObject({ state: 'completed' })
    expect(busLaunches(() => []).map(each => [each.script, ...each.args].join(' '))).toContain('bus:launch --on')
    bench.close()
  })
})

describe('launch candidates', () => {
  it('a free ghost row queues the review step of the same card once', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    const executor = new LaunchExecutor({ db: bench.db, starter, ladder: starter, clock: bench.clock.now, isolation: sandboxed })
    bench.admit(981, 'lane-a', [], 'ladder')
    bench.tick()
    expect(executor.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: launch(981) })

    bench.ghostRow(981, 'ghost-1', 'writing')
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: launch(981), state: 'completed' }])

    bench.ghostRow(981, 'ghost-1', 'free')
    bench.tick()
    bench.tick()
    const reviewKey = launchTasks(bench.db)[1]!.task_key as string
    expect(reviewKey).toMatch(new RegExp(`^${launch(981)}:ghost-\\d+$`))
    expect(launchTasks(bench.db)).toEqual([{ task_key: launch(981), state: 'completed' }, { task_key: reviewKey, state: 'queued' }])

    expect(executor.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: reviewKey })
    bench.tick()
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: launch(981), state: 'completed' }, { task_key: reviewKey, state: 'completed' }])
    expect(eventsOf(bench.db, CARD_STARTED).map(payload => payload.contour)).toEqual(['ladder', 'ladder'])
    bench.close()
  })

  it('a free ghost row of a cheap card queues nothing', () => {
    const starter = new FakeStarter()
    const bench = launchBench(starter)
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, isolation: sandboxed })
    bench.admit(982, 'lane-a')
    bench.tick()
    executor.launch(bench.leaseLaunch()!)
    bench.ghostRow(982, 'ghost-2', 'free')
    bench.tick()

    expect(launchTasks(bench.db)).toEqual([{ task_key: launch(982), state: 'completed' }])
    bench.close()
  })
})

function cardText(cardId: number, depends = '—'): string {
  return `#${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends ${depends} · blocks —`
}

function intakeLine(cardId: number, source: string, minute: number, depends?: string): string {
  return JSON.stringify({ event: 'intake', task: String(cardId), card: cardText(cardId, depends), confirmation: 'auto', corrections: [], bodySha: `body${minute}`, source, ts: `2026-10-10T13:${String(minute).padStart(2, '0')}:00.000Z` })
}

function moveLine(cardId: number, from: string, to: string, minute: number): string {
  return JSON.stringify({ event: 'intake-move', task: String(cardId), from, to, bodySha: `body${minute}`, ts: `2026-10-10T13:${String(minute).padStart(2, '0')}:00.000Z` })
}

function journalBench(starter: CardStarter = new FakeStarter()) {
  const root = tempRoot()
  const parking = path.join(root, 'parking')
  const journal = path.join(root, 'ghosts.jsonl')
  writeFileSync(journal, '')
  const lines: string[] = []
  const bench = launchBench(starter, (db, clock) => () => void importJournalFile(db, journal, parkingLane(parking), clock.now))
  return {
    ...bench,
    parking,
    park: (cardId: number, lane: string): void => {
      mkdirSync(path.join(parking, lane), { recursive: true })
      writeFileSync(path.join(parking, lane, `${cardId}.md`), cardText(cardId))
    },
    append: (line: string): string => {
      lines.push(line)
      appendFileSync(journal, `${line}\n`)
      return legacyEventOf(line, lines.length)!.dedupeKey
    },
  }
}

function admittedRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`SELECT ts, actor, card_id, dedupe_key, payload FROM events WHERE type = '${CARD_ADMITTED}' ORDER BY id`).all() as Record<string, unknown>[]
}

function launchTasks(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'launch' ORDER BY id`).all() as Record<string, unknown>[]
}

describe('card.admitted from the intake journal', () => {
  it('an intake admit line in the journal enqueues a launch task with no manual step', () => {
    const bench = journalBench()
    bench.park(970, 'lane-q')
    const line = bench.append(intakeLine(970, 'admit', 1))
    bench.tick()

    expect(eventsOf(bench.db, CARD_ADMITTED)).toEqual([{ lane: 'lane-q', depends: [], decision: 'auto', contour: 'cheap', admission: line }])
    expect(line).toMatch(/^legacy:1:[0-9a-f]{64}$/)
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:970:${line}`, state: 'queued' }])
    expect(bench.leaseLaunch()).toMatchObject({ taskKey: `launch:970:${line}`, cardId: 970, pr: null, head: null, leaseGen: 1 })
    bench.close()
  })

  it('a card queued in its lane now gets exactly one launch task', () => {
    const bench = journalBench()
    bench.park(983, 'lane-q')
    const line = bench.append(intakeLine(983, 'admit', 1))
    bench.tick()
    bench.tick()

    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:983:${line}`, state: 'queued' }])
    bench.close()
  })

  it('a replay of the whole journal queues no launch for a closed or archived card', () => {
    const bench = journalBench()
    bench.park(984, 'lane-q')
    bench.park(985, ARCHIVE_DIR)
    bench.append(intakeLine(984, 'admit', 1))
    bench.append(intakeLine(985, 'admit', 2))
    bench.append(intakeLine(986, 'admit', 3))
    rmSync(path.join(bench.parking, 'lane-q', '984.md'))
    bench.tick()
    bench.tick()

    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a card moved into a lane and admitted, then closed into the archive with no journal line, queues no launch', () => {
    const bench = journalBench()
    bench.park(995, 'lane-q')
    bench.append(moveLine(995, bench.parking, path.join(bench.parking, 'lane-q'), 1))
    bench.append(intakeLine(995, 'admit', 2))
    mkdirSync(path.join(bench.parking, ARCHIVE_DIR), { recursive: true })
    renameSync(path.join(bench.parking, 'lane-q', '995.md'), path.join(bench.parking, ARCHIVE_DIR, '995.md'))
    bench.tick()
    bench.tick()

    expect(admittedRows(bench.db)).toEqual([])
    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a replay of the whole journal queues no launch for a card parked in dropped, sliced or a topic directory', () => {
    const bench = journalBench()
    const parked = [[987, 'dropped'], [988, 'sliced'], [989, 'architecture'], [990, 'self-learning'], [991, '2026-10-10-b'], [992, 'night-4'], [993, 'lane-bus-5']] as const
    for (const [cardId, lane] of parked)
      bench.park(cardId, lane)
    parked.forEach(([cardId], index) => bench.append(intakeLine(cardId, 'admit', index + 1)))
    bench.park(994, 'dropped')
    bench.append(intakeLine(994, 'admit', 10))
    bench.append(moveLine(994, path.join(bench.parking, 'lane-q'), path.join(bench.parking, 'dropped'), 11))
    bench.tick()

    expect(admittedRows(bench.db).map(row => [row.card_id, JSON.parse(String(row.payload)).lane])).toEqual([
      [991, '2026-10-10-b'],
      [992, 'night-4'],
      [993, 'lane-bus-5'],
    ])
    expect(launchTasks(bench.db).map(task => String(task.task_key).split(':')[1])).toEqual(['991', '992', '993'])
    bench.close()
  })

  it('a card moved through dropped into a lane is admitted only for the lane', () => {
    const bench = journalBench()
    bench.park(996, 'lane-q')
    bench.append(moveLine(996, bench.parking, path.join(bench.parking, 'dropped'), 1))
    bench.append(moveLine(996, path.join(bench.parking, 'dropped'), path.join(bench.parking, 'lane-q'), 2))
    bench.tick()

    expect(admittedRows(bench.db).map(row => JSON.parse(String(row.payload)).lane)).toEqual(['lane-q'])
    bench.close()
  })

  it('after card.stopped and after a withdrawal the next legacy card does not join the launch queue', () => {
    const bench = journalBench()
    for (const [cardId, minute] of [[990, 1], [991, 2]] as const) {
      bench.park(cardId, 'lane-q')
      bench.append(intakeLine(cardId, 'admit', minute))
    }
    bench.tick()
    expect(launchTasks(bench.db).map(task => task.state)).toEqual(['queued'])
    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 74, text: 'allow-live launch', cards: [] })
    withdrawLegacyLaunchTasks(bench.db, bench.clock.now().toISOString())
    bench.tick()
    expect(launchTasks(bench.db).map(task => task.state)).toEqual(['withdrawn'])

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'policy', cardId: 990, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:990`, payload: { reason: 'fault' }, legacy: false })
    bench.tick()
    expect(launchTasks(bench.db).map(task => task.state)).toEqual(['withdrawn'])

    bench.park(992, 'lane-q')
    const fresh = bench.append(intakeLine(992, 'admit', 3))
    bench.tick()
    expect(launchTasks(bench.db).map(task => task.task_key)).toEqual([expect.stringMatching(/^launch:990:/), `launch:992:${fresh}`])
    bench.close()
  })

  it('a second admit after the card fell enqueues a new launch', () => {
    const starter = new FakeStarter()
    const bench = journalBench(starter)
    bench.park(971, 'lane-q')
    const first = bench.append(intakeLine(971, 'admit', 1))
    bench.tick()
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:971:${first}` })

    const again = bench.append(intakeLine(971, 'admit', 2))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:971:${first}`, state: 'completed' }])

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'policy', cardId: 971, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:971`, payload: { reason: 'fault' }, legacy: false })
    const third = bench.append(intakeLine(971, 'admit', 3))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([
      { task_key: `launch:971:${first}`, state: 'completed' },
      { task_key: `launch:971:${third}`, state: 'queued' },
    ])
    expect(third).not.toBe(again)
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:971:${third}` })
    expect(starter.starts).toEqual([{ cardId: 971, lane: 'lane-q' }, { cardId: 971, lane: 'lane-q' }])
    bench.close()
  })

  it('a second admit after the card fell enqueues a new launch even after its task:start path line was imported', () => {
    const starter = new FakeStarter()
    const bench = journalBench(starter)
    bench.park(974, 'lane-q')
    const first = bench.append(intakeLine(974, 'admit', 1))
    bench.tick()
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:974:${first}` })
    bench.append(JSON.stringify({ event: 'path', task: '974', path: 'cheap', started: '2026-10-10T13:01:30.000Z', worktree: '/tmp/mc-974', branch: 'feat/card-974', card: cardText(974), ts: '2026-10-10T13:01:30.000Z' }))
    bench.tick()

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'policy', cardId: 974, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:974`, payload: { reason: 'fault' }, legacy: false })
    const again = bench.append(intakeLine(974, 'admit', 2))
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([
      { task_key: `launch:974:${first}`, state: 'completed' },
      { task_key: `launch:974:${again}`, state: 'queued' },
    ])
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started', taskKey: `launch:974:${again}` })
    expect(starter.starts).toEqual([{ cardId: 974, lane: 'lane-q' }, { cardId: 974, lane: 'lane-q' }])
    bench.close()
  })

  it('an admit line and its task:start path line imported in one tick offer no launch', () => {
    const bench = journalBench()
    bench.park(979, 'lane-q')
    bench.append(intakeLine(979, 'admit', 1))
    bench.append(JSON.stringify({ event: 'path', task: '979', path: 'cheap', started: '2026-10-10T13:01:30.000Z', worktree: '/tmp/mc-979', branch: 'feat/card-979', card: cardText(979), ts: '2026-10-10T13:01:30.000Z' }))
    bench.tick()

    expect(admittedRows(bench.db)).toHaveLength(1)
    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })

  it('a redelivered admit line enqueues no second launch task', () => {
    const bench = journalBench()
    bench.park(972, 'lane-q')
    const line = bench.append(intakeLine(972, 'admit', 1))
    bench.tick()
    bench.tick()
    expect(importJournal(bench.db, readFileSync(path.join(path.dirname(bench.parking), 'ghosts.jsonl'), 'utf8'), parkingLane(bench.parking), bench.clock.now)).toMatchObject({ imported: 0, admitted: 0 })
    bench.tick()

    expect(admittedRows(bench.db)).toHaveLength(1)
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:972:${line}`, state: 'queued' }])
    expect(bench.launch(bench.leaseLaunch()!)).toMatchObject({ kind: 'started' })
    bench.tick()
    expect(launchTasks(bench.db)).toEqual([{ task_key: `launch:972:${line}`, state: 'completed' }])
    bench.close()
  })

  it('a replay of the journal yields the same card.admitted events', () => {
    const root = tempRoot()
    const parking = path.join(root, 'parking')
    for (const [cardId, lane] of [[973, 'lane-a'], [974, 'lane-b']] as const) {
      mkdirSync(path.join(parking, lane), { recursive: true })
      writeFileSync(path.join(parking, lane, `${cardId}.md`), cardText(cardId))
    }
    const journal = [
      intakeLine(973, 'admit', 1, '#900'),
      moveLine(973, path.join(parking, 'lane-a'), path.join(parking, 'lane-c'), 2),
      intakeLine(973, 'admit', 3, '#900'),
      intakeLine(974, 'admit', 4),
      intakeLine(974, 'amend', 5),
    ].join('\n')
    const clock = () => new Date('2026-10-10T15:00:00.000Z')
    const first = openBus(path.join(root, 'first.db'))
    const second = openBus(path.join(root, 'second.db'))
    importJournal(first, journal, parkingLane(parking), clock)
    importJournal(second, journal, parkingLane(parking), clock)
    const recorded = admittedRows(first)

    expect(recorded.map(row => [row.card_id, JSON.parse(String(row.payload)).lane, JSON.parse(String(row.payload)).depends])).toEqual([
      [973, 'lane-a', [900]],
      [973, 'lane-c', [900]],
      [973, 'lane-c', [900]],
      [974, 'lane-b', []],
    ])
    expect(recorded.every(row => row.actor === 'reducer')).toBe(true)
    expect(admittedRows(second)).toEqual(recorded)

    renameSync(path.join(parking, 'lane-b'), path.join(parking, 'lane-z'))
    importJournal(first, journal, parkingLane(parking), () => new Date('2026-10-11T00:00:00.000Z'))
    expect(admittedRows(first)).toEqual(recorded)
    first.close()
    second.close()
  })

  it('an intake amend line produces no card.admitted and no launch', () => {
    const bench = journalBench()
    bench.park(975, 'lane-q')
    bench.append(intakeLine(975, 'amend', 1))
    bench.append(JSON.stringify({ event: 'intake', task: '975', card: cardText(975), source: 'retell', ts: '2026-10-10T13:02:00.000Z' }))
    bench.append(JSON.stringify({ event: 'intake', task: '975', card: cardText(975), ts: '2026-10-10T13:03:00.000Z' }))
    bench.tick()
    bench.tick()

    expect(admittedRows(bench.db)).toEqual([])
    expect(launchTasks(bench.db)).toEqual([])
    expect(bench.leaseLaunch()).toBeNull()
    bench.close()
  })
})
