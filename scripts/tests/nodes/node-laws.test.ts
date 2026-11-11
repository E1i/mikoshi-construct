import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { Lease } from '../../core/lease.js'
import type { NodeContext, NodeKind, NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { LawCell, LawCells, LawId, LawNode, LawSite } from '../../nodes/laws.js'
import type { ReviewStart, SessionDescendants } from '../../nodes/review/reviewer.js'
import type { GitHub } from '../../ports/github.js'
import type { InMemoryProcesses, ProcessRow } from '../../ports/process-table.js'
import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import type { BusWorker } from '../../supervisor/workers.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { ABANDONED_TITLE } from '../../ci/required.js'
import { printBoard } from '../../cli/board-page.js'
import { NODE_DECLARATIONS } from '../../contract/factory/nodes.js'
import { LAW_GAP_PREFIX, lawGapNumbers, ratchetBreaks, readRatchet } from '../../contract/ratchet.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, CARD_WAITING, CI_RERUN_REQUESTED, OWNER_WAIT_OPENED, PR_OPENED, SCOPE_WIDENED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'
import { completeTask, leaseNext, recordWorkerStarted } from '../../core/lease.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { Node } from '../../core/node.js'
import { answerCandidates, keyOf, queueTask, queueTaskWithin, updateCandidates } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { handoffBuilder } from '../../nodes/launch/launch-root.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { CARD_WAIT_STATES, DIRECT_IMPORTER_WIDENED, gapRows, INFRASTRUCTURE_RETRIED, LAUNCH_BODY_FROM_LATEST_ADMISSION, LAW_CELLS, LAW_NODES, LAW_SITES, lawIds, LAWS, NO_HEAD_OF_LINE, NODE_WITNESSES_CALL_THEIR_NODE, RESTART_KEEPS_SESSION, REVIEW_KEEPS_SESSION_AND_LEAVES_NO_DESCENDANT, SESSION_BEAT_BESIDE_STALE_WINDOW, SLICED_DROP_REPOINTS_DEPENDS, sourceOf } from '../../nodes/laws.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { dryRun } from '../../nodes/review/review-worker.js'
import { claudeReviewer, ReviewTrees } from '../../nodes/review/reviewer.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { launchName } from '../../supervisor/bg.js'
import { BusTick } from '../../supervisor/run.js'
import { slotsVariable } from '../../supervisor/scheduler.js'
import { busDrain, BusSupervisor, freeLeasesOf, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'
import { Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'
import { reachesSite } from './law-reach.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const OWNER_LAWS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7']

interface Witness {
  law: LawId
  run: (node: LawNode) => Promise<void>
}

type Witnesses = Readonly<Record<string, Witness>>

type Reaches = (site: LawSite, run: () => unknown) => Promise<boolean>

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const SESSION_WRAPPER_PID = 599
const SESSION_PID = 600
const CLOSE_PID = 610
const PROMISE_TURNS = 10_000
const MINUTE = 60_000
const BOARD_NOW = new Date('2026-11-09T15:40:00.000Z')
const STALE_WINDOW_BEAT = '2026-11-07T14:39:00.000Z'
const LIVE_HEADER = 'id="bus-live">bus live<'
const SILENT_SESSION_MINUTES = 120
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class LiveSession extends Node<NodeStep> {
  readonly taken: string[] = []
  private readonly rounds: (() => void)[] = []

  constructor(kind: NodeKind, db: DatabaseSync, clock: () => Date) {
    super(kind, { db, clock, session: 'old', mode: 'live', env: { [slotsVariable(kind)]: '1' }, self: { pid: SESSION_PID, started: clock().toISOString() } })
  }

  override async run(ctx: NodeContext): Promise<void> {
    return super.run({ ...ctx, codeSha: () => OLD_MAIN })
  }

  protected candidates(): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    this.taken.push(lease.taskKey)
    await new Promise<void>((resolve) => {
      this.rounds.push(resolve)
    })
    completeTask(this.db, this.clockIso(), lease, [])
    return { kind: 'completed', taskKey: lease.taskKey }
  }

  private clockIso(): string {
    return this.parts.clock().toISOString()
  }

  finish(): void {
    for (const round of this.rounds.splice(0))
      round()
  }
}

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < PROMISE_TURNS && !condition(); turns++)
    await Promise.resolve()
  if (!condition())
    throw new Error('the session never took its lease')
}

async function restartKeepsSession(node: LawNode): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'z1-restart-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const date = (): Date => new Date('2026-11-09T18:45:26.000Z')
  const ts = (): string => date().toISOString()
  const launches = workerLaunches(() => [])
  const { close } = launches
  const sessionLaunch = launches[node as BusWorker]
  let alive: RunningProcess[] = [
    { pid: CLOSE_PID, args: `node pnpm.cjs --silent ${launchName(close)}` },
    { pid: SESSION_WRAPPER_PID, args: `node pnpm.cjs --silent ${launchName(sessionLaunch)}` },
    { pid: SESSION_PID, args: `node --import tsx ${sessionLaunch.markers[0]}` },
  ]
  const stopped: number[] = []
  const kind = node as NodeKind
  const session = new LiveSession(kind, db, date)
  recordWorkerStarted(db, ts(), session.actor, { pid: SESSION_PID, started: ts() })
  const task: QueuedTask = { queue: kind, cardId: 1776 }
  let head = OLD_MAIN
  const known: DetachedLaunch[] = [close, sessionLaunch]
  const supervisor = new BusSupervisor({
    known,
    wanted: () => known,
    start: (launch): BgResult => {
      alive = [...alive, { pid: 701, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return { stdout: [], stderr: [], exitCode: 0 }
    },
    stop: async (instance, launch) => {
      if (launch === close) {
        queueTaskWithin(db, ts(), task)
        await untilTrue(() => session.taken.length === 1)
      }
      stopped.push(instance.pid)
      alive = alive.filter(each => each.pid !== instance.pid)
    },
    freeLeases: list => freeLeasesOf(db, ts(), list),
    drain: busDrain(db, ts),
    processes: withoutRetiring(() => alive, db),
    mainSince: () => [{ id: 1, sha: NEW_MAIN }],
    code: {
      head: () => head,
      holds: sha => sha === head,
      pull: () => {
        head = NEW_MAIN
      },
      changedSince: sha => sha === head ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
    },
    journal: () => {},
    now: () => date().getTime(),
  }, 0)
  const controller = new AbortController()
  const running = session.run({ pause: async () => {}, signal: controller.signal })
  try {
    await supervisor.step()
  }
  finally {
    session.finish()
    controller.abort()
    await running.catch(() => {})
  }
  const state = db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(keyOf(task))
  db.close()
  if (stopped.includes(SESSION_PID) || stopped.includes(SESSION_WRAPPER_PID))
    throw new Error(`the restart signalled the live ${node} session (stopped ${stopped.join(', ')})`)
  if ((state as { state?: string } | undefined)?.state !== 'completed')
    throw new Error(`the ${node} session did not finish its round: ${JSON.stringify(state)}`)
}

function boardReadsLive(node: LawNode, sessionBeat: string): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'z7-session-'))
  roots.push(root)
  const events: SeedEvent[] = [
    { ts: STALE_WINDOW_BEAT, type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'window' }) },
    { ts: sessionBeat, type: SESSION_HEARTBEAT, card: 45, payload: JSON.stringify({ session: 's-45', step: node }) },
  ]
  const busPath = writeBus(path.join(root, 'bus.db'), { events })
  const db = new DatabaseSync(busPath)
  try {
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  }
  finally {
    db.close()
  }
  let html = ''
  vi.stubEnv('BUS_RERUN', '')
  try {
    printBoard(busPath, BOARD_NOW, (text) => {
      html += text
    }, path.join(root, 'miko.md'), 'html')
  }
  finally {
    vi.unstubAllEnvs()
  }
  return html.includes(LIVE_HEADER)
}

async function sessionBeatBesideStaleWindow(node: LawNode): Promise<void> {
  const ago = (minutes: number): string => new Date(BOARD_NOW.getTime() - minutes * MINUTE).toISOString()
  if (!boardReadsLive(node, ago(1)))
    throw new Error(`a ${node} session beating a minute ago beside a stale window beat reads the factory down`)
  if (boardReadsLive(node, ago(SILENT_SESSION_MINUTES)))
    throw new Error(`a ${node} session silent for ${SILENT_SESSION_MINUTES} minutes beside a stale window beat reads the factory live`)
}

function scratchDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

class RelaunchingStarter implements CardStarter, SessionContinuer {
  continued = 0

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c${this.continued}` } }
  }
}

async function usageLimitWaitsForItsReset(): Promise<void> {
  const made = mergeBench()
  try {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: 1711, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1711`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-1711' }, legacy: false })
    made.tick()
    const starter = new RelaunchingStarter()
    const reset = new Date(made.clock.now().getTime() + 3_600_000).toISOString()
    const node = new LaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, resulted: () => false, handedOff: () => false, collected: () => 'report-missing: no report was written', usageLimitedUntil: () => reset, machine: new MachineSessions(scratchDir('z2-machine-'), () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
    node.stopOverdue()
    made.clock.advance(3_600_000 + TICK_MS)
    node.stopOverdue()
    if (eventsOf(made.db, CARD_STOPPED).length > 0 || eventsOf(made.db, BOARD_ALARM).length > 0)
      throw new Error('a session that ended on the usage limit stopped as a fault')
    if (!eventsOf(made.db, CARD_WAITING).some(wait => wait.reason === 'usage-limit') || starter.continued !== 1)
      throw new Error('a session that ended on the usage limit was not launched again after its reset')
  }
  finally {
    made.close()
  }
}

async function loadTimeoutIsPushed(): Promise<void> {
  const made = mergeBench()
  try {
    const trees = scratchDir('z2-answer-')
    const ts = made.clock.now().toISOString()
    const text = 'card: #1775 a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-1775\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n'
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:1775`, payload: { card: '#1775', lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1775`, payload: { session: 'card-session-1', worktree: path.join(trees, 'mc-1775'), branch: 'feat/card-1775', base: sha('1') }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:1775`, payload: { reason: 'question.agent', detail: 'a question' }, legacy: false })
    made.tick()
    const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
    queueTask(made.db, ts, { queue: 'answer', cardId: 1775, stop })
    const owner = 'prepush timed out under machine load in scripts/tests/supervisor/stalled-sessions.test.ts, outside the touches; the witnesses are green'
    let pushed = 0
    const publish = (): void => {
      pushed += 1
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 1775, pr: 9775, head: null, dedupeKey: `${PR_OPENED}:1775:9775`, payload: { pr: 9775 }, legacy: false })
    }
    const executor = new AnswerExecutor({ db: made.db, answerer: async () => ({ session: 'answer-1', resumed: true, before: sha('a'), after: sha('a'), owner }), ownerMerges: () => '', clock: made.clock.now, trees: { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null, publishing: { committed: () => true, publish } })
    await executor.answer(leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)
    if (pushed !== 1 || eventsOf(made.db, OWNER_WAIT_OPENED).length > 0 || eventsOf(made.db, CARD_STOPPED).length !== 1)
      throw new Error('a timeout under load outside the touches was asked of the owner instead of pushed')
  }
  finally {
    made.close()
  }
}

function abandonedRunIsRerun(): void {
  const db = openBus(path.join(scratchDir('z2-update-'), 'bus.db'))
  try {
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    const url = 'https://api.github.com/repos/{owner}/{repo}/check-runs/77/annotations'
    const client: GitHub = (endpoint) => {
      if (endpoint === 'repos/{owner}/{repo}/check-runs/77/annotations')
        return { status: 200, headers: {}, body: [{ title: ABANDONED_TITLE }] }
      const response = gitHub.client(endpoint)
      if (!endpoint.includes('/check-runs'))
        return response
      const body = response.body as { check_runs: { name: string, conclusion: string | null }[] }
      return { ...response, body: { check_runs: body.check_runs.map(check => check.name === 'required' && check.conclusion === 'failure' ? { ...check, id: 77, output: { annotations_count: 1, annotations_url: url } } : check) } }
    }
    const busTick = new BusTick(db, new NetWatch(db, client, clock.now), clock.now, () => {})
    busTick.run()
    clock.advance(TICK_MS)
    gitHub.open({ number: 1493, required: 'failure', failed: [], runs: [{ id: 4343, run_attempt: 1, status: 'completed', conclusion: 'failure' }] })
    busTick.run()
    clock.advance(TICK_MS)
    const ts = clock.now().toISOString()
    if (answerCandidates(db, ts).some(task => task.pr === 1493))
      throw new Error('a required red only from abandoned jobs queued an answer')
    for (const task of updateCandidates(db, ts).filter(each => each.pr === 1493))
      queueTaskWithin(db, ts, task)
    const lease = leaseNext(db, ts, 'update', 'worker:update:worker-1')
    if (lease === null)
      throw new Error('a required red only from abandoned jobs queued no rerun')
    new UpdateExecutor({ db, gitHub: client, put: gitHub.put, post: gitHub.post, publish: gitHub.publish, clock: clock.now, settle: () => {} }).update(lease)
    if (gitHub.reruns.join() !== '4343' || db.prepare('SELECT 1 FROM events WHERE type = ?').get(CI_RERUN_REQUESTED) === undefined)
      throw new Error('the abandoned run was not re-run')
  }
  finally {
    db.close()
  }
}

async function infrastructureFailureIsRetried(node: LawNode): Promise<void> {
  if (node === 'launch')
    return usageLimitWaitsForItsReset()
  if (node === 'answer')
    return loadTimeoutIsPushed()
  if (node === 'update')
    return abandonedRunIsRerun()
  throw new Error(`no infrastructure retry is wired on ${node}`)
}

const IMPORTED = 'scripts/a.ts'
const IMPORTER = 'scripts/b.ts'

function treeWithAnImporter(worktree: string): void {
  const files: Record<string, string> = {
    'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`,
    [IMPORTED]: 'export const a = 1\n',
    [IMPORTER]: 'import { a } from \'./a.js\'\n\nexport const b = a\n',
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
}

async function directImporterWidened(node: LawNode): Promise<void> {
  if (node !== 'answer')
    throw new Error(`no direct-importer widening is wired on ${node}`)
  const made = mergeBench()
  try {
    const home = scratchDir('z3-answer-')
    const worktree = path.join(home, 'mc-1775')
    treeWithAnImporter(worktree)
    const ts = made.clock.now().toISOString()
    const text = `card: #1775 a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-1775\ntouches: ${IMPORTED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:1775`, payload: { card: '#1775', lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1775`, payload: { session: 'card-session-1', worktree, branch: 'feat/card-1775', base: sha('1') }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 1775, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:1775`, payload: { reason: 'question.agent', detail: 'the importer follows the export' }, legacy: false })
    made.tick()
    const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: 1775, stop })
    const heads = [sha('a'), sha('e')]
    const answerer = claudeAnswerer(path.join(home, 'answers'), {
      cardText: () => text,
      available: () => true,
      remoteHead: () => heads.shift() ?? null,
      spawn: async (run) => {
        writeFileSync(path.join(worktree, IMPORTED), 'export const a = 2\n')
        writeFileSync(path.join(worktree, IMPORTER), 'import { a } from \'./a.js\'\n\nexport const b = a + 1\n')
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
        return 0
      },
      newSession: () => 'new-session',
      publish: () => {},
      pending: () => [IMPORTED, IMPORTER],
    })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: { home, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null, prepare: () => {} })
    await executor.answer(leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)
    if (eventsOf(made.db, CARD_ANSWERED).length !== 1 || eventsOf(made.db, OWNER_WAIT_OPENED).length > 0 || eventsOf(made.db, SCOPE_WIDENED).length !== 1)
      throw new Error('an answer that edits a direct importer of a touched file was stopped for the owner instead of widened')
  }
  finally {
    made.close()
  }
}

const REVIEW_SESSION_PID = 900
const OBEDIENT_PNPM_PID = 901
const LINGERING_PNPM_PID = 902
const STARTED = 'Wed Nov 11 00:00:00 2026'
const REVIEW_PR = 1810

async function finishedReviewLeavesNoDescendant(): Promise<void> {
  const dir = scratchDir('z1-review-')
  const held: InMemoryProcesses = { rows: [] }
  const rowsNow = (): ProcessRow[] => held.rows as ProcessRow[]
  const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, pgid: pid, started: STARTED, command })
  const without = (pid: number): void => {
    held.rows = rowsNow().filter(each => each.pid !== pid)
  }
  const ticks: (() => void)[] = []
  const signalled: string[] = []
  let polls = 0
  const descendants: SessionDescendants = {
    table: new InMemoryProcessTable(held),
    end: (pid, signal) => {
      signalled.push(`${pid}:${signal}`)
      without(pid)
    },
    pause: async () => {
      polls += 1
      if (polls === 1)
        without(OBEDIENT_PNPM_PID)
    },
    every: (tick) => {
      ticks.push(tick)
      return () => ticks.splice(0)
    },
    sampleMs: 1,
    graceMs: 3,
  }
  const aliveAtRemoval: number[][] = []
  const trees = new ReviewTrees('/repo', dir, {
    git: (_cwd, args) => {
      if (args[1] === 'remove')
        aliveAtRemoval.push(rowsNow().map(each => each.pid))
    },
    worktrees: () => [],
    prepare: () => {},
    state: () => ({ head: sha('a'), status: [] }),
  })
  const start: ReviewStart = { gate: { start: async () => true, release: () => {} }, keep: () => true, joinWorkers: () => 1, leaveWorkers: () => {}, descendants }
  const reviewer = claudeReviewer(trees, async (params) => {
    held.rows = [
      row(REVIEW_SESSION_PID, process.pid, `agent ${params.sessionId}`),
      row(OBEDIENT_PNPM_PID, REVIEW_SESSION_PID, 'node pnpm.cjs install'),
      row(LINGERING_PNPM_PID, OBEDIENT_PNPM_PID, 'node pnpm.cjs install --lockfile-only'),
    ]
    for (const tick of ticks)
      tick()
    writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
    held.rows = rowsNow().filter(each => each.pid !== REVIEW_SESSION_PID).map(each => each.pid === OBEDIENT_PNPM_PID ? { ...each, ppid: 1 } : each)
    return 0
  }, () => {}, MINUTE, () => null, start)
  const gitHub = new FakeGitHub()
  gitHub.open({ number: REVIEW_PR })
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await dryRun(gitHub.client, reviewer, () => fullReview('a law witness'), REVIEW_PR)
  }
  finally {
    quiet.mockRestore()
  }
  if (aliveAtRemoval.length !== 1)
    throw new Error(`the finished review removed its tree ${aliveAtRemoval.length} times, not once`)
  if (aliveAtRemoval[0]!.length > 0)
    throw new Error(`descendants of the finished review session were alive when its tree was removed: ${aliveAtRemoval[0]!.join(', ')}`)
  if (signalled.some(each => each.startsWith(`${OBEDIENT_PNPM_PID}:`)) || !signalled.includes(`${LINGERING_PNPM_PID}:SIGTERM`))
    throw new Error(`the review did not wait for a descendant that ended in time, or left one that did not: ${signalled.join(', ')}`)
}

async function reviewKeepsSessionAndLeavesNoDescendant(node: LawNode): Promise<void> {
  if (node !== 'review')
    throw new Error(`no wait for the descendants of a finished session is wired on ${node}`)
  await restartKeepsSession(node)
  await finishedReviewLeavesNoDescendant()
}

const AMENDED_CARD = 1781
const ADMITTED_PROSE = 'The text admitted at 14:59.'
const AMENDED_PROSE = 'The widening amended at 15:35.'

function amendedCardBody(prose: string): string {
  return `card: #${AMENDED_CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${AMENDED_CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\n${prose}\n`
}

function admitBody(made: ReturnType<typeof mergeBench>, key: string, text: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: AMENDED_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${key}`, payload: { card: `#${AMENDED_CARD}`, lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: key, text, textSha: textSha(text) }, legacy: false })
}

async function launchBodyFromLatestAdmission(node: LawNode): Promise<void> {
  if (node !== 'launch')
    throw new Error(`no read of the card body from the latest admission is wired on ${node}`)
  const made = mergeBench()
  try {
    admitBody(made, 'admission-1', amendedCardBody(ADMITTED_PROSE))
    made.tick()
    const starter = new RelaunchingStarter()
    const launchDir = scratchDir('z3-launch-dir-')
    const handoff = path.join(launchDir, `report-${AMENDED_CARD}.md`)
    const build = handoffBuilder(launchDir)
    const launch = new LaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, pidAlive: () => false, collected: () => null, atContextLine: () => true, handedOff: () => existsSync(handoff), buildHandoff: build, machine: new MachineSessions(scratchDir('z3-launch-machine-'), () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
    const controller = new AbortController()
    await launch.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
    admitBody(made, 'admission-2', amendedCardBody(AMENDED_PROSE))
    if (cardBodyText(made.db, AMENDED_CARD)?.includes(AMENDED_PROSE) === true)
      throw new Error('the fold already holds the amend, so the witness proves nothing about a fold behind it')
    launch.stopOverdue()
    if (!existsSync(handoff) || !readFileSync(handoff, 'utf8').includes(AMENDED_PROSE))
      throw new Error('a launch after an amend continued from the folded body, not the latest admission')
  }
  finally {
    made.close()
  }
}

const WITNESSES: Witnesses = {
  [RESTART_KEEPS_SESSION]: { law: 'Z1', run: restartKeepsSession },
  [REVIEW_KEEPS_SESSION_AND_LEAVES_NO_DESCENDANT]: { law: 'Z1', run: reviewKeepsSessionAndLeavesNoDescendant },
  [INFRASTRUCTURE_RETRIED]: { law: 'Z2', run: infrastructureFailureIsRetried },
  [DIRECT_IMPORTER_WIDENED]: { law: 'Z3', run: directImporterWidened },
  [LAUNCH_BODY_FROM_LATEST_ADMISSION]: { law: 'Z3', run: launchBodyFromLatestAdmission },
  [SESSION_BEAT_BESIDE_STALE_WINDOW]: { law: 'Z7', run: sessionBeatBesideStaleWindow },
}

function cellKinds(cell: LawCell): string[] {
  return ['witness', 'notApplicable', 'gap'].filter(kind => kind in cell)
}

function cellFaults(law: LawId, node: LawNode, cell: LawCell | undefined, witnesses: Witnesses): string[] {
  if (cell === undefined)
    return [`${law} × ${node}: no cell`]
  if (cellKinds(cell).length !== 1)
    return [`${law} × ${node}: a cell is exactly one of witness, notApplicable or gap`]
  if ('witness' in cell)
    return witnesses[cell.witness]?.law === law ? [] : [`${law} × ${node}: witness ${cell.witness} is not a witness of ${law} the suite runs`]
  if ('notApplicable' in cell)
    return cell.notApplicable.trim() === '' ? [`${law} × ${node}: not applicable without its reason`] : []
  return cell.gap.length === 0 || cell.gap.some(card => !Number.isInteger(card) || card <= 0) ? [`${law} × ${node}: a gap names the card that closes it`] : []
}

function registryFaults(cells: LawCells, witnesses: Witnesses): string[] {
  const unknownLaws = Object.keys(cells).filter(law => !Object.hasOwn(LAWS, law)).map(law => `${law}: a law the registry does not declare`)
  return [...unknownLaws, ...lawIds().flatMap((law) => {
    const row = cells[law] as Partial<Record<LawNode, LawCell>> | undefined
    if (row === undefined)
      return [`${law}: no row`]
    const strangers = Object.keys(row).filter(node => !(LAW_SITES as readonly string[]).includes(node)).map(node => `${law} × ${node}: not a law site`)
    return [...strangers, ...LAW_NODES.flatMap(node => cellFaults(law, node, row[node], witnesses))]
  })]
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lawOutcome(law: LawId, node: LawNode, witnesses: Witnesses, reaches: Reaches = reachesSite): Promise<string | null> {
  const ofTheLaw = Object.entries(witnesses).filter(([, witness]) => witness.law === law)
  if (ofTheLaw.length === 0)
    return `no witness of ${law} runs on ${node}`
  const failures: string[] = []
  for (const [id, witness] of ofTheLaw) {
    try {
      if (await reaches(node, async () => witness.run(node)))
        return null
      failures.push(`${id}: passes without calling ${sourceOf(node)}`)
    }
    catch (error) {
      failures.push(`${id}: ${failureOf(error)}`)
    }
  }
  return failures.join('; ')
}

function gapTitle(law: LawId, node: LawNode, cards: readonly number[]): string {
  return `gap: ${law} × ${node} → ${cards.map(card => `#${card}`).join(', ')}`
}

function siteWithoutSource(site: LawSite): boolean {
  return !existsSync(path.join(REPO_ROOT, sourceOf(site)))
}

function recordedLawGaps(): Record<string, number> {
  return Object.fromEntries(Object.entries(readRatchet(REPO_ROOT)).filter(([key]) => key.startsWith(LAW_GAP_PREFIX)))
}

describe('the laws of a node', () => {
  it('every law has a cell for each of the 8 nodes and every witness cell names a witness', () => {
    expect(lawIds()).toEqual(OWNER_LAWS)
    expect(LAW_SITES.filter(siteWithoutSource)).toEqual([])
    expect(NODE_DECLARATIONS.map(({ kind }) => kind).filter(kind => !(LAW_NODES as readonly string[]).includes(kind))).toEqual([])
    expect(LAW_NODES).toHaveLength(8)
    expect(registryFaults(LAW_CELLS, WITNESSES)).toEqual([])

    const unwitnessed = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, merge: { witness: 'Z2-unwritten' } } }
    const missing = { ...LAW_CELLS, Z5: Object.fromEntries(Object.entries(LAW_CELLS.Z5).filter(([node]) => node !== 'review')) } as unknown as LawCells
    const unreasoned = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { notApplicable: ' ' } } }
    const cardless = { ...LAW_CELLS, Z6: { ...LAW_CELLS.Z6, update: { gap: [] } } }

    expect(registryFaults(unwitnessed, WITNESSES)).toEqual([expect.stringContaining('Z2 × merge: witness Z2-unwritten')])
    expect(registryFaults(missing, WITNESSES)).toEqual(['Z5 × review: no cell'])
    expect(registryFaults(unreasoned, WITNESSES)).toEqual(['Z1 × close: not applicable without its reason'])
    expect(registryFaults(cardless, WITNESSES)).toEqual(['Z6 × update: a gap names the card that closes it'])
  })

  it('a gap cell that passes is red until its row is struck', async () => {
    const passing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => {} } }
    const failing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => Promise.reject(new Error('launch wrote no event')) } }
    const calling: Reaches = async (_site, run) => {
      await run()
      return true
    }

    expect(await lawOutcome('Z5', 'launch', passing, calling)).toBeNull()
    expect(await lawOutcome('Z5', 'launch', passing)).toBe(`Z5-seeded: passes without calling ${sourceOf('launch')}`)
    expect(await lawOutcome('Z5', 'launch', failing)).toBe('Z5-seeded: launch wrote no event')
    expect(await lawOutcome('Z5', 'launch', {})).toBe('no witness of Z5 runs on launch')
    expect(registryFaults({ ...LAW_CELLS, Z5: { ...LAW_CELLS.Z5, launch: { witness: 'Z5-seeded' } } }, { ...WITNESSES, ...passing })).toEqual([])
  })

  const lostOrderLaw: LawId = 'Z3'
  it(`${lostOrderLaw} x intake no longer names the card that keeps the owner order across a readmission, which closed it`, () => {
    expect(LAW_CELLS[lostOrderLaw].intake).toEqual({ gap: [1779] })
    expect(gapRows().filter(({ law, node }) => law === 'Z3' && node === 'intake')).toHaveLength(1)
  })

  const laneWaitLaw: LawId = 'Z4'
  it(`${laneWaitLaw} x launch names the cards that give a card behind an open pull request a wait record and a start`, () => {
    expect(LAW_CELLS[laneWaitLaw].launch).toEqual({ gap: [CARD_WAIT_STATES, NO_HEAD_OF_LINE] })
    expect([CARD_WAIT_STATES, NO_HEAD_OF_LINE]).toEqual([1740, 1744])
    expect(gapRows().filter(({ law, node }) => law === laneWaitLaw && node === 'launch')).toHaveLength(1)
    expect(LAW_CELLS[laneWaitLaw].answer).toEqual({ gap: [1740, 1754] })
  })

  it(`${laneWaitLaw} x intake names the card that re-points the dependents of a sliced drop onto its slices`, () => {
    expect(LAW_CELLS[laneWaitLaw].intake).toEqual({ gap: [1740, 1754, SLICED_DROP_REPOINTS_DEPENDS] })
    expect(SLICED_DROP_REPOINTS_DEPENDS).toBe(1789)
    expect(LAW_CELLS[laneWaitLaw].window).toEqual({ gap: [1740, 1754] })
    expect(gapRows().filter(({ law, node }) => law === laneWaitLaw && node === 'intake')).toHaveLength(1)
  })

  const sessionLaw: LawId = 'Z1'
  it(`${sessionLaw} x review: no descendant of a finished review session is alive when its tree is removed`, async () => {
    expect(LAW_CELLS.Z1.review).toEqual({ witness: REVIEW_KEEPS_SESSION_AND_LEAVES_NO_DESCENDANT })
    expect(recordedLawGaps()[`${LAW_GAP_PREFIX}Z1:review`]).toBeUndefined()
    expect(await lawOutcome('Z1', 'review', WITNESSES)).toBeNull()
    expect(await lawOutcome('Z1', 'answer', WITNESSES)).not.toBeNull()
  })

  const stallLaw: LawId = 'Z7'
  it(`${stallLaw} x review names the card that ends the single-signal review stall kill`, async () => {
    expect(LAW_CELLS.Z7.review).toEqual({ gap: [NODE_WITNESSES_CALL_THEIR_NODE] })
    expect(NODE_WITNESSES_CALL_THEIR_NODE).toBe(1814)
    expect(gapRows().filter(({ law, node }) => law === 'Z7' && node === 'review')).toHaveLength(1)
    expect(recordedLawGaps()[`${LAW_GAP_PREFIX}Z7:review`]).toBe(1)
    expect(await lawOutcome('Z7', 'review', WITNESSES)).toBe(`${SESSION_BEAT_BESIDE_STALE_WINDOW}: passes without calling ${sourceOf('review')}`)
  })

  it('a new gap row is a ratchet break', () => {
    const recorded = recordedLawGaps()
    const added = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { gap: [1777] } } }
    const struck = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, review: { witness: 'Z2-review' } } }

    expect(recorded).toEqual(lawGapNumbers())
    expect(Object.keys(recorded)).toHaveLength(gapRows().length)
    expect(ratchetBreaks(recorded, lawGapNumbers())).toEqual([])
    expect(ratchetBreaks(recorded, lawGapNumbers(added))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z1:close grew from 0 to 1`)])
    expect(ratchetBreaks(recorded, lawGapNumbers(struck))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z2:review went down from 1 to 0`)])
  })

  describe('each law over each node', () => {
    for (const law of lawIds()) {
      for (const node of LAW_NODES) {
        const cell = LAW_CELLS[law][node]
        if ('witness' in cell) {
          it(`${law} × ${node}`, async () => {
            const witness = WITNESSES[cell.witness]

            expect(witness?.law, `${cell.witness} is not a witness of ${law}`).toBe(law)
            expect(await reachesSite(node, async () => witness!.run(node)), `${cell.witness} does not call ${sourceOf(node)}`).toBe(true)
          })
        }
        if ('gap' in cell) {
          it(gapTitle(law, node, cell.gap), async () => {
            expect(await lawOutcome(law, node, WITNESSES), `${law} × ${node} passes: strike its gap row in scripts/nodes/laws.ts and lower contract/ratchet.json in this pull request`).not.toBeNull()
          })
        }
      }
    }
  })
})
