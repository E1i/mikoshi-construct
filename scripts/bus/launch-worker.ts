import type { DatabaseSync } from 'node:sqlite'
import type { IsolationReader } from '../ghosts/isolation.js'
import type { ProcessTable } from './chain-process.js'
import type { LadderSteps } from './ladder-starter.js'
import type { Contour } from './launch-candidates.js'
import type { CardStarter, LaunchOutcome, StartedCard } from './launch-executor.js'
import type { StarterPorts } from './launch-starter.js'
import type { Lease } from './lease.js'
import type { DetectionMode } from './node.js'
import type { QueuedTask } from './queue.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultParking } from '../ghosts/handoff-check.js'
import { commandWords, realIsolationReader } from '../ghosts/isolation.js'
import { sessionEnv } from '../ghosts/session.js'
import { reviewOf } from '../ghosts/verdict.js'
import { taskWorktree, worktreeHome } from '../ghosts/worktree-home.js'
import { briefBody, briefPathOf, ladderStep, reviewBody, tasksFilePathOf, tasksFileText } from '../shift/ladder.js'
import { GHOST_JOURNAL } from '../shift/places.js'
import { renderPrompt } from '../shift/prompt.js'
import { NOT_A_BACKFILL } from './backfill-source.js'
import { GHOST_ROW, MERGE_DONE, PR_OPENED, RUNNING_CARD } from './card-automaton.js'
import { launchProcess, REAL_PROCESSES } from './chain-process.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { heartbeatEnv } from './heartbeat.js'
import { journalPath } from './import.js'
import { CARD_STARTED, CARD_STOPPED } from './inbox.js'
import { LadderCardStarter } from './ladder-starter.js'
import { CARD_ADMITTED, CARD_CLOSED } from './launch-candidates.js'
import { LaunchExecutor } from './launch-executor.js'
import { cardCommand, killQuietly, psPgid, ShiftCardStarter, spawnDetached, treePrCommand } from './launch-starter.js'
import { LEGACY_REASON, WITHDRAW_LEGACY_FLAG, withdrawLegacyLaunchTasks } from './launch-withdraw.js'
import { TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_RELEASED } from './lease.js'
import { Node, prefixOf, runNode } from './node.js'
import { PR_CLOSED } from './observations.js'
import { PR_OBSERVED } from './operator-work.js'
import { promptsDirOf } from './prompt-store.js'
import { launchTasks, TASK_ENQUEUED, TASK_REQUEUED, TASK_SUPERSEDED } from './queue.js'
import { REDUCED } from './reducer.js'

export const PREFIX = prefixOf('launch')
export const LAUNCH_DIR = 'launch'

export const LAUNCH_LIMIT_MINUTES = 600

const LAUNCH_LIMIT_MS = LAUNCH_LIMIT_MINUTES * 60_000

const LEGACY_MERGE = 'merge'
const LEGACY_PATH = 'path'

export const LAUNCH_ON = [CARD_ADMITTED, CARD_STARTED, CARD_CLOSED, CARD_STOPPED, PR_CLOSED, PR_OBSERVED, PR_OPENED, LEGACY_MERGE, LEGACY_PATH, TASK_ENQUEUED, TASK_REQUEUED, TASK_COMPLETED, TASK_FAILED, TASK_SUPERSEDED, TASK_RELEASED, TASK_EXPIRED, MERGE_DONE, GHOST_ROW, REDUCED] as const

export type LaunchStep = LaunchOutcome

export interface LaunchNodeParts {
  db: DatabaseSync
  starter: CardStarter
  ladder?: CardStarter
  clock: () => Date
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  processes?: ProcessTable
  resulted?: (card: StartedCard, start: SessionStart) => boolean
  isolation: IsolationReader
  prompts?: string
}

export interface SessionStart {
  cardId: number
  ts: string
}

interface RunningStart {
  id: number
  card_id: number
  ts: string
  dedupe_key: string
  payload: string
}

const RUNNING_STARTS = `
  SELECT e.id, e.card_id, e.ts, e.dedupe_key, e.payload FROM cards AS c
  JOIN events AS e ON e.card_id = c.card_id AND e.type = '${CARD_STARTED}' AND e.legacy = 0
    AND e.id = (SELECT MAX(id) FROM events WHERE card_id = c.card_id AND type = '${CARD_STARTED}' AND legacy = 0)
  WHERE c.state = '${RUNNING_CARD}'
  ORDER BY c.card_id
`

const STOPPED_SINCE = `SELECT 1 FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id = ? AND id > ? LIMIT 1`

export const SESSION_DEATH_CAP = 3

const SESSION_DEATHS = `SELECT count(*) AS n FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id = ? AND dedupe_key LIKE '${CARD_STOPPED}:session-end:%'`

const GHOST_ROW_SINCE = `SELECT 1 FROM events WHERE type = '${GHOST_ROW}' AND card_id = ? AND id > ? LIMIT 1`

export const SESSIONLESS_LADDER_STEP = 'launch'

const LATEST_ADMISSION = `SELECT payload FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id = ? AND ${NOT_A_BACKFILL} ORDER BY id DESC LIMIT 1`

function startedCardOf(payload: string): StartedCard | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const { session, worktree, branch, base, pid, pgid, contour, step } = parsed
    if (typeof session !== 'string' || typeof worktree !== 'string' || typeof branch !== 'string' || typeof base !== 'string' || typeof pid !== 'number' || typeof pgid !== 'number')
      return null
    if (contour !== 'cheap' && contour !== 'ladder')
      return null
    return { session, worktree, branch, base, pid, pgid, contour, ...(typeof step === 'string' ? { step } : {}) }
  }
  catch {
    return null
  }
}

export class LaunchNode extends Node<LaunchStep> {
  private readonly executor: LaunchExecutor
  private readonly starters: Partial<Record<Contour, CardStarter>>
  private readonly processes: ProcessTable

  constructor(private readonly launchParts: LaunchNodeParts) {
    super('launch', { db: launchParts.db, clock: launchParts.clock, session: launchParts.session, mode: launchParts.mode, env: launchParts.env })
    this.executor = new LaunchExecutor(launchParts)
    this.starters = { cheap: launchParts.starter, ladder: launchParts.ladder }
    this.processes = launchParts.processes ?? REAL_PROCESSES
    this.subscribe(LAUNCH_ON, event => this.detectOn(event))
  }

  stopOverdue(): number[] {
    const stopped: number[] = []
    if (this.parts.mode !== 'live')
      return stopped
    for (const start of this.db.prepare(RUNNING_STARTS).all() as unknown as RunningStart[]) {
      const card = startedCardOf(start.payload)
      if (card === null)
        continue
      if (this.endedWithoutResult(start, card)) {
        if (this.db.prepare(STOPPED_SINCE).get(start.card_id, start.id) === undefined && this.stopEnded(start, card))
          stopped.push(start.card_id)
        continue
      }
      if (this.parts.clock().getTime() - Date.parse(start.ts) < LAUNCH_LIMIT_MS)
        continue
      if (launchProcess({ pgid: card.pgid, session: card.session }, this.processes) !== 'live')
        continue
      this.starters[card.contour]?.stop(card)
      if (launchProcess({ pgid: card.pgid, session: card.session }, this.processes) !== 'gone')
        continue
      const detail = `time-limit: card #${start.card_id} ran past ${LAUNCH_LIMIT_MINUTES} minutes since ${start.ts}`
      const recorded = appendEvent(this.db, { ts: this.ts(), type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:time-limit:${start.dedupe_key}`, payload: { reason: 'fault', detail }, legacy: false })
      if (recorded)
        stopped.push(start.card_id)
    }
    return stopped
  }

  private endedWithoutResult(start: RunningStart, card: StartedCard): boolean {
    if (card.step === SESSIONLESS_LADDER_STEP || launchProcess({ pgid: card.pgid, session: card.session }, this.processes) !== 'gone')
      return false
    if (this.db.prepare(GHOST_ROW_SINCE).get(start.card_id, start.id) !== undefined)
      return false
    return !(this.launchParts.resulted?.(card, { cardId: start.card_id, ts: start.ts }) ?? false)
  }

  private stopEnded(start: RunningStart, card: StartedCard): boolean {
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string } | undefined
    const deaths = Number((this.db.prepare(SESSION_DEATHS).get(start.card_id) as { n: number }).n) + 1
    const final = deaths >= SESSION_DEATH_CAP
    const ended = `session-end: card #${start.card_id} session ${card.session} ended with no pull request, commit or handoff`
    const detail = final ? `${ended}; session death ${deaths} of ${SESSION_DEATH_CAP} (D-104), the card is not queued again` : ended
    const ts = this.ts()
    const recorded = appendEvent(this.db, { ts, type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:session-end:${start.dedupe_key}`, payload: { reason: 'fault', detail }, legacy: false })
    if (recorded && !final && admitted !== undefined) {
      const { lane, decision, contour, depends } = JSON.parse(admitted.payload) as Record<string, unknown>
      const admission = `session-end:${start.dedupe_key}`
      appendEvent(this.db, { ts, type: CARD_ADMITTED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${admission}`, payload: { lane, decision, contour, depends, admission }, legacy: false })
    }
    return recorded
  }

  protected override executes(): boolean {
    return this.parts.mode === 'live'
  }

  protected candidates(): QueuedTask[] {
    return launchTasks(this.db)
  }

  protected override derivedCandidates(): QueuedTask[] {
    return launchTasks(this.db)
  }

  protected handle(lease: Lease): LaunchStep {
    return this.executor.launch(lease)
  }

  protected override stepLine(step: LaunchStep): string | null {
    if (step.kind === 'started')
      return `${step.taskKey}: started session ${step.card.session} as pid ${step.card.pid} (its own process group) in ${step.card.worktree} on ${step.card.branch} from ${step.card.base}`
    if (step.kind === 'fenced')
      return `${step.taskKey}: the lease moved on or the card is no longer queued; nothing written`
    return super.stepLine(step)
  }
}

export interface LaunchRun {
  busPath: string
  starter: CardStarter
  ladder?: CardStarter
  session: string
  pause: (ms: number) => Promise<unknown>
  isolation: IsolationReader
  launchDir: string
}

export function runWithdrawLegacy(busPath: string, clock: () => Date): number {
  const db = openBus(busPath)
  try {
    const keys = withdrawLegacyLaunchTasks(db, clock().toISOString())
    for (const key of keys)
      console.log(`${PREFIX}${key}: withdrawn (${LEGACY_REASON}); nothing started`)
    console.log(`${PREFIX}${keys.length} withdrawn`)
    return 0
  }
  finally {
    db.close()
  }
}

export function hasCommitsAhead(card: StartedCard): boolean {
  try {
    return Number(execFileSync('git', ['-C', card.worktree, 'rev-list', '--count', `${card.base}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) > 0
  }
  catch {
    return true
  }
}

export function reportWrittenSince(launchDir: string, start: SessionStart): boolean {
  const since = Date.parse(start.ts)
  return [`report-${start.cardId}.md`, `report-${start.cardId}-brief.md`].some((file) => {
    const report = path.join(launchDir, file)
    return existsSync(report) && statSync(report).mtimeMs >= since
  })
}

export function sessionLeftAResult(launchDir: string): (card: StartedCard, start: SessionStart) => boolean {
  return (card, start) => reportWrittenSince(launchDir, start) || hasCommitsAhead(card)
}

export async function runLaunchWorker(argv: string[], run: LaunchRun): Promise<number> {
  if (argv.includes(WITHDRAW_LEGACY_FLAG))
    return runWithdrawLegacy(run.busPath, () => new Date())
  let node: LaunchNode | undefined
  const build = (db: DatabaseSync, mode: DetectionMode): LaunchNode => {
    node = new LaunchNode({ db, starter: run.starter, ladder: run.ladder, clock: () => new Date(), session: run.session, mode, env: process.env, isolation: run.isolation, resulted: sessionLeftAResult(run.launchDir), prompts: promptsDirOf(run.busPath) })
    return node
  }
  const pause = async (ms: number): Promise<unknown> => {
    node?.stopOverdue()
    return run.pause(ms)
  }
  return runNode(argv, 'launch', run.busPath, build, { pause })
}

export function realStarterPorts(repo: string, env: NodeJS.ProcessEnv, header: string, uuid: () => string): StarterPorts {
  return {
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    cut: (task, laneDir) => {
      execFileSync('pnpm', ['--silent', 'task:start', task.branch, '--card', task.card.line, '--parking', laneDir], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return taskWorktree(worktreeHome(env), String(task.card.id))
    },
    base: worktree => execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    spawnDetached,
    pgidOf: psPgid,
    kill: killQuietly,
    uuid,
    envOf: cardId => ({ ...sessionEnv(env, cardId), ...heartbeatEnv({ cardId, pr: null, head: null, queue: 'launch' }) }),
    prompt: (task, places) => renderPrompt(header, task, places),
  }
}

export function handoffLadderSteps(handoffDir: string, repo: string, env: NodeJS.ProcessEnv = process.env): LadderSteps {
  const readIfThere = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null
  return {
    stepOf: task => ladderStep({ journal: readIfThere(path.join(handoffDir, GHOST_JOURNAL)), brief: readIfThere(briefPathOf(handoffDir, task.card)) }, task.card),
    tree: (task) => {
      const tree = taskWorktree(worktreeHome(env), String(task.card.id))
      return existsSync(tree) ? tree : null
    },
    brief: task => briefPathOf(handoffDir, task.card),
    tasksFile: (task) => {
      const file = tasksFilePathOf(handoffDir, task.card)
      const text = tasksFileText(task.card, { repo, handoffDir, brief: briefPathOf(handoffDir, task.card) })
      if (existsSync(file)) {
        if (readFileSync(file, 'utf8') !== text)
          throw new Error(`${file} exists and holds another tasks file; nothing launched`)
        return file
      }
      mkdirSync(handoffDir, { recursive: true })
      writeFileSync(file, text)
      return file
    },
    body: (task, step) => {
      const brief = briefPathOf(handoffDir, task.card)
      return step === 'brief' ? briefBody(task.card, brief) : reviewBody(task.card, brief, reviewOf(task.touches))
    },
  }
}

export function launchIsolationCommand(claude: string): string[] {
  return commandWords(cardCommand(claude))
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const env = process.env
  const places = {
    parking: defaultParking(os.homedir()),
    launchDir: path.join(os.homedir(), '.construct', 'bus', LAUNCH_DIR),
    claude: 'claude',
    treePr: treePrCommand(process.cwd()),
  }
  const header = readFileSync(path.join(import.meta.dirname, '..', 'shift', 'header.md'), 'utf8')
  const ports = realStarterPorts(process.cwd(), env, header, randomUUID)
  const starter = new ShiftCardStarter(places, ports)
  const ladder = new LadderCardStarter({ ...places, repo: process.cwd() }, ports, handoffLadderSteps(path.dirname(journalPath()), process.cwd(), env))
  return runLaunchWorker(process.argv.slice(2), { busPath, starter, ladder, session: randomUUID(), pause: sleep, launchDir: places.launchDir, isolation: realIsolationReader(env, process.cwd(), launchIsolationCommand(places.claude)) })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
