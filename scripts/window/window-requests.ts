import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { Queue } from '../core/identifiers.js'
import type { StoredEvent } from '../core/stored.js'
import type { DryRunRecord } from '../nodes/review/dry-run-record.js'
import type { CloseOutcome, CloseRequest } from '../nodes/review/pr-close.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sliceTableItems } from '../../src/commands/intake/check.js'
import { FACTORY_MODES, isFactoryMode } from '../core/card-bodies.js'
import { appendEvent, closeOwnerWait, defaultBusPath, inTransaction, isOwnerWaitNeed, OPEN_WAIT, openBus, openOwnerWait, OWNER_WAIT_NEEDS, OWNER_WAITS } from '../core/db.js'
import { BOARD_ALARM, FACTORY_MODE, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, POLICY_DENIED, PR_OBSERVED, REQUEST_DONE, REQUEST_REFUSED, TASK_REQUEUED, WINDOW_REQUEST } from '../core/events.js'
import { cardIdOf, generationOfKey, isFullSha, prOf } from '../core/identifiers.js'
import { OWNER } from '../core/inbox.js'
import { legacyHistory } from '../core/legacy-history.js'
import { changesRoundsOf, closedByRounds, FAILURES_TO_STOP, LEASED, QUEUE_ACTOR, QUEUED, REVIEW_ROUNDS, TASK_FOLDS } from '../core/queue.js'
import { storedByKey } from '../core/stored.js'
import { cleanUpdatesOf } from '../nodes/update/update-done.js'
import { consumeOwnerWord, OWNER_WORD_NOT_FOUND, ownerChannelOf, USED_WORD } from '../owner/channel.js'
import { OWNER_SOURCE } from '../policy/decisions/decisions.js'
import { settledCards } from '../policy/decisions/read.js'
import { dryRunHoldsAt, observedHeadsOf, roundLimitDecisionOf } from '../policy/round-limit-decision.js'
import { decisionsInForceAt } from '../policy/shards.js'

export const REQUEST_KINDS = ['tree.cut', 'allow-merge', 'close-pr', 'requeue', 'mode', 'plan', 'owner.wait', 'owner.wait.close', 'decisions:add'] as const
export const PLAN_OPS: ReadonlyMap<string, string> = new Map([['open', PLAN_OPENED], ['add', PLAN_ITEM_ADDED], ['link', PLAN_ITEM_LINKED], ['remove', PLAN_ITEM_REMOVED], ['close', PLAN_CLOSED]])
const PLAN_FLAGS = ['op', 'plan', 'item', 'title', 'goal', 'file', 'card'] as const
const PLAN_FILE = `SELECT json_extract(payload, '$.plan_file') AS plan_file FROM events WHERE type = '${PLAN_OPENED}' AND legacy = 0 AND actor = 'owner' AND json_extract(payload, '$.id') = ? ORDER BY id LIMIT 1`
export const ANSWER_SOURCE = 'answer'
const DECISION_FLAGS: ReadonlyMap<string, string> = new Map([['--card', 'cards'], ['--supersedes', 'supersedes'], ['--until', 'until'], ['--from', 'from']])
export const WINDOW_ACTOR = 'worker:window:'
export const ALLOW_MERGE_UNDER = 186
export const REQUEST_RULE = 'window_request'
export const PREFIX = '[bus:request] '
export const USAGE = `usage: pnpm bus:request tree.cut --card <N> | allow-merge --pr <N> --head <sha> --dry-run <reviewer session> | close-pr --pr <N> --card <N> --reason <text> | requeue --task <task_key> | mode --set ${FACTORY_MODES.join('|')} | plan --op ${[...PLAN_OPS.keys()].join('|')} --plan <id> [--item <id>] [--title <text>] [--goal <text>] [--file <absolute plan file>] [--card <N>] | owner.wait --need ${OWNER_WAIT_NEEDS.join('|')} --text <what the owner decides> [--command <line>] [--card <N>] [--pr <N>] | owner.wait.close --id Q<N> --answer <answer> | decisions:add --from ${ANSWER_SOURCE} [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>"`

export const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
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
  closePr: (request: CloseRequest) => CloseOutcome
  closeDropped: () => CloseOutcome[]
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

const LATEST_OBSERVATION = `
  SELECT id, head, json_extract(payload, '$.state') AS state FROM events
  WHERE type = '${PR_OBSERVED}' AND legacy = 0 AND pr = ? AND head IS NOT NULL
  ORDER BY id DESC LIMIT 1
`

interface PrAsObserved {
  card_id: number | null
  head: string | null
  state: string | null
  event_id: number
}

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
  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly tools: RequestTools, private readonly ownerChannel: string = ownerChannelOf(os.homedir())) {}

  run(): RequestOutcome[] {
    const answered = pendingRequests(this.db).map(request => this.answer(request))
    this.tools.closeDropped()
    return answered
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
    const executed = this.executorOf(kind)(request, payload)
    return { kind: executed.done ? 'done' : 'refused', request, detail: executed.why }
  }

  private executorOf(kind: RequestKind): (request: number, payload: Record<string, unknown>) => Executed {
    const executors: Record<RequestKind, (request: number, payload: Record<string, unknown>) => Executed> = {
      'tree.cut': (_, payload) => this.treeCut(payload),
      'allow-merge': (_, payload) => this.allowMerge(payload),
      'close-pr': (request, payload) => this.closePr(request, payload),
      'mode': (request, payload) => this.setMode(request, payload),
      'requeue': (request, payload) => this.requeue(request, payload),
      'plan': (request, payload) => this.plan(request, payload),
      'owner.wait': (request, payload) => this.openWait(request, payload),
      'owner.wait.close': (request, payload) => this.closeWait(request, payload),
      'decisions:add': (_, payload) => this.addDecision(payload),
    }
    return executors[kind]
  }

  private addDecision(payload: Record<string, unknown>): Executed {
    const decision = text(payload.text)
    const from = text(payload.from)
    if (decision === null || from === null)
      return { done: false, why: `decisions:add needs the owner's text and --from ${ANSWER_SOURCE}` }
    if (from !== ANSWER_SOURCE)
      return { done: false, why: `decisions:add --from ${from} is not ${ANSWER_SOURCE}; a decision comes only from the owner's word that pnpm owner:say put into the owner channel, never from an owner order file` }
    const words = decision.startsWith(OWNER_SOURCE) ? decision.slice(OWNER_SOURCE.length).trim() : decision
    if (words === '')
      return { done: false, why: `decisions:add: an empty decision; the bus writes only the owner's own words` }
    const word = consumeOwnerWord(this.ownerChannel, words)
    if (word === null)
      return { done: false, why: OWNER_WORD_NOT_FOUND }
    const settled = [...settledCards(legacyHistory(this.db), cardStatesOf(this.db))].map(card => `#${card}`)
    const written = this.writtenDecision([...flagsOf('--supersedes', payload.supersedes), ...flagsOf('--card', payload.cards), ...flagsOf('--until', payload.until), ...flagsOf('--settled', settled), decision])
    const done = written.code === 0
    const fate = done ? 'used' : word.release() ? 'left unused' : `stays used though nothing was written; the owner renames ${word.file}${USED_WORD} back to ${path.basename(word.file)}`
    return { done, why: [...written.lines, `owner word ${word.file} ${fate}`].join('; ') }
  }

  private writtenDecision(args: string[]): { code: number, lines: string[] } {
    try {
      return this.tools.addDecision(args)
    }
    catch (error) {
      return { code: 1, lines: [`decisions:add failed: ${messageOf(error)}`] }
    }
  }

  private openWait(request: number, payload: Record<string, unknown>): Executed {
    const need = payload.need
    const waitText = text(payload.text)
    const command = text(payload.command)
    if (!isOwnerWaitNeed(need))
      return { done: false, why: `owner.wait names need ${JSON.stringify(need ?? null)}, not one of ${OWNER_WAIT_NEEDS.join(', ')}` }
    if (waitText === null)
      return { done: false, why: 'owner.wait names no text of what the owner decides' }
    if (need === 'command' && command === null)
      return { done: false, why: 'owner.wait --need command names no command' }
    const card = cardIdOf(payload.card)
    const pr = prOf(payload.pr)
    const id = openOwnerWait(this.db, this.clock().toISOString(), QUEUE_ACTOR, { need, text: waitText, request, ...(command === null ? {} : { command }), ...(card === null ? {} : { card }), ...(pr === null ? {} : { pr }) })
    return { done: true, why: `opened ${id}` }
  }

  private closeWait(request: number, payload: Record<string, unknown>): Executed {
    const id = text(payload.id)
    const answer = text(payload.answer)
    if (id === null || answer === null)
      return { done: false, why: 'owner.wait.close needs an id Q<N> and an answer' }
    const wait = this.db.prepare(`SELECT state FROM ${OWNER_WAITS} WHERE id = ?`).get(id) as { state: string } | undefined
    if (wait === undefined)
      return { done: false, why: `${id} is not an owner wait the bus has reduced` }
    if (wait.state !== OPEN_WAIT || !closeOwnerWait(this.db, this.clock().toISOString(), QUEUE_ACTOR, id, answer, request))
      return { done: false, why: `${id} is closed already` }
    return { done: true, why: `closed ${id}: ${answer}` }
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
    const row = this.observed(pr)
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
    const cleanUpdates = cleanUpdatesOf(this.db, pr)
    if (dryRun?.pr !== pr || !dryRunHoldsAt(dryRun.head, head, observedHeadsOf(this.db, pr), cleanUpdates))
      return { done: false, why: `the dry run ${session} is not of PR #${pr} at ${head}` }
    const decided = roundLimitDecisionOf(inForce, pr, head, cleanUpdates)
    if (decided !== null)
      return { done: false, why: `D-${decided} already allows the merge of PR #${pr} at ${head}` }
    const written = this.tools.addDecision(['--card', `#${row.card_id}`, `[owner] allow-merge PR #${pr} at ${head} · by D-${ALLOW_MERGE_UNDER}`])
    return { done: written.code === 0, why: written.lines.join('; ') }
  }

  private closePr(request: number, payload: Record<string, unknown>): Executed {
    const pr = prOf(payload.pr)
    const cardId = cardIdOf(payload.card)
    const reason = text(payload.reason)
    if (pr === null || cardId === null || reason === null)
      return { done: false, why: 'close-pr needs a pr, a card and a reason' }
    const outcome = this.tools.closePr({ attempt: `request-${request}`, pr, cardId, reason, by: 'window' })
    return { done: outcome.kind === 'closed', why: outcome.detail }
  }

  private observed(pr: number): PrAsObserved | undefined {
    const row = this.db.prepare('SELECT card_id, head, state, event_id FROM prs WHERE pr = ?').get(pr) as PrAsObserved | undefined
    const fresh = this.db.prepare(LATEST_OBSERVATION).get(pr) as { id: number, head: string, state: unknown } | undefined
    if (row === undefined || fresh === undefined || Number(fresh.id) <= Number(row.event_id))
      return row
    return { ...row, head: fresh.head, state: typeof fresh.state === 'string' ? fresh.state : row.state }
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
    const after = this.db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string }
    if (after.state !== QUEUED)
      return { done: false, why: `${key} stays ${after.state}: the bus rejected its ${TASK_REQUEUED}` }
    return { done: true, why: `${key} queued again after ${BOARD_ALARM} ${alarm.id}, requeue ${requeues + 1} of ${FAILURES_TO_STOP}` }
  }

  private setMode(request: number, payload: Record<string, unknown>): Executed {
    const mode = payload.mode
    if (!isFactoryMode(mode))
      return { done: false, why: `mode names ${JSON.stringify(mode ?? null)}, not one of ${FACTORY_MODES.join(', ')}` }
    appendEvent(this.db, { ts: this.clock().toISOString(), type: FACTORY_MODE, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${FACTORY_MODE}:request-${request}`, payload: { mode, request }, legacy: false })
    return { done: true, why: `the factory mode is ${mode}` }
  }

  private plan(request: number, payload: Record<string, unknown>): Executed {
    const type = PLAN_OPS.get(String(payload.op))
    const plan = text(payload.plan)
    if (type === undefined || plan === null)
      return { done: false, why: `plan needs --op ${[...PLAN_OPS.keys()].join('|')} and a --plan id` }
    const event = this.planEventPayload(type, plan, payload)
    if (typeof event === 'string')
      return { done: false, why: event }
    appendEvent(this.db, { ts: this.clock().toISOString(), type, actor: OWNER, cardId: cardIdOf(event.card), pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { ...event, request }, legacy: false })
    return { done: true, why: `${type} ${plan}${event.item === undefined ? '' : ` item ${String(event.item)}`}` }
  }

  private planEventPayload(type: string, plan: string, payload: Record<string, unknown>): Record<string, unknown> | string {
    const item = text(payload.item)
    const title = text(payload.title)
    if (type === PLAN_OPENED) {
      const file = text(payload.file)
      const goal = text(payload.goal)
      if (title === null || goal === null || file === null || !path.isAbsolute(file) || !existsSync(file))
        return `${type} needs a --title, a --goal and an absolute --file that exists`
      return { id: plan, title, goal, plan_file: file }
    }
    if (type === PLAN_CLOSED)
      return { plan }
    if (item === null)
      return `${type} needs an --item`
    if (type === PLAN_ITEM_REMOVED)
      return { plan, item }
    if (type === PLAN_ITEM_LINKED) {
      const card = cardIdOf(payload.card)
      return card === null ? `${type} needs a --card` : { plan, item, card }
    }
    const file = (this.db.prepare(PLAN_FILE).get(plan) as { plan_file: string } | undefined)?.plan_file
    if (file === undefined)
      return `plan ${plan} was never opened`
    if (title === null)
      return `${type} needs a --title`
    return sliceItemsOf(file).includes(item) ? { plan, item, title } : `item ${item} has no row in the slice table of ${file}`
  }

  private appendRequeue(ts: string, request: number, task: TaskRow): void {
    const plain = { queue: task.queue, cardId: task.card_id, pr: task.pr ?? undefined, head: task.head ?? undefined }
    const generation = generationOfKey(task.task_key, plain)
    const event: BusEvent = { ts, type: TASK_REQUEUED, actor: QUEUE_ACTOR, cardId: task.card_id, pr: task.pr, head: task.head, dedupeKey: `${TASK_REQUEUED}:${task.task_key}:request-${request}`, payload: { task_key: task.task_key, queue: task.queue, ...(generation === undefined ? {} : { generation }), request }, legacy: false }
    if (appendEvent(this.db, event))
      TASK_FOLDS[TASK_REQUEUED]!(this.db, storedByKey(this.db, event.dedupeKey))
  }
}

function cardStatesOf(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT card_id, state FROM cards WHERE state IS NOT NULL').all() as { card_id: number, state: string }[]
  return new Map(rows.map(row => [String(row.card_id), row.state]))
}

function flagsOf(name: string, values: unknown): string[] {
  return (Array.isArray(values) ? values : values === undefined ? [] : [values]).flatMap(value => [name, String(value)])
}

function decisionRequestOf(argv: readonly string[]): Record<string, unknown> | null {
  const fields: Record<string, string[]> = { cards: [], supersedes: [], until: [], from: [] }
  const texts: string[] = []
  for (let at = 1; at < argv.length; at += 1) {
    const field = DECISION_FLAGS.get(argv[at]!)
    if (field !== undefined && argv[at + 1] !== undefined) {
      fields[field]!.push(argv[at + 1]!)
      at += 1
    }
    else if (argv[at]!.startsWith('--')) {
      return null
    }
    else {
      texts.push(argv[at]!)
    }
  }
  const { cards, supersedes, until, from } = fields
  if (texts.length !== 1 || from!.length !== 1 || until!.length > 1)
    return null
  return { kind: 'decisions:add', text: texts[0], from: from![0], cards, supersedes, ...(until!.length === 0 ? {} : { until: until![0] }) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sliceItemsOf(file: string): string[] {
  return existsSync(file) ? sliceTableItems(readFileSync(file, 'utf8')) : []
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
  if (kind === 'close-pr') {
    const pr = prOf(Number(flag(argv, '--pr')))
    const card = cardIdOf(flag(argv, '--card'))
    const reason = flag(argv, '--reason')
    return pr === null || card === null || reason === undefined ? null : { kind, pr, card, reason }
  }
  if (kind === 'requeue') {
    const task = flag(argv, '--task')
    return task === undefined ? null : { kind, task_key: task }
  }
  if (kind === 'mode') {
    const mode = flag(argv, '--set')
    return isFactoryMode(mode) ? { kind, mode } : null
  }
  if (kind === 'owner.wait') {
    const need = flag(argv, '--need')
    const waitText = flag(argv, '--text')
    const fields = { command: flag(argv, '--command'), card: cardIdOf(flag(argv, '--card')) ?? undefined, pr: prOf(Number(flag(argv, '--pr'))) ?? undefined }
    return !isOwnerWaitNeed(need) || waitText === undefined ? null : { kind, need, text: waitText, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
  }
  if (kind === 'owner.wait.close') {
    const id = flag(argv, '--id')
    const answer = flag(argv, '--answer')
    return id === undefined || answer === undefined ? null : { kind, id, answer }
  }
  if (kind === 'decisions:add')
    return decisionRequestOf(argv)
  if (kind === 'plan') {
    const given = PLAN_FLAGS.flatMap(name => flag(argv, `--${name}`) === undefined ? [] : [[name, flag(argv, `--${name}`)] as const])
    return { kind, ...Object.fromEntries(given) }
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

export function requestSession(env: NodeJS.ProcessEnv): string {
  return text(env[SESSION_VARIABLE]) ?? BY_HAND
}

export function requestActor(env: NodeJS.ProcessEnv): string {
  return `${WINDOW_ACTOR}${requestSession(env)}`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openBus(defaultBusPath())
  try {
    process.exitCode = runRequest(process.argv.slice(2), db, new Date(), requestSession(process.env), line => console.log(line))
  }
  finally {
    db.close()
  }
}
