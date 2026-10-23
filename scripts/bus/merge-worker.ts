import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ports/github-status.js'
import type { RerunMode } from './check-catalog.js'
import type { GitHub, GitHubPut } from './github.js'
import type { Lease } from './lease.js'
import type { MergeOutcome } from './merge-executor.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED } from '../core/events.js'
import { ghStatusPublisher } from '../ports/github-status.js'
import { rerunModeOf } from './check-catalog.js'
import { defaultBusPath } from './db.js'
import { ghApi, ghApiPut } from './github.js'
import { MergeExecutor } from './merge-executor.js'
import { Node, NodeRefused, runNode } from './node.js'
import { closedByRounds, MERGE_CANDIDATES, MERGE_CANDIDATES_BEHIND, MERGE_CANDIDATES_WITHOUT_PASS, mergeCandidates, mergeDecidedPastRoundLimit } from './queue.js'
import { DRY_RUN_ACTOR } from './review-worker.js'
import { stampLogOutput } from './stamp.js'

export const LIVE_REVIEWER = 'worker:review:'
export const MERGE_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, CARD_ADMITTED, MERGE_DONE, REVIEW_RECORDED, DECISION_RECORDED, DECISIONS_IMPORTED] as const

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED, MERGE_DONE, DECISION_RECORDED, DECISIONS_IMPORTED])

export type MergeStep = MergeOutcome

export interface MergeWorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  session: string
  run: string | null
}

export interface MergeNodeParts extends MergeWorkerParts {
  mode: DetectionMode
  env: NodeJS.ProcessEnv
}

export class NoLiveVerdict extends NodeRefused {
  constructor(worker = 'merge') {
    super(`no ${REVIEW_RECORDED} written by ${LIVE_REVIEWER}<session> yet; the ${worker} worker switches on after the review worker's first live verdict`)
  }
}

export function firstLiveVerdict(db: DatabaseSync): number | null {
  const row = db.prepare(`SELECT id FROM events WHERE type = ? AND actor LIKE ? AND actor != ? ORDER BY id LIMIT 1`).get(REVIEW_RECORDED, `${LIVE_REVIEWER}%`, DRY_RUN_ACTOR) as { id: number } | undefined
  return row === undefined ? null : Number(row.id)
}

interface MergeRow {
  pr: number
  card_id: number
  head: string
}

function scoped(query: string): string {
  return `SELECT pr, card_id, head FROM (${query}) WHERE (? IS NULL OR pr = ?) AND (? IS NULL OR card_id = ?) ORDER BY pr`
}

function scopeOf(event: StoredEvent): Scope | undefined {
  if (WHOLE_QUEUE_ON.has(event.type))
    return undefined
  return { pr: event.pr ?? undefined, cardId: event.card_id ?? undefined }
}

export class MergeNode extends Node<MergeStep> {
  private readonly executor: MergeExecutor
  private readonly rerun: RerunMode

  constructor(parts: MergeNodeParts) {
    super('merge', { db: parts.db, clock: parts.clock, session: parts.session, mode: parts.mode, env: parts.env })
    this.rerun = rerunModeOf(parts.env)
    this.executor = new MergeExecutor({ db: parts.db, gitHub: parts.gitHub, put: parts.put, publish: parts.publish, clock: parts.clock, run: parts.run, rerun: this.rerun })
    this.subscribe(MERGE_ON, scopeOf)
  }

  protected override before(): void {
    if (firstLiveVerdict(this.db) === null)
      throw new NoLiveVerdict()
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    const ts = this.ts()
    const filter = [scope.pr ?? null, scope.pr ?? null, scope.cardId ?? null, scope.cardId ?? null]
    const rows = (query: string): MergeRow[] => this.db.prepare(scoped(query)).all(...filter) as unknown as MergeRow[]
    const decided = rows(MERGE_CANDIDATES_WITHOUT_PASS).filter(row => mergeDecidedPastRoundLimit(this.db, ts, row.pr, row.head) !== null)
    const behind = this.rerun === 'by-layers' ? rows(MERGE_CANDIDATES_BEHIND) : []
    return [...rows(MERGE_CANDIDATES), ...behind, ...decided]
      .filter(row => !closedByRounds(this.db, ts, 'merge', row.pr, row.head))
      .map(row => ({ queue: 'merge', cardId: row.card_id, pr: row.pr, head: row.head }))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return mergeCandidates(this.db, ts, this.rerun)
  }

  protected handle(lease: Lease): MergeStep {
    return this.executor.merge(lease)
  }

  protected override stepLine(step: MergeStep): string | null {
    if (step.kind === 'merged')
      return `${step.taskKey}: merged as ${step.commit} (${step.rule})`
    return super.stepLine(step)
  }
}

export interface MergeRun {
  busPath: string
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runMergeWorker(argv: string[], run: MergeRun): Promise<number> {
  return runNode(argv, 'merge', run.busPath, (db, mode) => new MergeNode({ db, gitHub: run.gitHub, put: run.put, publish: run.publish, clock: () => new Date(), session: run.session, run: null, mode, env: process.env }), { pause: run.pause })
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  return runMergeWorker(process.argv.slice(2), { busPath: defaultBusPath(), gitHub: ghApi(cwd), put: ghApiPut(cwd), publish: ghStatusPublisher(cwd), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
