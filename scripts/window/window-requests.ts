import type { DatabaseSync } from 'node:sqlite'
import type { AdmitResult } from '../../src/commands/intake/admit.js'
import type { AmendFlags } from '../../src/commands/intake/amend.js'
import type { CardAdmissionsPort, CardEventPort } from '../../src/commands/intake/index.js'
import type { QueueTaskRow as TaskRow } from '../core/card-hold.js'
import type { StoredEvent } from '../core/stored.js'
import type { AmendedStop } from '../nodes/answer/answer-executor.js'
import type { DryRunRecord } from '../nodes/review/dry-run-record.js'
import type { CloseOutcome, CloseRequest } from '../nodes/review/pr-close.js'
import type { MergeFacts, PatchedFile } from '../policy/policy.js'
import type { GitHub } from '../ports/github.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { listFlagOf, runAmend } from '../../src/commands/intake/amend.js'
import { correctionText } from '../../src/commands/intake/check.js'
import { parseTaken } from '../../src/commands/intake/numbers.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { appendCardEvent, bodyNotFoldedYet, CARD_BODIES, cardBodyText, FACTORY_MODES, isFactoryMode, laid } from '../core/card-bodies.js'
import { answersWithdrawnByAClosedHold, holdLayersOf, holdThatStays, ownerHoldGround, queueAgain } from '../core/card-hold.js'
import { appendEvent, CLOSED_WAIT, closeOwnerWait, defaultBusPath, inTransaction, isOwnerWaitNeed, OPEN_WAIT, openBus, openOwnerWait, OWNER_WAIT_NEEDS, OWNER_WAITS } from '../core/db.js'
import { messageOf } from '../core/errors.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_DROPPED, CARD_HELD, CARD_PLANNED, CARD_RELEASED, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, CARD_UNPLANNED, declaredPayload, FACTORY_MODE, NUMBERS_FOREIGN, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_OPENED, POLICY_DENIED, PR_OBSERVED, REQUEST_DONE, REQUEST_REFUSED, SHARD_DECIDED, TASK_REQUEUED, WINDOW_REQUEST, WITNESS_RECORDED } from '../core/events.js'
import { cardIdOf, isFullSha, prOf } from '../core/identifiers.js'
import { ANSWER_SOURCE, OPEN_OWNER_STOP_OF_CARD, OWNER } from '../core/inbox.js'
import { legacyHistory } from '../core/legacy-history.js'
import { changesRoundsOf, closedByRounds, FAILURES_TO_STOP, latestTurnOf, LEASED, QUEUE_ACTOR, QUEUED, REVIEW_ROUNDS } from '../core/queue.js'
import { storedByKey } from '../core/stored.js'
import { INTAKE_ACTOR_PREFIX } from '../intake/admissions.js'
import { answerToResumeAfterAmend } from '../nodes/answer/answer-executor.js'
import { openPrOfCard, ownerHoldOf } from '../nodes/answer/answer-source.js'
import { layLanes, repositoryLanes } from '../nodes/launch/lane-assign.js'
import { cleanUpdatesOf } from '../nodes/update/update-done.js'
import { consumeOwnerWord, consumeOwnerWordClosing, OWNER_WORD_NOT_FOUND, ownerChannelOf, ownerWordAwaited, USED_WORD } from '../owner/channel.js'
import { OWNER_SOURCE } from '../policy/decisions/decisions.js'
import { settledCards } from '../policy/decisions/read.js'
import { mergePolicy, OWNER_MERGES } from '../policy/policy.js'
import { dryRunHoldsAt, observedHeadsOf, roundLimitDecisionOf } from '../policy/round-limit-decision.js'
import { activeDecisionsShard, activeWindowShards, decisionsInForceAt, ownersOfAStop } from '../policy/shards.js'
import { clientAdapter } from '../ports/client/index.js'
import { ghApi } from '../ports/github.js'
import { Meter } from '../ports/meter.js'
import { MAIN_BRANCH } from '../ports/snapshot.js'
import { MAIN_REF, readReleaseVersion, VERSION_PR_REF } from '../release/changesets.js'
import { startStillOpen, windowSessionEndGround } from './window-session-end.js'

export { SESSION_VARIABLE } from '../ports/client/claude/adapter.js'

const AMEND_WITNESS_SEPARATOR = '\n'
export const HEAD_WORD = 'head'
const AT_HEAD_OF_A_PR = new RegExp(`\\bPR #(\\d+) at ${HEAD_WORD}(?![\\w-])`, 'g')
const HELD_WITHOUT_STATE = 'held'
const CARD_STATES = `
  SELECT card_id, state FROM cards WHERE state IS NOT NULL
  UNION ALL
  SELECT DISTINCT card_id, NULL FROM events WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT card_id FROM cards WHERE state IS NOT NULL)
`
const LATEST_INTAKE_ADMISSION = `SELECT id, ts, payload FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND actor LIKE '${INTAKE_ACTOR_PREFIX}%' AND card_id = ? AND json_type(payload, '$.card') = 'text' AND json_extract(payload, '$.bodySha') IS NOT NULL ORDER BY id DESC LIMIT 1`
export const REQUEST_KINDS = ['tree.cut', 'amend', 'allow-merge', 'close-pr', 'reopen-pr', 'pr.body', 'ci.rerun', 'requeue', 'mode', 'plan', 'owner.wait', 'owner.wait.close', 'decisions:add', 'hold', 'release', 'takeover', 'drop', 'numbers.foreign'] as const
export const TAKEOVER_AFTER_MINUTES = 30
export const PLAN_OPS: ReadonlyMap<string, string> = new Map([['open', PLAN_OPENED], ['add', CARD_PLANNED], ['remove', CARD_UNPLANNED], ['backfill', PLAN_BACKFILLED], ['close', PLAN_CLOSED]])
const PLAN_FLAGS = ['op', 'plan', 'title', 'goal', 'file', 'gate', 'card'] as const
const LINKED_CARDS = 'SELECT cards FROM plan_items WHERE plan_id = ? ORDER BY item_id'
const RELEASE_OPEN_IN_THE_LOG = `
  SELECT 1 FROM events AS opened
  WHERE opened.id = (SELECT min(id) FROM events WHERE type = '${PLAN_OPENED}' AND actor = '${OWNER}' AND json_extract(payload, '$.id') = ?1)
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${PLAN_CLOSED}' AND closed.actor = '${OWNER}' AND closed.id > opened.id AND json_extract(closed.payload, '$.plan') = ?1)`
export { ANSWER_SOURCE }
const DECISION_FLAGS: ReadonlyMap<string, string> = new Map([['--card', 'cards'], ['--supersedes', 'supersedes'], ['--until', 'until'], ['--from', 'from']])
export const WINDOW_ACTOR = 'worker:window:'
export const ALLOW_MERGE_RECORD = 'architecture/decisions/window-allow-merge.md'
const RULE_ACCEPTED = /^Status: accepted\b/m
export const REQUEST_RULE = 'window_request'
export const PREFIX = '[bus:request] '
export const USAGE = `usage: pnpm bus:request tree.cut --card <N> | amend --card <N> [--touches +<path>,-<path>] [--add-witness <witness>]... [--remove-witness <witness>]... [--owner-words <the owner's words>] [--depends +#<N>,-#<N>] [--priority p0|p1|p2|none] [--auto-confirm] | allow-merge --pr <N> --head <sha>|${HEAD_WORD} --dry-run <reviewer session> | close-pr|reopen-pr --pr <N> --card <N> --reason <text> | pr.body --pr <N> [--file <absolute path in the card tree>] | ci.rerun --pr <N> | requeue --task <task_key> [--keep-tree] | mode --set ${FACTORY_MODES.join('|')} | plan --op ${[...PLAN_OPS.keys()].join('|')} [--plan <id>] [--title <text>] [--goal <text>] [--file <absolute plan file>] [--gate <word>] [--card <N>] | owner.wait --need ${OWNER_WAIT_NEEDS.join('|')} --text <what the owner decides> [--command <line>] [--card <N>] [--pr <N>] | owner.wait.close --id Q<N> --answer <answer> [--from ${ANSWER_SOURCE}] | owner.wait.close --id Q<N> --from ${ANSWER_SOURCE} | decisions:add --from ${ANSWER_SOURCE} [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>" | hold --card <N> --reason <why the owner holds it> | release --card <N> | takeover --card <N> --reason <why the bus has no route for it> | drop --card <N> --reason <why a card with no body is dropped> | numbers.foreign --ids <card ids of another factory's row, comma separated>`

const BY_HAND = 'by-hand'
const noTool = (what: string): Executed => ({ done: false, why: `this bus was built with no tool to ${what}` })
const OWNER_ANSWER_USAGE = `an owner's word from the channel closes a wait with: pnpm bus:request owner.wait.close --id Q<N> --answer <the owner's word> --from ${ANSWER_SOURCE}`
export const OWNER_WORD_NEEDED = `closing an owner wait needs the owner's word from the channel or a recorded decision`
const HELP_FLAGS = ['--help', '-h']

export type RequestKind = typeof REQUEST_KINDS[number]

export interface CardTask { taskKey: string, cardId: number }

export interface RequestTools {
  treeOf: (cardId: number) => string
  exists: (dir: string) => boolean
  cutTree: (branch: string, cardLine: string) => void
  dryRunOf: (session: string) => DryRunRecord | null
  addDecision: (args: string[]) => { code: number, lines: string[] }
  causeHolds: (task: CardTask) => string | null
  closePr: (request: CloseRequest) => CloseOutcome
  closeDropped: () => CloseOutcome[]
  appendCountLine?: (pr: number, cardId: number) => Executed
  reopenPr?: (request: Omit<CloseRequest, 'by'>) => Executed
  appendBodyFile?: (attempt: string, pr: number, file: string) => Executed
  rerunCi?: (attempt: string, pr: number) => Executed
  settleDecisions?: () => void
}

export type RequestOutcome
  = | { kind: 'done', request: number, detail: string }
    | { kind: 'refused', request: number, detail: string }
    | { kind: 'owner', request: number, detail: string }

export interface Executed {
  done: boolean
  why: string
}

const PENDING = `
  SELECT id, ts, type, actor, card_id, pr, head, dedupe_key, payload FROM events AS request
  WHERE request.type = '${WINDOW_REQUEST}' AND request.legacy = 0
    AND NOT EXISTS (SELECT 1 FROM events AS answer WHERE answer.dedupe_key = '${WINDOW_REQUEST}:' || request.id || ':answered')
  ORDER BY request.id
`

const LATEST_OBSERVATION = `
  SELECT id, head, json_extract(payload, '$.state') AS state FROM events WHERE type = '${PR_OBSERVED}' AND legacy = 0 AND pr = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1
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

const MS_PER_MINUTE = 60_000

const REPO = 'repos/{owner}/{repo}'
const PULL_FILES_PAGE = 100

const UNCLOSED_QUESTION = `
  SELECT json_extract(opened.payload, '$.id') AS id FROM events AS opened
  WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0
    AND json_extract(opened.payload, '$.need') = 'decision' AND json_extract(opened.payload, '$.text') = ?
    AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.id = json_extract(opened.payload, '$.id') AND wait.state = '${CLOSED_WAIT}')
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND json_extract(closed.payload, '$.id') = json_extract(opened.payload, '$.id'))
  ORDER BY opened.id LIMIT 1
`

const ENDED_CARDS: ReadonlySet<string | null | undefined> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])

const LATEST_TURN = `SELECT id, type FROM events WHERE id = ${latestTurnOf('?')}`

const DIRTY_TREE_CAUSE = /has uncommitted changes$/

const LIVE_TASK_OF_CARD = `SELECT task_key, queue, state FROM tasks WHERE card_id = ? AND state IN ('${QUEUED}', '${LEASED}') ORDER BY id DESC LIMIT 1`

const LATEST_WITNESS_OF_CARD = `SELECT head, json_extract(payload, '$.verdict') AS verdict FROM events WHERE card_id = ? AND legacy = 0 AND type = '${WITNESS_RECORDED}' ORDER BY id DESC LIMIT 1`

const OPEN_PR_ANSWER_NEEDED = `SELECT pr FROM prs WHERE card_id = ? AND state = 'open' AND (ci = 'red' OR verdict_on_head = 'changes') ORDER BY pr DESC LIMIT 1`

const LAST_MOVE_OF_CARD = `
  SELECT ts FROM events WHERE id = (
    SELECT max(moved) FROM (
      SELECT event_id AS moved FROM tasks WHERE card_id = ? AND queue IN ('answer', 'launch')
      UNION ALL
      SELECT id AS moved FROM events WHERE card_id = ? AND legacy = 0 AND type IN ('${CARD_ADMITTED}', '${CARD_ANSWERED}', '${CARD_STARTED}', '${CARD_STOPPED}')
    )
  )
`

export function isRequestKind(kind: unknown): kind is RequestKind {
  return typeof kind === 'string' && (REQUEST_KINDS as readonly string[]).includes(kind)
}

export function requestFromWindow(db: DatabaseSync, ts: string, session: string, request: Record<string, unknown>): number {
  const dedupeKey = `${WINDOW_REQUEST}:${session}:${ts}:${randomUUID()}`
  const cardId = cardIdOf(request.card)
  const pr = prOf(request.pr)
  const head = isFullSha(request.head) ? request.head : null
  appendEvent(db, { ts, type: WINDOW_REQUEST, actor: `${WINDOW_ACTOR}${session}`, cardId, pr, head, dedupeKey, payload: declaredPayload(WINDOW_REQUEST, request), legacy: false })
  return storedByKey(db, dedupeKey).id
}

export function openWindowQuestion(db: DatabaseSync, ts: string, session: string, question: string): string {
  return inTransaction(db, () => {
    const open = db.prepare(UNCLOSED_QUESTION).get(question) as { id: string } | undefined
    if (open !== undefined)
      return open.id
    const request = requestFromWindow(db, ts, session, { kind: 'owner.wait', need: 'decision', text: question })
    const id = openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'decision', text: question, request })
    appendEvent(db, { ts, type: REQUEST_DONE, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_REQUEST}:${request}:answered`, payload: { request, kind: 'owner.wait', detail: `opened ${id}` }, legacy: false })
    return id
  })
}

export function pendingRequests(db: DatabaseSync): StoredEvent[] {
  return db.prepare(PENDING).all() as unknown as StoredEvent[]
}

function patchedFilesOfPull(meter: Meter, pr: number): PatchedFile[] {
  const files: PatchedFile[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${PULL_FILES_PAGE}&page=${page}`) as PatchedFile[]
    files.push(...listed)
    if (listed.length < PULL_FILES_PAGE)
      return files
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export class WindowRequests {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly tools: RequestTools, private readonly ownerChannel: string = ownerChannelOf(os.homedir()), private readonly releaseVersion: () => string | null = () => readReleaseVersion(), private readonly repository: string = process.cwd(), private readonly gitHub: GitHub = ghApi(repository)) {}

  run(): RequestOutcome[] {
    const answered = pendingRequests(this.db).map(request => this.answer(request))
    this.tools.closeDropped()
    this.tools.settleDecisions?.()
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
      'amend': (request, payload) => this.amend(request, payload),
      'allow-merge': (_, payload) => this.allowMerge(payload),
      'close-pr': (request, payload) => this.closeOrReopen(request, payload),
      'reopen-pr': (request, payload) => this.closeOrReopen(request, payload),
      'pr.body': (request, payload) => this.prAction(request, payload),
      'ci.rerun': (request, payload) => this.prAction(request, payload),
      'mode': (request, payload) => this.setMode(request, payload),
      'requeue': (request, payload) => this.requeue(request, payload),
      'plan': (request, payload) => this.plan(request, payload),
      'owner.wait': (request, payload) => this.openWait(request, payload),
      'owner.wait.close': (request, payload) => this.closeWait(request, payload),
      'decisions:add': (_, payload) => this.addDecision(payload),
      'hold': (request, payload) => this.holdFor(request, payload, CARD_HELD),
      'release': (request, payload) => this.holdFor(request, payload, CARD_RELEASED),
      'takeover': (request, payload) => this.takeover(request, payload),
      'drop': (request, payload) => this.drop(request, payload),
      'numbers.foreign': (request, payload) => this.recordForeignNumbers(request, payload),
    }
    return executors[kind]
  }

  private amend(request: number, payload: Record<string, unknown>): Executed {
    const cardId = cardIdOf(payload.card)
    if (cardId === null)
      return { done: false, why: 'amend names no card' }
    if (bodyNotFoldedYet(this.db, cardId))
      return { done: false, why: `#${cardId}: the bus has not folded its latest body yet; ask again on the next tick` }
    const lane = (this.db.prepare(`SELECT lane FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { lane: string | null } | undefined)?.lane ?? null
    const stop = this.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(cardId) as { id: number, payload: string } | undefined
    const result = runAmend({
      card: `#${cardId}`,
      flags: amendFlagsOf(payload),
      dir: this.repository,
      dryRun: false,
      autoConfirm: payload.auto_confirm === true,
      events: this.amendEvents(request),
      admissions: latestAdmissionOf(this.db),
      cardStates: () => new Map((this.db.prepare(CARD_STATES).all() as unknown as { card_id: number, state: string | null }[]).map(row => [String(row.card_id), row.state ?? HELD_WITHOUT_STATE])),
    }, this.clock)
    const answered = amendAnswer(cardId, result, lane)
    return stop === undefined || result.status !== 'admitted' ? answered : { done: true, why: `${answered.why}; ${this.resumeAfterAmend(request, cardId, stop, payload)}` }
  }

  private resumeAfterAmend(request: number, cardId: number, stop: AmendedStop, payload: Record<string, unknown>): string {
    const task = answerToResumeAfterAmend(this.db, cardId, stop, text(payload.touches))
    try {
      if (typeof task !== 'string')
        inTransaction(this.db, () => queueAgain(this.db, this.clock().toISOString(), task, request, `request-${request}`))
      return typeof task === 'string' ? task : `the stop ${stop.id} is settled: its answer ${task.task_key} queued again`
    }
    catch (error) {
      return `the stop ${stop.id} is settled but its answer stays: ${messageOf(error)}; card #${cardId} waits for the window's takeover`
    }
  }

  private amendEvents(request: number): CardEventPort {
    const actor = `${INTAKE_ACTOR_PREFIX}request-${request}`
    return event => inTransaction(this.db, () => {
      if (event.type !== CARD_ADMITTED) {
        appendCardEvent(this.db, actor, event)
        return
      }
      appendCardEvent(this.db, actor, laid(this.db, event))
      layLanes(this.db, repositoryLanes(this.repository)(), event.ts, actor, event.cardId)
    })
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
    const filled = this.atHeadFilled(decision)
    if (filled === null)
      return { done: false, why: `decisions:add: the decision names a PR at ${HEAD_WORD} whose head the bus has not observed, so the bus has no sha to put in` }
    const word = consumeOwnerWord(this.ownerChannel, words)
    if (word === null)
      return { done: false, why: OWNER_WORD_NOT_FOUND }
    const cardStates = new Map((this.db.prepare('SELECT card_id, state FROM cards WHERE state IS NOT NULL').all() as { card_id: number, state: string }[]).map(row => [String(row.card_id), row.state]))
    const settled = [...settledCards(legacyHistory(this.db), cardStates)].map(card => `#${card}`)
    const written = this.writtenDecision([...flagsOf('--supersedes', payload.supersedes), ...flagsOf('--card', payload.cards), ...flagsOf('--until', payload.until), ...flagsOf('--settled', settled), filled])
    const done = written.code === 0
    const fate = done ? 'used' : word.release() ? 'left unused' : unreleasedWord(word.file)
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
    const leftToTheBus = need === 'merge' ? this.mergeLeftToTheBus(pr, card) : null
    if (leftToTheBus !== null)
      return { done: false, why: leftToTheBus }
    const id = openOwnerWait(this.db, this.clock().toISOString(), QUEUE_ACTOR, { need, text: waitText, request, ...(command === null ? {} : { command }), ...(card === null ? {} : { card }), ...(pr === null ? {} : { pr }) })
    return { done: true, why: `opened ${id}` }
  }

  private mergeLeftToTheBus(pr: number | null, card: number | null): string | null {
    const shard = activeWindowShards(this.db, this.clock())[0]
    const cardId = pr === null ? null : this.observed(pr)?.card_id ?? card
    if (shard === undefined || pr === null || cardId === null)
      return null
    try {
      const verdict = mergePolicy(this.mergeFactsUnder(shard.id, cardId, pr))
      return verdict.kind === 'allowed' ? `the merge policy under the live shard ${shard.id} leaves PR #${pr} to the bus (${verdict.detail}); no owner wait opens` : null
    }
    catch {
      return null
    }
  }

  private mergeFactsUnder(windowShard: string, cardId: number, pr: number): MergeFacts {
    const meter = new Meter(this.gitHub, () => this.clock().getTime())
    const pull = meter.get(`${REPO}/pulls/${pr}`) as { title?: string, body?: string | null, head?: { ref?: string } }
    const ownerMerges = meter.get(`${REPO}/contents/${OWNER_MERGES}?ref=${MAIN_BRANCH}`) as { content?: string }
    if (typeof ownerMerges.content !== 'string')
      throw new Error(`${OWNER_MERGES} on ${MAIN_BRANCH} came back with no content`)
    const patched = patchedFilesOfPull(meter, pr)
    return {
      cardId,
      description: pull.body ?? '',
      headRef: pull.head?.ref ?? '',
      title: pull.title ?? '',
      files: patched.map(file => file.filename),
      patched,
      ownerMergesText: Buffer.from(ownerMerges.content, 'base64').toString('utf8'),
      shardActive: false,
      shardUnder: null,
      windowShard,
      decisions: decisionsInForceAt(this.db, this.clock()),
    }
  }

  private closeWait(request: number, payload: Record<string, unknown>): Executed {
    const id = text(payload.id)
    const answer = text(payload.answer)
    const from = text(payload.from)
    if (id === null || (answer === null && from === null))
      return { done: false, why: 'owner.wait.close needs an id Q<N> and an answer, or --from the owner channel' }
    if (from !== null && from !== ANSWER_SOURCE)
      return { done: false, why: `owner.wait.close --from ${from} is not ${ANSWER_SOURCE}; only the owner's word that pnpm owner:say put into the owner channel closes a wait as the owner's answer` }
    const wait = this.db.prepare(`SELECT state, card_id FROM ${OWNER_WAITS} WHERE id = ?`).get(id) as { state: string, card_id: number | null } | undefined
    if (wait === undefined)
      return { done: false, why: `${id} is not an owner wait the bus has reduced` }
    const stop = wait.card_id === null ? undefined : this.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number, payload: string } | undefined
    if (from !== null || answer === null)
      return this.closeWaitOnOwnerWord(request, id, wait, answer, stop?.id ?? null)
    const shard = stop === undefined ? null : activeDecisionsShard(this.db, this.clock())
    const question = stop === undefined ? '' : String((JSON.parse(stop.payload) as Record<string, unknown>).detail ?? '')
    const reserved = shard === null ? null : ownersOfAStop(question)
    if (reserved !== null)
      return { done: false, why: `${id} answers the card #${wait.card_id} stop ${stop!.id} on ${reserved}, which stays the owner's under any shard` }
    const ts = this.clock().toISOString()
    const closed = shard !== null && wait.state === OPEN_WAIT && inTransaction(this.db, () => {
      if (!closeOwnerWait(this.db, ts, QUEUE_ACTOR, id, answer, request))
        return false
      appendEvent(this.db, { ts, type: SHARD_DECIDED, actor: QUEUE_ACTOR, cardId: wait.card_id, pr: null, head: null, dedupeKey: `${SHARD_DECIDED}:${stop!.id}:${request}`, payload: { shard: shard.id, stop: stop!.id, wait: id, question, answer, ground: `the window's answer to ${id} under shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until})` }, legacy: false })
      return true
    })
    if (!closed)
      return { done: false, why: shard === null && wait.state === OPEN_WAIT ? `${id} stays open: ${OWNER_WORD_NEEDED}; ${OWNER_ANSWER_USAGE}` : `${id} is closed already` }
    return { done: true, why: `closed ${id} and lifted the card #${wait.card_id} stop ${stop!.id} as a decision under shard ${shard.id}: ${answer}` }
  }

  private closeWaitOnOwnerWord(request: number, id: string, wait: { state: string, card_id: number | null }, asked: string | null, stop: number | null): Executed {
    if (wait.state !== OPEN_WAIT)
      return { done: false, why: `${id} is closed already` }
    const verbatim = asked === null ? null : consumeOwnerWord(this.ownerChannel, asked)
    const word = verbatim ?? consumeOwnerWordClosing(this.ownerChannel, id)
    if (word === null)
      return { done: false, why: `${OWNER_WORD_NOT_FOUND}: ${ownerWordAwaited(id)}` }
    const answer = 'words' in word && typeof word.words === 'string' ? word.words : asked!
    const refusal = this.refusalToClose(request, id, answer)
    if (refusal !== null)
      return { done: false, why: `${refusal}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` }
    const stillOpen = this.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number } | undefined
    return { done: true, why: stop === null || stillOpen?.id === stop ? `closed ${id} on the owner's word ${word.file}: ${answer}` : `closed ${id} and lifted the card #${wait.card_id} stop ${stop} on the owner's word ${word.file}: ${answer}` }
  }

  private refusalToClose(request: number, id: string, answer: string): string | null {
    try {
      return inTransaction(this.db, () => closeOwnerWait(this.db, this.clock().toISOString(), QUEUE_ACTOR, id, answer, request)) ? null : `${id} is closed already`
    }
    catch (error) {
      return `owner.wait.close failed: ${messageOf(error)}`
    }
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
    try {
      this.tools.cutTree(branch, cardLine)
    }
    catch (error) {
      return { done: false, why: `task:start ${branch} for card #${cardId} failed: ${messageOf(error)}` }
    }
    return this.tools.exists(tree) ? { done: true, why: `cut ${tree} on ${branch}` } : { done: false, why: `task:start ${branch} for card #${cardId} left no tree at ${tree}` }
  }

  private atHeadFilled(decision: string): string | null {
    const unobserved = [...decision.matchAll(AT_HEAD_OF_A_PR)].some(match => this.observed(Number(match[1]))?.head == null)
    return unobserved ? null : decision.replace(AT_HEAD_OF_A_PR, (_, pr: string) => `PR #${pr} at ${this.observed(Number(pr))!.head!}`)
  }

  private allowMerge(payload: Record<string, unknown>): Executed {
    const pr = prOf(payload.pr)
    const atHead = payload.head === HEAD_WORD
    const session = text(payload.dry_run)
    if (pr === null || (!atHead && !isFullSha(payload.head)) || session === null)
      return { done: false, why: `allow-merge needs a pr, a full head sha or ${HEAD_WORD}, and the reviewer session of its dry run` }
    const now = this.clock()
    const inForce = decisionsInForceAt(this.db, now)
    if (!allowMergeRuleInForce(this.repository))
      return { done: false, why: `${ALLOW_MERGE_RECORD} is not in force in ${this.repository}: absent, or its status is not accepted` }
    const row = this.observed(pr)
    if (row?.state !== 'open')
      return { done: false, why: `PR #${pr} is not open` }
    if (row.card_id === null)
      return { done: false, why: `PR #${pr} names no card; the version pull request stays the owner's` }
    const head = atHead ? row.head : payload.head as string
    if (head === null || row.head !== head)
      return { done: false, why: `PR #${pr} is at ${row.head ?? 'no head'}, not ${head ?? HEAD_WORD}` }
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
    const written = this.tools.addDecision(['--card', `#${row.card_id}`, `[owner] allow-merge PR #${pr} at ${head} · by ${ALLOW_MERGE_RECORD}`])
    return { done: written.code === 0, why: written.lines.join('; ') }
  }

  private closeOrReopen(request: number, payload: Record<string, unknown>): Executed {
    const [pr, cardId, reason] = [prOf(payload.pr), cardIdOf(payload.card), text(payload.reason)]
    if (pr === null || cardId === null || reason === null)
      return { done: false, why: `${String(payload.kind)} needs a pr, a card and a reason` }
    const asked = { attempt: `request-${request}`, pr, cardId, reason }
    const closed = payload.kind === 'close-pr' ? this.tools.closePr({ ...asked, by: 'window' }) : null
    return closed === null ? this.tools.reopenPr?.(asked) ?? noTool('reopen a pull request') : { done: closed.kind === 'closed', why: closed.detail }
  }

  private prAction(request: number, payload: Record<string, unknown>): Executed {
    const [pr, file, attempt] = [prOf(payload.pr), text(payload.file), `request-${request}`]
    if (pr === null || file !== null || payload.kind === 'ci.rerun')
      return pr === null ? { done: false, why: `${String(payload.kind)} names no pr` } : (payload.kind === 'ci.rerun' ? this.tools.rerunCi?.(attempt, pr) : this.tools.appendBodyFile?.(attempt, pr, file!)) ?? noTool(`answer ${String(payload.kind)}`)
    const row = this.observed(pr)
    if (row?.state !== 'open')
      return { done: false, why: `PR #${pr} is not open` }
    if (row.card_id === null)
      return { done: false, why: `PR #${pr} names no card, so no report holds its count line` }
    return this.tools.appendCountLine?.(pr, row.card_id) ?? noTool('change a pull request body')
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
    const keepsTheTree = payload.keep_tree === true && task.queue === 'launch' && holds !== null && DIRTY_TREE_CAUSE.test(holds)
    if (holds !== null && !keepsTheTree)
      return { done: false, why: `the cause of ${BOARD_ALARM} ${alarm.id} holds: ${holds}${task.queue === 'launch' && DIRTY_TREE_CAUSE.test(holds) ? `; a requeue with keep_tree: true launches the session on that tree as it stands, writing nothing in it` : ''}` }
    try {
      inTransaction(this.db, () => queueAgain(this.db, ts, task, request, `request-${request}`))
    }
    catch (error) {
      return { done: false, why: messageOf(error) }
    }
    const after = this.db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string }
    if (after.state !== QUEUED)
      return { done: false, why: `${key} stays ${after.state}: the bus rejected its ${TASK_REQUEUED}` }
    return { done: true, why: `${key} queued again after ${BOARD_ALARM} ${alarm.id}, requeue ${requeues + 1} of ${FAILURES_TO_STOP}${keepsTheTree ? `; its session starts on the tree as it stands: ${holds}` : ''}` }
  }

  private holdFor(request: number, payload: Record<string, unknown>, type: typeof CARD_HELD | typeof CARD_RELEASED): Executed {
    const cardId = cardIdOf(payload.card)
    const reason = text(payload.reason)
    if (cardId === null || (type === CARD_HELD && reason === null))
      return { done: false, why: type === CARD_HELD ? 'hold needs a card and the reason the owner holds it' : 'release names no card' }
    const ts = this.clock().toISOString()
    const requeued = inTransaction(this.db, () => {
      const opened = holdLayersOf(this.db, cardId).opened
      appendEvent(this.db, { ts, type, actor: QUEUE_ACTOR, cardId, pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { request, ...(reason === null ? {} : { reason }) }, legacy: false })
      const withdrawn = type === CARD_RELEASED ? answersWithdrawnByAClosedHold(this.db, cardId, opened) : []
      withdrawn.forEach(task => queueAgain(this.db, ts, task, request, `request-${request}`))
      return withdrawn.map(task => task.task_key)
    })
    const stays = type === CARD_RELEASED ? holdThatStays(this.db, cardId) : null
    return { done: true, why: `${type} #${cardId}${reason === null ? '' : `: ${reason}`}${stays ?? (requeued.length === 0 ? '' : `; queued again: ${requeued.join(', ')}`)}` }
  }

  private takeover(request: number, payload: Record<string, unknown>): Executed {
    const cardId = cardIdOf(payload.card)
    const reason = text(payload.reason)
    if (cardId === null || reason === null)
      return { done: false, why: 'takeover needs a card and the reason the bus has no route for it' }
    const route = this.routeOf(cardId)
    if (route !== null)
      return { done: false, why: route }
    const sessionEnded = windowSessionEndGround(this.db, cardId)
    const ground = sessionEnded ?? ownerHoldGround(this.db, cardId) ?? this.noRouteGround(cardId)
    if (typeof ground !== 'object')
      return { done: false, why: ground }
    const ts = this.clock().toISOString()
    const actor = this.actorOf(request)
    inTransaction(this.db, () => {
      appendEvent(this.db, { ts, type: CARD_HELD, actor, cardId, pr: null, head: null, dedupeKey: `${CARD_HELD}:request-${request}`, payload: { request, reason, takeover: true }, legacy: false })
      appendEvent(this.db, { ts, type: CARD_TAKEOVER, actor, cardId, pr: null, head: null, dedupeKey: `${CARD_TAKEOVER}:request-${request}`, payload: { request, reason, ground: ground.named }, legacy: false })
    })
    return { done: true, why: `${CARD_TAKEOVER} #${cardId} (${ground.named}): ${reason}` }
  }

  private actorOf(request: number): string {
    return (this.db.prepare('SELECT actor FROM events WHERE id = ?').get(request) as { actor: string }).actor
  }

  private drop(request: number, payload: Record<string, unknown>): Executed {
    const cardId = cardIdOf(payload.card)
    const reason = text(payload.reason)
    if (cardId === null || reason === null)
      return { done: false, why: 'drop needs a card and the reason it is dropped' }
    const card = this.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined
    if (card === undefined)
      return { done: false, why: `the bus holds no card #${cardId}` }
    if (ENDED_CARDS.has(card.state))
      return { done: false, why: `card #${cardId} is ${card.state}; there is nothing to drop` }
    if (cardBodyText(this.db, cardId) !== null)
      return { done: false, why: `card #${cardId} has an admitted body; it drops with pnpm intake --move '#${cardId}' --to ${DROPPED_CARD}` }
    appendEvent(this.db, { ts: this.clock().toISOString(), type: CARD_DROPPED, actor: this.actorOf(request), cardId, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:request-${request}`, payload: { request, reason }, legacy: false })
    return { done: true, why: `${CARD_DROPPED} #${cardId}: ${reason}` }
  }

  private recordForeignNumbers(request: number, payload: Record<string, unknown>): Executed {
    const ids = foreignIdsOf(payload.ids)
    if (ids === null)
      return { done: false, why: 'numbers.foreign needs --ids, a list of positive card numbers' }
    appendEvent(this.db, { ts: this.clock().toISOString(), type: NUMBERS_FOREIGN, actor: this.actorOf(request), cardId: null, pr: null, head: null, dedupeKey: `${NUMBERS_FOREIGN}:request-${request}`, payload: { request, ids }, legacy: false })
    return { done: true, why: `${NUMBERS_FOREIGN} ${ids.map(id => `#${id}`).join(', ')}: the next card number no longer follows them` }
  }

  private routeOf(cardId: number): string | null {
    const card = this.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined
    if (ENDED_CARDS.has(card?.state))
      return `card #${cardId} is ${card!.state}; there is nothing to take over`
    const layers = holdLayersOf(this.db, cardId)
    const hold = layers.owner === null || layers.takeover !== null ? ownerHoldOf(this.db, cardId) : null
    if (hold !== null)
      return `${hold}; release it before a takeover`
    const task = this.db.prepare(LIVE_TASK_OF_CARD).get(cardId) as { task_key: string, queue: string, state: string } | undefined
    if (task !== undefined)
      return `card #${cardId} has a bus route: the ${task.queue} task ${task.task_key} is ${task.state}`
    const turn = this.latestTurn(cardId)
    if (turn?.type === CARD_STARTED && startStillOpen(this.db, cardId, turn.id))
      return `card #${cardId} has a bus route: its session started at event ${turn.id} has not ended`
    return null
  }

  private latestTurn(cardId: number): { id: number, type: string } | undefined {
    return this.db.prepare(LATEST_TURN).get(cardId) as { id: number, type: string } | undefined
  }

  private noRouteGround(cardId: number): { named: string } | string {
    const turn = this.latestTurn(cardId)
    const stop = this.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(cardId) as { id: number } | undefined
    if (stop !== undefined && stop.id === turn?.id)
      return { named: `the owner stop ${stop.id} is its latest turn and has no lift` }
    const witness = this.db.prepare(LATEST_WITNESS_OF_CARD).get(cardId) as { head: string | null, verdict: unknown } | undefined
    if (witness?.verdict === 'green' && openPrOfCard(this.db, cardId) === null)
      return { named: `its witnesses are green at ${witness.head ?? 'its head'} and it has no open pull request` }
    const answerNeeded = this.db.prepare(OPEN_PR_ANSWER_NEEDED).get(cardId) as { pr: number } | undefined
    if (turn?.type !== CARD_STOPPED && answerNeeded === undefined)
      return `card #${cardId} is in no state that needs an answer or launch task, and no stop without a lift or green witness without a pull request names it; the bus has its route`
    const moved = this.db.prepare(LAST_MOVE_OF_CARD).get(cardId, cardId) as { ts: string } | undefined
    if (moved === undefined)
      return `card #${cardId} has no recorded turn or task to measure the ${TAKEOVER_AFTER_MINUTES} minutes from; the bus has not taken it yet`
    const minutes = Math.floor((this.clock().getTime() - Date.parse(moved.ts)) / MS_PER_MINUTE)
    return minutes >= TAKEOVER_AFTER_MINUTES
      ? { named: `no answer or launch task ran for ${minutes} minutes` }
      : `card #${cardId} last moved ${minutes} minutes ago, under the ${TAKEOVER_AFTER_MINUTES} a takeover waits for an answer or launch task`
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
    if (type === undefined || (plan === null && type !== CARD_UNPLANNED))
      return { done: false, why: `plan needs --op ${[...PLAN_OPS.keys()].join('|')} and a --plan id; remove needs only the --card` }
    const event = this.planEventPayload(type, plan ?? '', payload)
    if (typeof event === 'string')
      return { done: false, why: event }
    const cardId = cardIdOf(payload.card)
    appendEvent(this.db, { ts: this.clock().toISOString(), type, actor: OWNER, cardId: type === CARD_PLANNED || type === CARD_UNPLANNED ? cardId : null, pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { ...event, request }, legacy: false })
    return { done: true, why: `${type}${plan === null ? '' : ` ${plan}`}${cardId === null ? '' : ` #${cardId}`}` }
  }

  private planEventPayload(type: string, plan: string, payload: Record<string, unknown>): Record<string, unknown> | string {
    const gate = text(payload.gate)
    if (type === PLAN_OPENED) {
      const title = text(payload.title)
      const file = text(payload.file)
      const goal = text(payload.goal)
      if (title === null || goal === null || file === null || !path.isAbsolute(file) || !existsSync(file))
        return `${type} needs a --title, a --goal and an absolute --file that exists`
      const version = this.releaseVersion()
      if (version === null)
        return `${type} could not fetch and read the version changesets will release from ${MAIN_REF} and ${VERSION_PR_REF}`
      return { id: plan, title, goal, plan_file: file, version, ...(gate === null ? {} : { gate }) }
    }
    if (type === PLAN_CLOSED)
      return { plan }
    if (type === PLAN_BACKFILLED) {
      const cards = [...new Set((this.db.prepare(LINKED_CARDS).all(plan) as { cards: string }[]).flatMap(item => JSON.parse(item.cards) as number[]))].sort((a, b) => a - b)
      if (gate === null || cards.length === 0)
        return `${type} needs a --gate and a plan whose items link cards`
      return { plan, gate, cards }
    }
    const card = cardIdOf(payload.card)
    if (card === null)
      return `${type} needs a --card`
    if (type === CARD_UNPLANNED)
      return { card }
    if (this.db.prepare(RELEASE_OPEN_IN_THE_LOG).get(plan) === undefined)
      return `${type}: release ${plan} is not open`
    return { release: plan, card }
  }
}

export function allowMergeRuleInForce(repository: string): boolean {
  const record = path.join(repository, ALLOW_MERGE_RECORD)
  return existsSync(record) && RULE_ACCEPTED.test(readFileSync(record, 'utf8'))
}

function foreignIdsOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0)
    return null
  const ids = value.map(prOf)
  return ids.includes(null) ? null : ids as number[]
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

function unreleasedWord(file: string): string {
  return `stays used though nothing was written; the owner renames ${file}${USED_WORD} back to ${path.basename(file)}`
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

function latestAdmissionOf(db: DatabaseSync): CardAdmissionsPort {
  return (cardId) => {
    const row = db.prepare(LATEST_INTAKE_ADMISSION).get(cardId) as { id: number, ts: string | null, payload: string } | undefined
    if (row === undefined)
      return null
    const { card, bodySha, confirmation, source } = JSON.parse(row.payload) as { card: string, bodySha: unknown, confirmation: unknown, source: unknown }
    const body = cardBodyText(db, cardId)
    const admission = { card, bodySha, ts: row.ts, confirmation, source, event: row.id }
    return body === null ? admission : { ...admission, text: body }
  }
}

function amendRequestOf(argv: readonly string[]): Record<string, unknown> | null {
  const card = cardIdOf(flag(argv, '--card'))
  if (card === null)
    return null
  const addWitnesses = listFlagOf(argv, 'add-witness', AMEND_WITNESS_SEPARATOR)?.split(AMEND_WITNESS_SEPARATOR)
  const removeWitnesses = listFlagOf(argv, 'remove-witness', AMEND_WITNESS_SEPARATOR)?.split(AMEND_WITNESS_SEPARATOR)
  const fields = { touches: listFlagOf(argv, 'touches'), depends: listFlagOf(argv, 'depends'), add_witness: addWitnesses, remove_witness: removeWitnesses, owner_words: flag(argv, '--owner-words'), priority: flag(argv, '--priority') }
  return { kind: 'amend', card, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), ...(argv.includes('--auto-confirm') ? { auto_confirm: true } : {}) }
}

function textList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : undefined
}

function amendFlagsOf(payload: Record<string, unknown>): AmendFlags {
  const flags = { touches: text(payload.touches), depends: text(payload.depends), ownerWords: typeof payload.owner_words === 'string' ? payload.owner_words : null, addWitnesses: textList(payload.add_witness), removeWitnesses: textList(payload.remove_witness), priority: text(payload.priority) }
  return Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== null && value !== undefined))
}

function amendAnswer(cardId: number, result: AdmitResult, lane: string | null): Executed {
  if (result.status === 'admitted' || result.status === 'alreadyAdmitted')
    return { done: true, why: `#${cardId} ${result.status === 'admitted' ? 'amended' : 'already holds this body'}, in ${lane ?? 'the lane the mode lays'}` }
  if (result.status === 'refused')
    return { done: false, why: result.why }
  if (result.status === 'invalidTestPattern' || result.status === 'sharedCodeMask')
    return { done: false, why: `#${cardId}: ${result.reasons.join('; ')}` }
  if (result.status === 'ownerWait')
    return { done: false, why: `#${cardId}: a weaker witness waits for the owner: ${result.actions.join('; ')}` }
  if (result.status === 'awaiting')
    return { done: false, why: `#${cardId}: the amend changes what intake corrects, and nothing was admitted: ${result.card.corrections.map(correctionText).join('; ')}; ask again with --auto-confirm once they are read` }
  return { done: false, why: `#${cardId}: the amend ended ${result.status}; nothing was admitted` }
}

export function requestOf(argv: readonly string[]): Record<string, unknown> | null {
  const kind = argv[0]
  if (kind === undefined || kind.startsWith('--'))
    return null
  if (kind === 'tree.cut') {
    const card = cardIdOf(flag(argv, '--card'))
    return card === null ? null : { kind, card }
  }
  if (kind === 'amend')
    return amendRequestOf(argv)
  if (kind === 'allow-merge') {
    const pr = prOf(Number(flag(argv, '--pr')))
    const head = flag(argv, '--head')
    const dryRun = flag(argv, '--dry-run')
    return pr === null || (head !== HEAD_WORD && !isFullSha(head)) || dryRun === undefined ? null : { kind, pr, head, dry_run: dryRun }
  }
  if (kind === 'close-pr' || kind === 'reopen-pr') {
    const [pr, card, reason] = [prOf(Number(flag(argv, '--pr'))), cardIdOf(flag(argv, '--card')), flag(argv, '--reason')]
    return pr === null || card === null || reason === undefined ? null : { kind, pr, card, reason }
  }
  if (kind === 'pr.body' || kind === 'ci.rerun') {
    const [pr, file] = [prOf(Number(flag(argv, '--pr'))), kind === 'pr.body' ? flag(argv, '--file') : undefined]
    return pr === null ? null : { kind, pr, ...(file === undefined ? {} : { file }) }
  }
  if (kind === 'requeue') {
    const task = flag(argv, '--task')
    return task === undefined ? null : { kind, task_key: task, ...(argv.includes('--keep-tree') ? { keep_tree: true } : {}) }
  }
  if (kind === 'mode')
    return isFactoryMode(flag(argv, '--set')) ? { kind, mode: flag(argv, '--set') } : null
  if (kind === 'owner.wait') {
    const need = flag(argv, '--need')
    const waitText = flag(argv, '--text')
    const fields = { command: flag(argv, '--command'), card: cardIdOf(flag(argv, '--card')) ?? undefined, pr: prOf(Number(flag(argv, '--pr'))) ?? undefined }
    return !isOwnerWaitNeed(need) || waitText === undefined ? null : { kind, need, text: waitText, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
  }
  if (kind === 'owner.wait.close') {
    const id = flag(argv, '--id')
    const answer = flag(argv, '--answer')
    const from = flag(argv, '--from')
    return id === undefined || (answer === undefined && from === undefined) ? null : { kind, id, ...(answer === undefined ? {} : { answer }), ...(from === undefined ? {} : { from }) }
  }
  if (kind === 'decisions:add')
    return decisionRequestOf(argv)
  if (kind === 'hold' || kind === 'release') {
    const card = cardIdOf(flag(argv, '--card'))
    const reason = flag(argv, '--reason')
    if (card === null || (kind === 'hold' && reason === undefined))
      return null
    return { kind, card, ...(reason === undefined ? {} : { reason }) }
  }
  if (kind === 'takeover' || kind === 'drop') {
    const card = cardIdOf(flag(argv, '--card'))
    const reason = flag(argv, '--reason')
    return card === null || reason === undefined ? null : { kind, card, reason }
  }
  if (kind === 'numbers.foreign') {
    const listed = parseTaken(flag(argv, '--ids') ?? '')
    const ids = listed.kind === 'taken' ? foreignIdsOf(listed.numbers) : null
    return ids === null ? null : { kind, ids }
  }
  if (kind === 'plan') {
    const given = PLAN_FLAGS.flatMap(name => flag(argv, `--${name}`) === undefined ? [] : [[name, flag(argv, `--${name}`)] as const])
    return { kind, ...Object.fromEntries(given) }
  }
  return { kind }
}

function printUsage(out: (line: string) => void): void {
  out(`${PREFIX}${USAGE}`)
  out(`${PREFIX}${OWNER_ANSWER_USAGE}`)
}

export function runRequest(argv: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void): number {
  const request = requestOf(argv)
  if (request === null) {
    printUsage(out)
    return 2
  }
  const id = requestFromWindow(db, now.toISOString(), session, request)
  out(`${PREFIX}${WINDOW_REQUEST} ${id} (${String(request.kind)}) written; bus:run answers it with ${REQUEST_DONE} or ${REQUEST_REFUSED} on its next tick`)
  return 0
}

export function requestSession(env: NodeJS.ProcessEnv): string {
  return text(clientAdapter().ownSession(env)) ?? BY_HAND
}

export function requestActor(env: NodeJS.ProcessEnv): string {
  return `${WINDOW_ACTOR}${requestSession(env)}`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.some(argument => HELP_FLAGS.includes(argument))) {
    printUsage(line => console.log(line))
  }
  else {
    const db = openBus(defaultBusPath())
    try {
      process.exitCode = runRequest(argv, db, new Date(), requestSession(process.env), line => console.log(line))
    }
    finally {
      db.close()
    }
  }
}
