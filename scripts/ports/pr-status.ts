import type { DatabaseSync } from 'node:sqlite'
import type { GitHubPut } from './github.js'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { CARD_STOPPED, COMMAND_EXECUTED, DECISION_RECORDED, MERGE_DONE, POLICY_DENIED, PR_OPENED, PR_STATUS_REFUSED, PR_STATUS_SET, REVIEW_RECORDED, TASK_LEASED, WITNESS_RECORDED } from '../core/events.js'
import { NODE_CURSORS } from '../core/node.js'
import { lastEventId } from '../window/operator-work.js'
import { ghApiPost } from './github.js'

export const PREFIX = '[bus:pr-status] '
export const STATUS_CURSOR = 'pr-status'
export const STATUS_BATCH = 20
export const STATUS_OFF_FILE = 'pr-status.off'
export const STATUS_CONTEXT = 'mikoshi'
export const STATUS_ACTOR = 'worker:status:bus'
export const STEP_EVENTS = [PR_OPENED, TASK_LEASED, REVIEW_RECORDED, 'card.answered', 'update.done', MERGE_DONE, CARD_STOPPED, WITNESS_RECORDED, DECISION_RECORDED, POLICY_DENIED] as const

const ALLOW_MERGE_AT = /allow-merge PR #(\d+) at ([0-9a-f]{7,40})(?![0-9a-f])/

const HEAD_IS_GONE = 422

export type StatusState = 'pending' | 'success' | 'failure'

export interface StepStatus {
  pr: number
  head: string
  step: string
  state: StatusState
  refused?: number
}

export interface StepEvent {
  id: number
  type: string
  pr: number | null
  head: string | null
  payload: string
}

export type GitHubPost = GitHubPut

export { ghApiPost }

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function stepAndState(event: StepEvent): [string, StatusState] | null {
  const payload = payloadOf(event.payload)
  switch (event.type) {
    case PR_OPENED: return ['opened', 'pending']
    case TASK_LEASED: return typeof payload.queue === 'string' ? [payload.queue, 'pending'] : null
    case REVIEW_RECORDED: return payload.verdict === 'pass' ? ['review pass', 'success'] : [`review ${String(payload.verdict ?? 'recorded')}`, 'pending']
    case 'card.answered': return ['answered', 'pending']
    case 'update.done': return ['updated', 'pending']
    case MERGE_DONE: return ['merged', 'success']
    case CARD_STOPPED: return ['stopped', 'failure']
    case WITNESS_RECORDED: return payload.verdict === 'green' ? ['witness green', 'success'] : ['witness red', 'failure']
    case DECISION_RECORDED: return [`merge allowed by the owner, D-${String(payload.decision_id)}`, 'success']
    case POLICY_DENIED: return payload.command === 'merge' && payload.refused === true ? [`merge refused: ${String(payload.reason ?? payload.rule)}`, 'failure'] : null
    default: return null
  }
}

function headOf(event: StepEvent): string | null {
  const head = event.head ?? payloadOf(event.payload).head
  return typeof head === 'string' && head !== '' ? head : null
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function isPermanentRefusal(status: number): boolean {
  return status === HEAD_IS_GONE
}

const OPEN_HEAD_STARTING_WITH = `SELECT head FROM prs WHERE pr = ? AND state = 'open' AND substr(head, 1, ?) = ?`

function withAllowedPrHead(db: DatabaseSync, event: StepEvent): StepEvent {
  const text = payloadOf(event.payload).text
  const named = typeof text === 'string' ? ALLOW_MERGE_AT.exec(text) : null
  if (named === null)
    return { ...event, pr: null }
  const pr = Number(named[1])
  const row = db.prepare(OPEN_HEAD_STARTING_WITH).get(pr, named[2]!.length, named[2]!) as { head: string } | undefined
  return row === undefined ? { ...event, pr: null } : { ...event, pr, head: row.head }
}

function withPrHead(db: DatabaseSync, event: StepEvent): StepEvent {
  if (event.type === DECISION_RECORDED)
    return withAllowedPrHead(db, event)
  if (event.type !== PR_OPENED || event.pr === null || headOf(event) !== null)
    return event
  const row = db.prepare('SELECT head FROM prs WHERE pr = ?').get(event.pr) as { head: string | null } | undefined
  return row?.head ? { ...event, head: row.head } : event
}

export function stepStatusOf(event: StepEvent): StepStatus | null {
  const step = stepAndState(event)
  const head = headOf(event)
  if (step === null || event.pr === null || head === null)
    return null
  return { pr: event.pr, head, step: step[0], state: step[1] }
}

export function statusFields(status: StepStatus): Record<string, string> {
  return { state: status.state, context: STATUS_CONTEXT, description: `${STATUS_CONTEXT}: ${status.step}` }
}

const NEXT_STEP_AFTER = `SELECT id, type, pr, head, payload FROM events WHERE legacy = 0 AND id > ? AND type IN (${STEP_EVENTS.map(() => '?').join(', ')}) ORDER BY id LIMIT 1`
const OPEN_ON_HEAD = `SELECT 1 FROM prs WHERE pr = ? AND head = ? AND state = 'open'`
const WITNESS_VERDICT_BEFORE = `SELECT 1 FROM events WHERE type = '${WITNESS_RECORDED}' AND legacy = 0 AND pr = ? AND head = ? AND id < ? LIMIT 1`

function cursorOf(db: DatabaseSync): number {
  db.prepare(`INSERT INTO ${NODE_CURSORS} (kind, event_id) VALUES (?, ?) ON CONFLICT (kind) DO NOTHING`).run(STATUS_CURSOR, lastEventId(db))
  return Number((db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = ?`).get(STATUS_CURSOR) as { event_id: number }).event_id)
}

function moveCursor(db: DatabaseSync, eventId: number): void {
  db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = ? WHERE kind = ?`).run(eventId, STATUS_CURSOR)
}

function isOnOpenHead(db: DatabaseSync, status: StepStatus): boolean {
  return db.prepare(OPEN_ON_HEAD).get(status.pr, status.head) !== undefined
}

function isWitnessLeaseAfterItsVerdict(db: DatabaseSync, event: StepEvent, status: StepStatus): boolean {
  return event.type === TASK_LEASED && status.step === 'witness' && db.prepare(WITNESS_VERDICT_BEFORE).get(status.pr, status.head, event.id) !== undefined
}

export function setStepStatuses(db: DatabaseSync, post: GitHubPost, now: () => Date = () => new Date(), batch = STATUS_BATCH): StepStatus[] {
  const set: StepStatus[] = []
  const nextStep = db.prepare(NEXT_STEP_AFTER)
  for (let event = nextStep.get(cursorOf(db), ...STEP_EVENTS) as StepEvent | undefined; event !== undefined && set.length < batch; event = nextStep.get(event.id, ...STEP_EVENTS) as StepEvent | undefined) {
    const status = stepStatusOf(withPrHead(db, event))
    if (status === null || !isOnOpenHead(db, status) || isWitnessLeaseAfterItsVerdict(db, event, status)) {
      moveCursor(db, event.id)
      continue
    }
    const endpoint = `repos/{owner}/{repo}/statuses/${status.head}`
    const response = post(endpoint, statusFields(status))
    const ts = now().toISOString()
    appendEvent(db, { ts, type: COMMAND_EXECUTED, actor: STATUS_ACTOR, cardId: null, pr: status.pr, head: status.head, dedupeKey: `${COMMAND_EXECUTED}:status:${event.id}:${ts}`, payload: { command: 'status', event_id: event.id, endpoint, status: response.status }, legacy: false })
    const refused = !isSuccess(response.status)
    if (refused && !isPermanentRefusal(response.status))
      throw new StatusRefusedForNow(`${PREFIX}PR #${status.pr} ${status.head}: GitHub answered ${response.status} to the status ${STATUS_CONTEXT}: ${status.step}; the step is not recorded and is posted again on the next run`)
    appendEvent(db, {
      ts,
      type: refused ? PR_STATUS_REFUSED : PR_STATUS_SET,
      actor: STATUS_ACTOR,
      cardId: null,
      pr: status.pr,
      head: status.head,
      dedupeKey: `${refused ? PR_STATUS_REFUSED : PR_STATUS_SET}:${event.id}`,
      payload: { event_id: event.id, step: status.step, state: status.state, status: response.status },
      legacy: false,
    })
    moveCursor(db, event.id)
    set.push(refused ? { ...status, refused: response.status } : status)
  }
  return set
}

export function statusesSwitchedOff(busPath: string): boolean {
  return existsSync(path.join(path.dirname(busPath), STATUS_OFF_FILE))
}

export class StatusRefusedForNow extends Error {}

export function statusFailureLine(error: unknown): string {
  if (error instanceof StatusRefusedForNow)
    return error.message
  return `${PREFIX}the status step broke and recorded nothing, the bus tick goes on: ${error instanceof Error ? error.message : String(error)}`
}

export function statusLine(status: StepStatus): string {
  return `${PREFIX}PR #${status.pr} ${status.head.slice(0, 7)}: ${STATUS_CONTEXT}: ${status.step} (${status.refused === undefined ? status.state : `refused ${status.refused}, recorded and passed`})`
}

function main(): number {
  const db = openBus(defaultBusPath())
  try {
    for (const status of setStepStatuses(db, ghApiPost(process.cwd())))
      console.log(statusLine(status))
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
