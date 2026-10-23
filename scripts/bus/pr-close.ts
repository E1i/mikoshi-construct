import type { DatabaseSync } from 'node:sqlite'
import type { CardEvent } from '../../src/commands/intake/index.js'
import type { BusEvent } from './db.js'
import type { CommandResult, GhResponse, GitHub, GitHubPut } from './github.js'
import type { CloseRule, CloseVerdict } from './policy.js'
import type { Recut, RecutCard, RecutPlan } from './round-limit-decision.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { bodySha } from '../../src/commands/intake/confirm.js'
import { nextFreeNumbers } from '../../src/commands/intake/numbers.js'
import { CARD_ADMITTED, CARD_DROPPED, COMMAND_EXECUTED, OPEN_PLAN, PLAN_ITEM_LINKED, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED, PR_OPENED } from '../core/events.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'
import { DROPPED_CARD } from './card-automaton.js'
import { appendCardEvent, cardBodyText, laid } from './card-bodies.js'
import { appendEvent, inTransaction, openBusWait } from './db.js'
import { messageOf } from './errors.js'
import { OWNER } from './inbox.js'
import { leasedOn } from './lease.js'
import { CLOSE_RULES, closePolicy, RETRIED_CLOSE_RULES } from './policy.js'
import { recutCardCount, recutOf, recutPlanOf } from './round-limit-decision.js'

export const CLOSE_COMMAND = 'close'
export const CLOSE_ACTOR = 'worker:close-pr:bus'
export const CLOSE_BY = ['window', 'card.dropped', 'round-limit'] as const
const REPO = 'repos/{owner}/{repo}'
const MERGE_QUEUE = 'merge'

export type CloseBy = typeof CLOSE_BY[number]

export interface CloseRequest {
  attempt: string
  pr: number
  cardId: number
  reason: string
  by: CloseBy
}

export type CloseOutcome
  = | { kind: 'closed', pr: number, detail: string }
    | { kind: 'denied', pr: number, detail: string }
    | { kind: 'failed', pr: number, detail: string }

export interface RoundLimitAt {
  cardId: number
  pr: number
  head: string | null
  findings: readonly string[]
}

export type RecutOutcome
  = | { kind: 'recut', pr: number, cards: number[], carrier: number }
    | { kind: 'owner_wait', pr: number, wait: string, why: string }

export interface RoundLimitRecut {
  recut: (at: RoundLimitAt) => RecutOutcome
}

export type CardAdmit = (event: CardEvent) => boolean

export interface RecutParts {
  db: DatabaseSync
  gitHub: GitHub
  post: GitHubPut
  patch: GitHubPut
  clock: () => Date
  admit?: CardAdmit
}

interface PullAsRead {
  state?: unknown
  body?: unknown
  title?: unknown
  head?: { ref?: unknown }
  base?: { ref?: unknown }
}

interface Branch {
  head: string
  base: string
}

export const RECUT_SOURCE = 'round-limit-recut'
export const RECUT_ACTOR = `${INTAKE_ACTOR_PREFIX}${RECUT_SOURCE}`
const SUPERSEDED_LANE = 'superseded'
const CREATED = 201

const NUMBERS_TAKEN = 'SELECT max(card_id) AS card, max(pr) AS pr FROM events'
const LATEST_ISSUE_OR_PULL = `${REPO}/issues?state=all&sort=created&direction=desc&per_page=1`

const OPEN_PLAN_ITEMS = `
  SELECT plan_items.plan_id, plan_items.item_id, plan_items.cards FROM plan_items JOIN plans ON plans.plan_id = plan_items.plan_id
  WHERE plans.state = '${OPEN_PLAN}' ORDER BY plan_items.plan_id, plan_items.item_id
`

const ADMITTED_TEXT = `SELECT 1 FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id = ? AND json_extract(payload, '$.textSha') = ? LIMIT 1`

const OPEN_PRS_OF_DROPPED_CARDS = `
  SELECT prs.pr, prs.card_id, cards.event_id AS dropped FROM prs JOIN cards ON cards.card_id = prs.card_id
  WHERE prs.state = 'open' AND cards.state = '${DROPPED_CARD}'
    AND NOT EXISTS (SELECT 1 FROM events WHERE type = '${PR_CLOSED}' AND pr = prs.pr)
  ORDER BY prs.pr
`

export function droppedAttempt(droppedEventId: number, pr: number): string {
  return `dropped-${droppedEventId}-pr-${pr}`
}

function cardEventOf(card: RecutCard, at: Date): CardEvent {
  const parsed = parseParkingFile(`${card.id}.md`, card.text)
  if (parsed.kind === 'refused')
    throw new Error(`the re-cut body of card #${card.id} does not parse: ${parsed.reason}`)
  const { card: { line, depends, decision, contour } } = parsed.parked.task
  const ts = at.toISOString()
  const sha = bodySha(card.text)
  return {
    type: CARD_ADMITTED,
    cardId: card.id,
    ts,
    dedupeKey: `${CARD_ADMITTED}:${card.id}:${sha}:${ts}`,
    payload: { card: line, lane: null, depends, decision, contour, confirmation: 'auto', corrections: [], bodySha: sha, text: card.text, textSha: textSha(card.text), source: RECUT_SOURCE },
  }
}

export function latestGitHubNumber(gitHub: GitHub): number {
  const response = gitHub(LATEST_ISSUE_OR_PULL)
  if (response.status !== 200 || !Array.isArray(response.body))
    throw new Error(`GitHub answered ${response.status} to the read of its latest issue or pull request, so no card number is allocated`)
  if (response.body.length === 0)
    return 0
  const latest = (response.body[0] as { number?: unknown } | null)?.number
  if (typeof latest !== 'number')
    throw new Error('GitHub named its latest issue or pull request with no number, so no card number is allocated')
  return latest
}

function cardLineOf(card: RecutCard): string {
  const parsed = parseParkingFile(`${card.id}.md`, card.text)
  return parsed.kind === 'parked' ? parsed.parked.task.card.line : `#${card.id}`
}

export class PrCloser {
  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly patch: GitHubPut, private readonly clock: () => Date) {}

  close(request: CloseRequest): CloseOutcome {
    const read = this.readPull(request.pr)
    if (typeof read === 'string')
      return { kind: 'failed', pr: request.pr, detail: read }
    const verdict = closePolicy({ pr: request.pr, state: String(read.state ?? ''), headRef: String(read.head?.ref ?? ''), body: String(read.body ?? ''), cardId: request.cardId, mergeLeased: leasedOn(this.db, MERGE_QUEUE, request.pr) })
    if (verdict.kind === 'denied') {
      appendEvent(this.db, this.event(request, POLICY_DENIED, this.deniedKey(request, verdict.rule), { command: CLOSE_COMMAND, kind: 'authority', rule: verdict.rule, detail: verdict.detail, reason: request.reason, by: request.by }))
      return { kind: 'denied', pr: request.pr, detail: verdict.detail }
    }
    this.append(request, POLICY_ALLOWED, { command: CLOSE_COMMAND, rule: verdict.rule, reason: request.reason, by: request.by })
    return this.closed(request, verdict)
  }

  closeDropped(): CloseOutcome[] {
    const rows = this.db.prepare(OPEN_PRS_OF_DROPPED_CARDS).all() as { pr: number, card_id: number, dropped: number }[]
    return rows
      .map(row => ({ attempt: droppedAttempt(Number(row.dropped), Number(row.pr)), pr: Number(row.pr), cardId: Number(row.card_id), reason: `card #${row.card_id} was dropped`, by: 'card.dropped' as const }))
      .filter(request => !this.decided(request))
      .map(request => this.close(request))
  }

  private decided(request: CloseRequest): boolean {
    const lookup = this.db.prepare('SELECT 1 FROM events WHERE dedupe_key = ?')
    return CLOSE_RULES.some(rule => !RETRIED_CLOSE_RULES.has(rule) && lookup.get(this.deniedKey(request, rule)) !== undefined)
  }

  private deniedKey(request: CloseRequest, rule: CloseRule): string {
    return `${this.keyOf(POLICY_DENIED, request)}:${rule}`
  }

  readPull(pr: number): PullAsRead | string {
    try {
      const response = this.gitHub(`${REPO}/pulls/${pr}`)
      return response.status === 200 && response.body !== null && typeof response.body === 'object' ? response.body as PullAsRead : `GitHub answered ${response.status} to the read of PR #${pr}`
    }
    catch (error) {
      return `the read of PR #${pr} failed: ${messageOf(error)}`
    }
  }

  private closed(request: CloseRequest, verdict: CloseVerdict): CloseOutcome {
    let result: CommandResult
    try {
      const response = this.patch(`${REPO}/pulls/${request.pr}`, { state: 'closed' })
      result = { ok: response.status === 200, status: response.status }
    }
    catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    this.append(request, COMMAND_EXECUTED, { command: CLOSE_COMMAND, ...result })
    if (!result.ok)
      return { kind: 'failed', pr: request.pr, detail: 'status' in result ? `GitHub answered ${result.status} to the close of PR #${request.pr}` : `the close of PR #${request.pr} failed: ${result.error}` }
    appendEvent(this.db, this.event(request, PR_CLOSED, `pr:${request.pr}:closed`, { merged: false, reason: request.reason, by: request.by }))
    return { kind: 'closed', pr: request.pr, detail: `closed PR #${request.pr} without merge, its branch kept: ${verdict.detail}` }
  }

  private keyOf(type: string, request: CloseRequest): string {
    return `${type}:${CLOSE_COMMAND}:${request.attempt}`
  }

  private append(request: CloseRequest, type: string, payload: Record<string, unknown>): void {
    appendEvent(this.db, this.event(request, type, this.keyOf(type, request), payload))
  }

  private event(request: CloseRequest, type: string, dedupeKey: string, payload: Record<string, unknown>): BusEvent {
    const actor = type === POLICY_ALLOWED || type === POLICY_DENIED ? 'policy' : CLOSE_ACTOR
    return { ts: this.clock().toISOString(), type, actor, cardId: request.cardId, pr: request.pr, head: null, dedupeKey, payload, legacy: false }
  }
}

export class RoundLimitRecutter implements RoundLimitRecut {
  private readonly admit: CardAdmit

  constructor(private readonly parts: RecutParts) {
    this.admit = parts.admit ?? (event => appendCardEvent(parts.db, RECUT_ACTOR, laid(parts.db, event)))
  }

  recut(at: RoundLimitAt): RecutOutcome {
    try {
      return this.recutOrWait(at)
    }
    catch (error) {
      return this.waited(at, `the re-cut failed: ${messageOf(error)}`)
    }
  }

  private recutOrWait(at: RoundLimitAt): RecutOutcome {
    const text = cardBodyText(this.parts.db, at.cardId)
    if (text === null)
      return this.waited(at, `card #${at.cardId} has no admitted body in the bus`)
    const plan = recutPlanOf(at.cardId, text, at.findings)
    if (plan.kind === 'owner_wait')
      return this.waited(at, plan.why)
    const branch = this.branchOf(at.pr)
    if (typeof branch === 'string')
      return this.waited(at, branch)
    let recut: Recut
    try {
      const onGitHub = latestGitHubNumber(this.parts.gitHub)
      recut = inTransaction(this.parts.db, () => this.admitted(at, plan, text, onGitHub))
    }
    catch (error) {
      return this.waited(at, `the bus admitted none of the re-cut cards, so PR #${at.pr} and its branch ${branch.head} are untouched: ${messageOf(error)}`)
    }
    const closed = new PrCloser(this.parts.db, this.parts.gitHub, this.parts.patch, this.parts.clock).close({ attempt: `round-limit-${at.pr}`, pr: at.pr, cardId: at.cardId, reason: `card #${at.cardId} was re-cut at the review round limit (D-104)`, by: 'round-limit' })
    if (closed.kind !== 'closed')
      return this.waited(at, `the re-cut cards ${recut.admitted.map(card => `#${card.id}`).join(', ')} are admitted, but PR #${at.pr} was not closed: ${closed.detail}`)
    const opened = this.opened(at, branch, recut.carrier)
    if (typeof opened === 'string')
      return this.waited(at, `PR #${at.pr} is closed and its branch ${branch.head} kept, but no pull request was opened for card #${recut.carrier.id}: ${opened}`)
    return { kind: 'recut', pr: opened, cards: recut.admitted.map(card => card.id), carrier: recut.carrier.id }
  }

  private now(): string {
    return this.parts.clock().toISOString()
  }

  private admitted(at: RoundLimitAt, plan: Exclude<RecutPlan, { kind: 'owner_wait' }>, text: string, onGitHub: number): Recut {
    const [firstId] = nextFreeNumbers([...this.numbersInTheBus(), onGitHub], recutCardCount(plan))
    const recut = recutOf(plan, text, at.pr, firstId!)
    const ts = this.parts.clock()
    for (const card of recut.admitted) {
      if (!this.admit(cardEventOf(card, ts)))
        throw new Error(`the card.admitted of #${card.id} was not appended`)
    }
    if (recut.dropsTheCard)
      appendCardEvent(this.parts.db, RECUT_ACTOR, { type: CARD_DROPPED, cardId: at.cardId, ts: ts.toISOString(), dedupeKey: `${CARD_DROPPED}:${at.cardId}:round-limit-${at.pr}`, payload: { from: null, to: SUPERSEDED_LANE, lane: SUPERSEDED_LANE, bodySha: bodySha(text), recut: at.pr } })
    this.linkToPlanItems(at, recut.added)
    const unconfirmed = recut.admitted.filter(card => this.parts.db.prepare(ADMITTED_TEXT).get(card.id, textSha(card.text)) === undefined)
    if (unconfirmed.length > 0)
      throw new Error(`the bus holds no card.admitted of ${unconfirmed.map(card => `#${card.id}`).join(', ')}`)
    return recut
  }

  private numbersInTheBus(): number[] {
    const row = this.parts.db.prepare(NUMBERS_TAKEN).get() as { card: number | null, pr: number | null }
    return [row.card ?? 0, row.pr ?? 0]
  }

  private linkToPlanItems(at: RoundLimitAt, added: readonly number[]): void {
    const items = (this.parts.db.prepare(OPEN_PLAN_ITEMS).all() as { plan_id: string, item_id: string, cards: string }[])
      .filter(item => (JSON.parse(item.cards) as number[]).includes(at.cardId))
    for (const item of items) {
      for (const card of added)
        appendEvent(this.parts.db, { ts: this.now(), type: PLAN_ITEM_LINKED, actor: OWNER, cardId: card, pr: null, head: null, dedupeKey: `${PLAN_ITEM_LINKED}:round-limit-${at.pr}:${item.plan_id}:${item.item_id}:${card}`, payload: { plan: item.plan_id, item: item.item_id, card, recut_of: at.cardId }, legacy: false })
    }
  }

  private branchOf(pr: number): Branch | string {
    const read = new PrCloser(this.parts.db, this.parts.gitHub, this.parts.patch, this.parts.clock).readPull(pr)
    if (typeof read === 'string')
      return read
    const head = String(read.head?.ref ?? '')
    const base = String(read.base?.ref ?? '')
    return head === '' || base === '' ? `PR #${pr} names no head or base branch` : { head, base }
  }

  private opened(at: RoundLimitAt, branch: Branch, carrier: RecutCard): number | string {
    const line = cardLineOf(carrier)
    let response: GhResponse
    try {
      response = this.parts.post(`${REPO}/pulls`, { title: line.split(' [')[0]!, head: branch.head, base: branch.base, body: `${line}\n\nRe-cut of PR #${at.pr} at the review round limit (D-104): a new witness and a new review, no earlier pass.` })
    }
    catch (error) {
      return messageOf(error)
    }
    const pr = (response.body as { number?: unknown } | null)?.number
    if (response.status !== CREATED || typeof pr !== 'number')
      return `GitHub answered ${response.status} to the pull request from ${branch.head}`
    appendEvent(this.parts.db, { ts: this.now(), type: PR_OPENED, actor: RECUT_ACTOR, cardId: carrier.id, pr, head: at.head, dedupeKey: `${PR_OPENED}:${carrier.id}:${pr}`, payload: { pr, recut_of: at.pr }, legacy: false })
    return pr
  }

  private waited(at: RoundLimitAt, why: string): RecutOutcome {
    const text = `PR #${at.pr} of card #${at.cardId} reached the review round limit (D-104) and was not re-cut: ${why}`
    const wait = inTransaction(this.parts.db, () => openBusWait(this.parts.db, this.now(), RECUT_ACTOR, { need: 'decision', text, card: at.cardId, pr: at.pr }))
    return { kind: 'owner_wait', pr: at.pr, wait, why }
  }
}
