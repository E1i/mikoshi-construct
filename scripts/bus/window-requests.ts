import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { DryRunRecord } from './dry-run-record.js'
import type { Queue } from './identifiers.js'
import type { StoredEvent } from './stored.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { cardIdOf, generationOfKey, isFullSha, prOf } from './identifiers.js'
import { POLICY_DENIED } from './inbox.js'
import { BOARD_ALARM, changesRoundsOf, closedByRounds, FAILURES_TO_STOP, LEASED, QUEUE_ACTOR, QUEUED, REVIEW_ROUNDS, TASK_FOLDS, TASK_REQUEUED } from './queue.js'
import { roundLimitDecisionOf } from './round-limit-decision.js'
import { decisionsInForceAt } from './shards.js'
import { storedByKey } from './stored.js'
import { cleanUpdatesOf } from './update-done.js'

export const WINDOW_REQUEST = 'window.request'
export const REQUEST_DONE = 'window.request.done'
export const REQUEST_REFUSED = 'window.request.refused'
export const REQUEST_KINDS = ['tree.cut', 'allow-merge', 'requeue'] as const
export const WINDOW_ACTOR = 'worker:window:'
export const ALLOW_MERGE_UNDER = 186
export const REQUEST_RULE = 'window_request'
export const PREFIX = '[bus:request] '
export const USAGE = `usage: pnpm bus:request tree.cut --card <N> | allow-merge --pr <N> --head <sha> --dry-run <reviewer session> | requeue --task <task_key>`

const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const BY_HAND = 'by-hand'

export type RequestKind = typeof REQUEST_KINDS[number]

export interface CardTask {
  taskKey: string
  cardId: number
}

export interface RequestTools {
  treeOf: (cardId: number) => string
  exists: (dir: string) => boolean
  cutTree: (branch: string, cardLine: string) => void
  dryRunOf: (session: string) => DryRunRecord | null
  addDecision: (args: string[]) => { code: number, lines: string[] }
  causeHolds: (task: CardTask) => string | null
}

export type RequestOutcome
  = | { kind: 'done', request: number, detail: string }
    | { kind: 'refused', request: number, detail: string }
    | { kind: 'owner', request: number, detail: string }

interface Executed {
  done: boolean
  why: string
}

interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
  state: string
}

const PENDING = `
  SELECT id, ts, type, actor, card_id, pr, head, dedupe_key, payload FROM events AS request
  WHERE request.type = '${WINDOW_REQUEST}' AND request.legacy = 0
    AND NOT EXISTS (SELECT 1 FROM events AS answer WHERE answer.dedupe_key = '${WINDOW_REQUEST}:' || request.id || ':answered')
  ORDER BY request.id
`

const LAST_ALARM = `SELECT id FROM events WHERE type = '${BOARD_ALARM}' AND json_extract(payload, '$.task_key') = ? ORDER BY id DESC LIMIT 1`

const REQUEUES_SINCE = `
  SELECT count(*) AS n FROM events
  WHERE type = '${TASK_REQUEUED}' AND id > ? AND json_extract(payload, '$.task_key') = ? AND json_type(payload, '$.request') = 'integer'
`

export function isRequestKind(kind: unknown): kind is RequestKind {
  return typeof kind === 'string' && (REQUEST_KINDS as readonly string[]).includes(kind)
}

export function requestFromWindow(db: DatabaseSync, ts: string, session: string, request: Record<string, unknown>): number {
  const dedupeKey = `${WINDOW_REQUEST}:${session}:${ts}:${randomUUID()}`
  const cardId = cardIdOf(request.card)
  const pr = prOf(request.pr)
  const head = isFullSha(request.head) ? request.head : null
  appendEvent(db, { ts, type: WINDOW_REQUEST, actor: `${WINDOW_ACTOR}${session}`, cardId, pr, head, dedupeKey, payload: request, legacy: false })
  return storedByKey(db, dedupeKey).id
}

export function pendingRequests(db: DatabaseSync): StoredEvent[] {
  return db.prepare(PENDING).all() as unknown as StoredEvent[]
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export class WindowRequests {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly tools: RequestTools) {}

  run(): RequestOutcome[] {
    return pendingRequests(this.db).map(request => this.answer(request))
  }

  private answer(request: StoredEvent): RequestOutcome {
    const payload = JSON.parse(request.payload) as Record<string, unknown>
    const outcome = this.execute(request.id, payload)
    const ts = this.clock().toISOString()
    inTransaction(this.db, () => {
      const type = outcome.kind === 'done' ? REQUEST_DONE : REQUEST_REFUSED
      appendEvent(this.db, { ts, type, actor: QUEUE_ACTOR, cardId: request.card_id, pr: request.pr, head: request.head, dedupeKey: `${WINDOW_REQUEST}:${request.id}:answered`, payload: { request: request.id, kind: payload.kind ?? null, detail: outcome.detail, ...(outcome.kind === 'owner' ? { owner: true } : {}) }, legacy: false })
      if (outcome.kind === 'owner')
        appendEvent(this.db, { ts, type: POLICY_DENIED, actor: QUEUE_ACTOR, cardId: request.card_id, pr: request.pr, head: request.head, dedupeKey: `${POLICY_DENIED}:${WINDOW_REQUEST}:${request.id}`, payload: { kind: 'authority', rule: REQUEST_RULE, command: `${WINDOW_REQUEST} ${String(payload.kind)}`, detail: outcome.detail }, legacy: false })
    })
    return outcome
  }

  private execute(request: number, payload: Record<string, unknown>): RequestOutcome {
    const kind = payload.kind
    if (!isRequestKind(kind))
      return { kind: 'owner', request, detail: `the window asked for ${JSON.stringify(kind ?? null)}, not one of ${REQUEST_KINDS.join(', ')}; refused, the owner decides` }
    const executed = kind === 'tree.cut' ? this.treeCut(payload) : kind === 'allow-merge' ? this.allowMerge(payload) : this.requeue(request, payload)
    return { kind: executed.done ? 'done' : 'refused', request, detail: executed.why }
  }

  private treeCut(payload: Record<string, unknown>): Executed {
    const cardId = cardIdOf(payload.card)
    if (cardId === null)
      return { done: false, why: 'tree.cut names no card' }
    const body = this.db.prepare('SELECT card_line, branch FROM card_bodies WHERE card_id = ?').get(cardId) as { card_line: string | null, branch: string | null } | undefined
    const cardLine = text(body?.card_line)
    const branch = text(body?.branch)
    if (cardLine === null || branch === null)
      return { done: false, why: `card #${cardId} has no admitted card line and branch in card_bodies` }
    const tree = this.tools.treeOf(cardId)
    if (this.tools.exists(tree))
      return { done: false, why: `${tree} already exists` }
    try {
      this.tools.cutTree(branch, cardLine)
    }
    catch (error) {
      return { done: false, why: `task:start ${branch} for card #${cardId} failed: ${messageOf(error)}` }
    }
    return this.tools.exists(tree) ? { done: true, why: `cut ${tree} on ${branch}` } : { done: false, why: `task:start ${branch} for card #${cardId} left no tree at ${tree}` }
  }

  private allowMerge(payload: Record<string, unknown>): Executed {
    const pr = prOf(payload.pr)
    const head = isFullSha(payload.head) ? payload.head : null
    const session = text(payload.dry_run)
    if (pr === null || head === null || session === null)
      return { done: false, why: 'allow-merge needs a pr, a full head sha and the reviewer session of its dry run' }
    const now = this.clock()
    const inForce = decisionsInForceAt(this.db, now)
    if (!inForce.some(decision => decision.decisionId === ALLOW_MERGE_UNDER))
      return { done: false, why: `D-${ALLOW_MERGE_UNDER} is not in force` }
    const row = this.db.prepare('SELECT card_id, head, state FROM prs WHERE pr = ?').get(pr) as { card_id: number | null, head: string | null, state: string | null } | undefined
    if (row?.state !== 'open')
      return { done: false, why: `PR #${pr} is not open` }
    if (row.card_id === null)
      return { done: false, why: `PR #${pr} names no card; the version pull request stays the owner's` }
    if (row.head !== head)
      return { done: false, why: `PR #${pr} is at ${row.head ?? 'no head'}, not ${head}` }
    const rounds = changesRoundsOf(this.db, pr)
    if (rounds < REVIEW_ROUNDS)
      return { done: false, why: `PR #${pr} has ${rounds} of ${REVIEW_ROUNDS} review rounds, not past the round limit` }
    const dryRun = this.tools.dryRunOf(session)
    if (dryRun?.pr !== pr || dryRun.head !== head)
      return { done: false, why: `the dry run ${session} is not of PR #${pr} at ${head}` }
    const decided = roundLimitDecisionOf(inForce, pr, head, cleanUpdatesOf(this.db, pr))
    if (decided !== null)
      return { done: false, why: `D-${decided} already allows the merge of PR #${pr} at ${head}` }
    const written = this.tools.addDecision(['--card', `#${row.card_id}`, `[owner] allow-merge PR #${pr} at ${head} · by D-${ALLOW_MERGE_UNDER}`])
    return { done: written.code === 0, why: written.lines.join('; ') }
  }

  private requeue(request: number, payload: Record<string, unknown>): Executed {
    const key = text(payload.task_key)
    if (key === null)
      return { done: false, why: 'requeue names no task_key' }
    const alarm = this.db.prepare(LAST_ALARM).get(key) as { id: number } | undefined
    if (alarm === undefined)
      return { done: false, why: `no ${BOARD_ALARM} names ${key}` }
    const task = this.db.prepare('SELECT task_key, queue, card_id, pr, head, state FROM tasks WHERE task_key = ?').get(key) as TaskRow | undefined
    if (task === undefined)
      return { done: false, why: `${key} is not a task` }
    if (task.state === QUEUED || task.state === LEASED)
      return { done: false, why: `${key} is ${task.state} already` }
    if (task.pr !== null) {
      const pr = this.db.prepare('SELECT state, head FROM prs WHERE pr = ?').get(task.pr) as { state: string | null, head: string | null } | undefined
      if (pr?.state !== 'open' || pr.head !== task.head)
        return { done: false, why: `PR #${task.pr} is not open at ${task.head ?? 'its head'}; a task of its current head is derived anew` }
    }
    const ts = this.clock().toISOString()
    if (closedByRounds(this.db, ts, task.queue, task.pr, task.head))
      return { done: false, why: `PR #${task.pr} is past the review round limit of D-104` }
    const requeues = Number((this.db.prepare(REQUEUES_SINCE).get(alarm.id, key) as { n: number }).n)
    if (requeues >= FAILURES_TO_STOP)
      return { done: false, why: `${key} was requeued ${requeues} times since ${BOARD_ALARM} ${alarm.id}, the D-104 limit` }
    const holds = this.tools.causeHolds({ taskKey: key, cardId: task.card_id })
    if (holds !== null)
      return { done: false, why: `the cause of ${BOARD_ALARM} ${alarm.id} holds: ${holds}` }
    try {
      inTransaction(this.db, () => this.appendRequeue(ts, request, task))
    }
    catch (error) {
      return { done: false, why: messageOf(error) }
    }
    return { done: true, why: `${key} queued again after ${BOARD_ALARM} ${alarm.id}, requeue ${requeues + 1} of ${FAILURES_TO_STOP}` }
  }

  private appendRequeue(ts: string, request: number, task: TaskRow): void {
    const plain = { queue: task.queue, cardId: task.card_id, pr: task.pr ?? undefined, head: task.head ?? undefined }
    const generation = generationOfKey(task.task_key, plain)
    const event: BusEvent = { ts, type: TASK_REQUEUED, actor: QUEUE_ACTOR, cardId: task.card_id, pr: task.pr, head: task.head, dedupeKey: `${TASK_REQUEUED}:${task.task_key}:request-${request}`, payload: { task_key: task.task_key, queue: task.queue, ...(generation === undefined ? {} : { generation }), request }, legacy: false }
    if (appendEvent(this.db, event))
      TASK_FOLDS[TASK_REQUEUED]!(this.db, storedByKey(this.db, event.dedupeKey))
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

export function requestOf(argv: readonly string[]): Record<string, unknown> | null {
  const kind = argv[0]
  if (kind === undefined || kind.startsWith('--'))
    return null
  if (kind === 'tree.cut') {
    const card = cardIdOf(flag(argv, '--card'))
    return card === null ? null : { kind, card }
  }
  if (kind === 'allow-merge') {
    const pr = prOf(Number(flag(argv, '--pr')))
    const head = flag(argv, '--head')
    const dryRun = flag(argv, '--dry-run')
    return pr === null || !isFullSha(head) || dryRun === undefined ? null : { kind, pr, head, dry_run: dryRun }
  }
  if (kind === 'requeue') {
    const task = flag(argv, '--task')
    return task === undefined ? null : { kind, task_key: task }
  }
  return { kind }
}

export function runRequest(argv: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void): number {
  const request = requestOf(argv)
  if (request === null) {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  const id = requestFromWindow(db, now.toISOString(), session, request)
  out(`${PREFIX}${WINDOW_REQUEST} ${id} (${String(request.kind)}) written; bus:run answers it with ${REQUEST_DONE} or ${REQUEST_REFUSED} on its next tick`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openBus(defaultBusPath())
  try {
    process.exitCode = runRequest(process.argv.slice(2), db, new Date(), text(process.env[SESSION_VARIABLE]) ?? BY_HAND, line => console.log(line))
  }
  finally {
    db.close()
  }
}
