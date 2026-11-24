import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { CardEvent, CardStatesPort } from '../../../src/commands/intake/index.js'
import type { BusEvent } from '../../core/db.js'
import type { CloseRule, CloseVerdict } from '../../policy/policy.js'
import type { Recut, RecutCard, RecutPlan } from '../../policy/round-limit-decision.js'
import type { CommandResult, GhResponse, GitHub, GitHubPut } from '../../ports/github.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { bodySha } from '../../../src/commands/intake/confirm.js'
import { nextCardNumbers } from '../../../src/commands/intake/numbers.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { appendCardEvent, cardBodyText, laid } from '../../core/card-bodies.js'
import { droppingEventsAmong, queuedDependentsOf } from '../../core/card-readings.js'
import { appendEvent, inTransaction, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { EITHER_JOURNAL, events, latestPrInTheBus } from '../../core/events-query.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_PLANNED, COMMAND_EXECUTED, OPEN_PLAN, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED, PR_OPENED, ROUND_MUTATIONS_PARKED } from '../../core/events.js'
import { leasedOn } from '../../core/lease.js'
import { closedKey, reopeningOf } from '../../core/observations.js'
import { CLOSE_RULES, closePolicy, RETRIED_CLOSE_RULES } from '../../policy/policy.js'
import { parkPlanOf, RECUT_ACTOR, RECUT_SOURCE, recutCardCount, recutOf, recutPlanOf } from '../../policy/round-limit-decision.js'

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
  mutations?: readonly string[]
}

export type RecutOutcome
  = | { kind: 'recut', pr: number, cards: number[], carrier: number }
    | { kind: 'parked', pr: number, card: number }
    | { kind: 'owner_wait', pr: number, wait: string, why: string }

export interface RoundLimitRecut {
  recut: (at: RoundLimitAt) => RecutOutcome
}

export type CardAdmit = (event: CardEvent) => boolean

export interface CardPlan {
  plan: string
  state: string
}

export type PlanOfCardReading = (db: DatabaseSync, cardId: number) => CardPlan | null

export interface RecutParts {
  db: DatabaseSync
  gitHub: GitHub
  post: GitHubPut
  patch: GitHubPut
  clock: () => Date
  cardStates: CardStatesPort
  closedWaits: () => readonly string[]
  planOfCard: PlanOfCardReading
  admit?: CardAdmit
  pushPolicy?: () => PushPolicy
}

export interface PullAsRead {
  state?: unknown
  merged?: unknown
  body?: unknown
  title?: unknown
  head?: { ref?: unknown, sha?: unknown }
  base?: { ref?: unknown }
}

interface Branch {
  head: string
  base: string
}

const SUPERSEDED_LANE = 'superseded'
const CREATED = 201

const LATEST_ISSUE_OR_PULL = `${REPO}/issues?state=all&sort=created&direction=desc&per_page=1`

const OPEN_PRS_WITH_A_CARD = `SELECT pr, card_id FROM prs WHERE state = 'open' AND card_id IS NOT NULL ORDER BY pr`

interface DroppedCardPr {
  pr: number
  cardId: number
  dropped: number
}

export function droppedAttempt(droppedEventId: number, pr: number): string {
  return `dropped-${droppedEventId}-pr-${pr}`
}

function openPrsOfDroppedCards(db: DatabaseSync): DroppedCardPr[] {
  const open = (db.prepare(OPEN_PRS_WITH_A_CARD).all() as { pr: number, card_id: number }[]).map(row => ({ pr: Number(row.pr), cardId: Number(row.card_id) }))
  const drops = droppingEventsAmong(db, [...new Set(open.map(row => row.cardId))])
  return open.flatMap((row) => {
    const dropped = drops.get(row.cardId)
    return dropped === undefined || events(db, { pr: row.pr, types: [PR_CLOSED], legacy: EITHER_JOURNAL, limit: 1 }).length > 0 ? [] : [{ ...row, dropped }]
  })
}

function isAdmittedText(db: DatabaseSync, cardId: number, sha: string): boolean {
  return events(db, { card: cardId, types: [CARD_ADMITTED] }).some(admitted => admitted.data?.textSha === sha)
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

export function readPullOf(gitHub: GitHub, pr: number): PullAsRead | string {
  try {
    const response = gitHub(`${REPO}/pulls/${pr}`)
    return response.status === 200 && response.body !== null && typeof response.body === 'object' ? response.body as PullAsRead : `GitHub answered ${response.status} to the read of PR #${pr}`
  }
  catch (error) {
    return `the read of PR #${pr} failed: ${messageOf(error)}`
  }
}

export class PrCloser {
  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly patch: GitHubPut, private readonly clock: () => Date, private readonly pushPolicy?: () => PushPolicy) {}

  close(request: CloseRequest): CloseOutcome {
    if (this.pushPolicy?.() === 'none')
      return { kind: 'denied', pr: request.pr, detail: `push policy none: the bus does not close PR #${request.pr}` }
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
    return openPrsOfDroppedCards(this.db)
      .map(row => ({ attempt: droppedAttempt(row.dropped, row.pr), pr: row.pr, cardId: row.cardId, reason: `card #${row.cardId} was dropped`, by: 'card.dropped' as const }))
      .filter(request => !this.decided(request))
      .map(request => this.close(request))
  }

  private decided(request: CloseRequest): boolean {
    const keys = CLOSE_RULES.filter(rule => !RETRIED_CLOSE_RULES.has(rule)).map(rule => this.deniedKey(request, rule))
    return events(this.db, { keys, legacy: EITHER_JOURNAL, limit: 1 }).length > 0
  }

  private deniedKey(request: CloseRequest, rule: CloseRule): string {
    return `${this.keyOf(POLICY_DENIED, request)}:${rule}`
  }

  readPull(pr: number): PullAsRead | string {
    return readPullOf(this.gitHub, pr)
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
    appendEvent(this.db, this.event(request, PR_CLOSED, closedKey(request.pr, reopeningOf(this.db)(request.pr)), { merged: false, reason: request.reason, by: request.by }))
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
    this.admit = parts.admit ?? (event => appendCardEvent(BUS_CONTRACT, parts.db, RECUT_ACTOR, laid(parts.db, event)))
  }

  recut(at: RoundLimitAt): RecutOutcome {
    if (this.parts.pushPolicy?.() === 'none')
      return this.waited(at, 'push policy none: the bus opens and closes no pull request in this repository')
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
    if (at.mutations !== undefined)
      return this.parkOrWait(at, text, at.mutations)
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
    const closed = new PrCloser(this.parts.db, this.parts.gitHub, this.parts.patch, this.parts.clock, this.parts.pushPolicy).close({ attempt: `round-limit-${at.pr}`, pr: at.pr, cardId: at.cardId, reason: `card #${at.cardId} was re-cut at the review round limit (D-104)`, by: 'round-limit' })
    if (closed.kind !== 'closed')
      return this.waited(at, `the re-cut cards ${recut.admitted.map(card => `#${card.id}`).join(', ')} are admitted, but PR #${at.pr} was not closed: ${closed.detail}`)
    const opened = this.opened(at, branch, recut.carrier)
    if (typeof opened === 'string')
      return this.waited(at, `PR #${at.pr} is closed and its branch ${branch.head} kept, but no pull request was opened for card #${recut.carrier.id}: ${opened}`)
    return { kind: 'recut', pr: opened, cards: recut.admitted.map(card => card.id), carrier: recut.carrier.id }
  }

  private parkOrWait(at: RoundLimitAt, text: string, mutations: readonly string[]): RecutOutcome {
    const dependents: RecutCard[] = queuedDependentsOf(this.parts.db, at.cardId)
    const plan = parkPlanOf(at.cardId, text, mutations, dependents)
    if (plan.kind === 'owner_wait')
      return this.waited(at, plan.why)
    const onGitHub = plan.continuation === null ? latestGitHubNumber(this.parts.gitHub) : 0
    const recut = inTransaction(this.parts.db, () => {
      const admitted = this.admitted(at, plan, text, onGitHub)
      appendEvent(this.parts.db, { ts: this.now(), type: ROUND_MUTATIONS_PARKED, actor: RECUT_ACTOR, cardId: at.cardId, pr: at.pr, head: at.head, dedupeKey: `${ROUND_MUTATIONS_PARKED}:${at.pr}:${at.head}`, payload: { pr: at.pr, head: at.head, mutations, card: admitted.carrier.id }, legacy: false })
      return admitted
    })
    return { kind: 'parked', pr: at.pr, card: recut.carrier.id }
  }

  private now(): string {
    return this.parts.clock().toISOString()
  }

  private admitted(at: RoundLimitAt, plan: Exclude<RecutPlan, { kind: 'owner_wait' }>, text: string, onGitHub: number): Recut {
    const [firstId] = nextCardNumbers(this.parts.cardStates(), [latestPrInTheBus(this.parts.db), onGitHub], recutCardCount(plan))
    const recut = recutOf(plan, text, at.pr, firstId!)
    const ts = this.parts.clock()
    for (const card of recut.admitted) {
      if (!this.admit(cardEventOf(card, ts)))
        throw new Error(`the card.admitted of #${card.id} was not appended`)
    }
    if (recut.dropsTheCard)
      appendCardEvent(BUS_CONTRACT, this.parts.db, RECUT_ACTOR, { type: CARD_DROPPED, cardId: at.cardId, ts: ts.toISOString(), dedupeKey: `${CARD_DROPPED}:${at.cardId}:round-limit-${at.pr}`, payload: { from: null, to: SUPERSEDED_LANE, lane: SUPERSEDED_LANE, bodySha: bodySha(text), recut: at.pr } })
    this.planIntoTheRelease(at, recut.added)
    const unconfirmed = recut.admitted.filter(card => !isAdmittedText(this.parts.db, card.id, textSha(card.text)))
    if (unconfirmed.length > 0)
      throw new Error(`the bus holds no card.admitted of ${unconfirmed.map(card => `#${card.id}`).join(', ')}`)
    return recut
  }

  private planIntoTheRelease(at: RoundLimitAt, added: readonly number[]): void {
    const plan = this.parts.planOfCard(this.parts.db, at.cardId)
    if (plan?.state !== OPEN_PLAN)
      return
    const release = plan.plan
    for (const card of added)
      appendEvent(this.parts.db, { ts: this.now(), type: CARD_PLANNED, actor: RECUT_ACTOR, cardId: card, pr: null, head: null, dedupeKey: `${CARD_PLANNED}:round-limit-${at.pr}:${release}:${card}`, payload: { release, card, recut_of: at.cardId }, legacy: false })
  }

  private branchOf(pr: number): Branch | string {
    const read = new PrCloser(this.parts.db, this.parts.gitHub, this.parts.patch, this.parts.clock, this.parts.pushPolicy).readPull(pr)
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
    const wait = inTransaction(this.parts.db, () => openBusWait(this.parts.db, this.parts.closedWaits(), this.now(), RECUT_ACTOR, { need: 'decision', text, card: at.cardId, pr: at.pr }))
    return { kind: 'owner_wait', pr: at.pr, wait, why }
  }
}
