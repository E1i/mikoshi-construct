import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import type { AnswerSource, CardSession } from '../answer-source.js'
import type { TreeMerge } from './tree.js'
import { CLOSED_WAIT, OWNER_WAITS } from '../../../core/bus-readings.js'
import { inTransaction, openBusWait } from '../../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_CLOSED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER, WITNESS_RECORDED } from '../../../core/events.js'
import { openDecisionWaitsOf } from '../../../core/queue.js'
import { cardDecisionCommand, decisionsInForceAt } from '../../../policy/shards.js'
import { BusRead } from '../../../ports/bus-read.js'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'
import { answerSourceOf, boundDecisionLines } from '../answer-source.js'

export type Answering = AnswerSource & { reentry?: true }

export interface SourceParts {
  db: DatabaseSync
  clock: () => Date
}

const CLOSED_WAITS_OF_THE_CARD = `SELECT id, answer FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${CLOSED_WAIT}' ORDER BY event_id`

const EMPTY_ROUND = 'left_nothing'

const AMENDED_ADMISSION = 'amend'

const QUESTION_STOPS: readonly unknown[] = [QUESTION_AGENT, QUESTION_OWNER]

export interface AwaitedStop {
  id: number
  reason: string
  emptyRound: number
}

const DIRTY_ON_HEAD = `SELECT 1 FROM prs WHERE pr = ? AND head = ? AND state = 'open' AND mergeable = 'dirty'`

const RED_WITNESS_ON_HEAD = `
  SELECT json_extract(red.payload, '$.detail') AS detail FROM events AS red
  WHERE red.id = (SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = ? AND latest.head = ?)
    AND json_extract(red.payload, '$.verdict') = 'red'
`

export class AnswerSources {
  constructor(private readonly parts: SourceParts) {}

  sourceOf(lease: Lease): Answering | null {
    const source = answerSourceOf(this.parts.db, lease, this.parts.clock())
    const awaited = source?.kind === 'decision' ? null : this.awaitedStop(lease)
    if (awaited !== null) {
      this.holdForTheOwner(lease, awaited)
      return null
    }
    if (source?.kind === 'question')
      return { ...source, decisions: [...source.decisions, ...this.closedWaitLines(lease)] }
    if (source !== null && source.kind !== 'ci')
      return source
    const witness = this.redWitness(lease)
    if (witness === null)
      return source
    return source === null ? witness : { ...witness, failedChecks: source.failedChecks }
  }

  boundDecisions(lease: Lease): string[] {
    return boundDecisionLines(this.parts.db, lease.cardId, this.parts.clock())
  }

  awaitedStop(lease: Lease): AwaitedStop | null {
    const card = new BusRead(this.parts.db).where({ card: lease.cardId })
    const stop = this.standingQuestionStop(card)
    if (stop === null)
      return null
    const round = card.where({ from: stop.id + 1 }).slice(POLICY_DENIED, ['command', 'reason']).filter(denied => denied.fields.command === 'answer' && denied.fields.reason === EMPTY_ROUND).at(-1)
    if (round === undefined)
      return null
    const since = card.where({ from: round.id + 1 })
    const lifted = this.decidedSince(lease, round.id) || this.waitClosedSince(lease, round.id)
      || since.slice(CARD_ADMITTED, ['source']).some(admitted => admitted.fields.source === AMENDED_ADMISSION)
      || (lease.head !== null && lease.head !== round.head)
    return lifted ? null : { id: stop.id, reason: stop.reason, emptyRound: round.id }
  }

  private standingQuestionStop(card: BusRead): { id: number, reason: string } | null {
    const stop = card.slice(CARD_STOPPED, ['reason'], 'last')[0]
    if (stop === undefined || !QUESTION_STOPS.includes(stop.fields.reason))
      return null
    const later = ([CARD_ANSWERED, CARD_STARTED] as const).some(type => card.where({ from: stop.id + 1 }).slice(type, [], 'last').length > 0)
    return later ? null : { id: stop.id, reason: String(stop.fields.reason) }
  }

  private decidedSince(lease: Lease, eventId: number): boolean {
    const recorded = new BusRead(this.parts.db).where({ from: eventId + 1 }).slice(DECISION_RECORDED, ['decision_id']).map(each => Number(each.fields.decision_id))
    return decisionsInForceAt(this.parts.db, this.parts.clock()).some(each => each.cards.includes(lease.cardId) && recorded.includes(each.decisionId))
  }

  private waitClosedSince(lease: Lease, eventId: number): boolean {
    const ofTheCard = new Set((this.parts.db.prepare(CLOSED_WAITS_OF_THE_CARD).all(lease.cardId) as { id: string }[]).map(wait => wait.id))
    return new BusRead(this.parts.db).where({ from: eventId + 1 }).slice(OWNER_WAIT_CLOSED, ['id']).some(closed => ofTheCard.has(String(closed.fields.id)))
  }

  private holdForTheOwner(lease: Lease, stop: AwaitedStop): void {
    const db = this.parts.db
    if (db.prepare(openDecisionWaitsOf('?')).get(lease.cardId) !== undefined)
      return
    const text = `card #${lease.cardId} waits for the owner: an answer round after its ${stop.reason} stop left nothing, so no answer round runs until a decision bound to the card, an amend or a new head`
    const ask = { need: 'decision' as const, text, command: cardDecisionCommand(lease.cardId), card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) }
    inTransaction(db, () => openBusWait(db, this.parts.clock().toISOString(), lease.actor, ask))
  }

  dirtyOnHead(lease: Lease): boolean {
    if (this.awaitedStop(lease) !== null)
      return false
    return lease.pr !== null && lease.head !== null && this.parts.db.prepare(DIRTY_ON_HEAD).get(lease.pr, lease.head) !== undefined
  }

  conflict(lease: Lease, card: CardSession, merge: TreeMerge | null): AnswerSource {
    const conflicts = `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}`
    const decisions = this.boundDecisions(lease)
    if (merge?.kind !== 'mid-merge')
      return { kind: 'changes', findings: [`${conflicts}: merge origin/${MAIN_BRANCH} into the branch and resolve every conflict, keeping what the card asks for`], events: [], decisions }
    const unmerged = merge.files.length === 0 ? '' : ` with ${merge.files.join(', ')} unmerged`
    return { kind: 'changes', findings: [`${conflicts}, and its tree ${card.worktree} stands mid-merge${unmerged}: finish that merge where it stands, resolving every unmerged path keeping what the card asks for and staging it with git -C ${card.worktree} add, and leave the commit that concludes the merge to the bus; never git merge --abort, git reset or a new merge over it`], events: [], decisions }
  }

  private redWitness(lease: Lease): Answering & { kind: 'changes' } | null {
    if (lease.pr === null || lease.head === null)
      return null
    const red = this.parts.db.prepare(RED_WITNESS_ON_HEAD).get(lease.pr, lease.head) as { detail: unknown } | undefined
    if (red === undefined)
      return null
    const detail = typeof red.detail === 'string' && red.detail !== '' ? red.detail : 'the bus recorded no detail'
    return { kind: 'changes', findings: [`the card's witness is red on ${lease.head}: ${detail}`], events: [], decisions: this.boundDecisions(lease), reentry: true }
  }

  private closedWaitLines(lease: Lease): string[] {
    const closed = this.parts.db.prepare(CLOSED_WAITS_OF_THE_CARD).all(lease.cardId) as { id: string, answer: string | null }[]
    return closed.map(wait => `${wait.id} is closed: ${wait.answer ?? 'no answer recorded'}`)
  }
}
