import type { DatabaseSync } from 'node:sqlite'
import type { GhResponse } from './github.js'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { MERGE_DONE, PR_OPENED, REVIEW_RECORDED } from './card-automaton.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { parseIncluded } from './github.js'
import { CARD_STOPPED } from './inbox.js'
import { TASK_LEASED } from './lease.js'

export const PREFIX = '[bus:pr-status] '
export const PR_STATUS_SET = 'pr.status.set'
export const PR_STATUS_REFUSED = 'pr.status.refused'
export const STATUS_CONTEXT = 'mikoshi'
export const STATUS_ACTOR = 'worker:status:bus'
export const STEP_EVENTS = [PR_OPENED, TASK_LEASED, REVIEW_RECORDED, 'card.answered', 'update.done', MERGE_DONE, CARD_STOPPED] as const

const GH_TIMEOUT_MS = 20_000
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

export type GitHubPost = (endpoint: string, fields: Record<string, string>) => GhResponse

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

function withPrHead(db: DatabaseSync, event: StepEvent): StepEvent {
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

const LAST_SET = `SELECT payload FROM events WHERE type IN ('${PR_STATUS_SET}', '${PR_STATUS_REFUSED}') ORDER BY id DESC LIMIT 1`
const STEPS_AFTER = `SELECT id, type, pr, head, payload FROM events WHERE legacy = 0 AND id > ? AND type IN (${STEP_EVENTS.map(() => '?').join(', ')}) ORDER BY id`

function cursorOf(db: DatabaseSync): number {
  const row = db.prepare(LAST_SET).get() as { payload: string } | undefined
  const through = row === undefined ? 0 : Number(payloadOf(row.payload).event_id)
  return Number.isInteger(through) ? through : 0
}

export function setStepStatuses(db: DatabaseSync, post: GitHubPost, now: () => Date = () => new Date()): StepStatus[] {
  const events = db.prepare(STEPS_AFTER).all(cursorOf(db), ...STEP_EVENTS) as unknown as StepEvent[]
  const set: StepStatus[] = []
  for (const event of events) {
    const status = stepStatusOf(withPrHead(db, event))
    if (status === null)
      continue
    const response = post(`repos/{owner}/{repo}/statuses/${status.head}`, statusFields(status))
    const refused = !isSuccess(response.status)
    if (refused && !isPermanentRefusal(response.status))
      throw new Error(`${PREFIX}PR #${status.pr} ${status.head}: GitHub answered ${response.status} to the status ${STATUS_CONTEXT}: ${status.step}; nothing recorded, the step is posted again on the next run`)
    appendEvent(db, {
      ts: now().toISOString(),
      type: refused ? PR_STATUS_REFUSED : PR_STATUS_SET,
      actor: STATUS_ACTOR,
      cardId: null,
      pr: status.pr,
      head: status.head,
      dedupeKey: `${refused ? PR_STATUS_REFUSED : PR_STATUS_SET}:${event.id}`,
      payload: { event_id: event.id, step: status.step, state: status.state, status: response.status },
      legacy: false,
    })
    set.push(refused ? { ...status, refused: response.status } : status)
  }
  return set
}

export function ghApiPost(cwd: string, command = 'gh'): GitHubPost {
  return (endpoint, fields) => {
    const args = ['api', '--include', '--method', 'POST', endpoint, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])]
    const run = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL' })
    if (run.error !== undefined)
      throw run.error
    if (run.stdout.trim() === '')
      throw new Error(`gh api ${endpoint} printed nothing: ${run.stderr.trim()}`)
    return parseIncluded(run.stdout)
  }
}

function main(): number {
  const db = openBus(defaultBusPath())
  try {
    for (const status of setStepStatuses(db, ghApiPost(process.cwd())))
      console.log(`${PREFIX}PR #${status.pr} ${status.head.slice(0, 7)}: ${STATUS_CONTEXT}: ${status.step} (${status.refused === undefined ? status.state : `refused ${status.refused}, recorded and passed`})`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
