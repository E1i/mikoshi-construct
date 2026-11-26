import type { DatabaseSync } from 'node:sqlite'
import type { WaitLift, WaitLiftKind } from '../core/db.js'
import type { EventRow } from '../core/events-query.js'
import { closedWaitIds } from '../core/card-readings.js'
import { closeOwnerWait, currentHeadOf, headPassed, inTransaction, isWaitLift, mergeOfPr } from '../core/db.js'
import { events } from '../core/events-query.js'
import { CARD_ADMITTED, CARD_ANSWERED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_OBSERVED, REJECTED } from '../core/events.js'

export const WAIT_LIFT_ACTOR = 'worker:supervisor:wait-lifts'

const AMEND_ADMISSION = 'amend'

export interface WaitLiftParts {
  decidedForTheCardSince: (card: number, eventId: number) => boolean
  unmergedDependencies: (card: number) => readonly number[]
}

export interface OpenedWait {
  event: number
  id: string
  card: number | null
  pr: number | null
  lift: WaitLift | null
}

type Lifting = (wait: OpenedWait) => string | null

function openedWaitOf(event: EventRow): OpenedWait | null {
  const id = event.data?.id
  if (typeof id !== 'string')
    return null
  const lift = event.data?.lift
  return { event: event.id, id, card: event.card_id, pr: event.pr, lift: isWaitLift(lift) ? lift : null }
}

export class WaitLifts {
  private readonly liftings: Readonly<Record<WaitLiftKind, Lifting>>

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly parts: WaitLiftParts) {
    this.liftings = {
      'new-head': wait => this.newHead(wait),
      'amend': wait => this.amended(wait),
      'passed-on-head': wait => this.passedOnHead(wait),
      'decision': wait => wait.card !== null && this.parts.decidedForTheCardSince(wait.card, wait.event) ? `lifted: a decision bound to card #${wait.card} was recorded` : null,
      'pr-merged': wait => wait.pr !== null && mergeOfPr(this.db, wait.pr) !== null ? `lifted: pull request #${wait.pr} merged` : null,
      'dependency-merged': wait => wait.card !== null && this.parts.unmergedDependencies(wait.card).length === 0 ? `lifted: every dependency of card #${wait.card} is merged` : null,
      'owner-answer': () => null,
    }
  }

  step(): string[] {
    const ts = this.clock().toISOString()
    const closed = new Set<unknown>([...events(this.db, { types: [OWNER_WAIT_CLOSED] }).map(event => event.data?.id), ...closedWaitIds(this.db)])
    return events(this.db, { types: [OWNER_WAIT_OPENED] }).flatMap((event) => {
      const wait = openedWaitOf(event)
      if (wait === null || closed.has(wait.id))
        return []
      const answer = this.refusalOf(event) ?? this.liftOf(wait)
      if (answer === null)
        return []
      return inTransaction(this.db, () => closeOwnerWait(this.db, ts, WAIT_LIFT_ACTOR, wait.id, answer, wait.event)) ? [`${wait.id}${wait.card === null ? '' : ` #${wait.card}`} ${answer}`] : []
    })
  }

  liftOf(wait: OpenedWait): string | null {
    for (const kind of wait.lift?.on ?? []) {
      const answer = this.liftings[kind](wait)
      if (answer !== null)
        return answer
    }
    return null
  }

  private refusalOf(opened: EventRow): string | null {
    const refused = events(this.db, { types: [REJECTED], keys: [`${REJECTED}:${opened.dedupe_key}`], limit: 1 })[0]
    return refused === undefined ? null : `refused by the reducer: ${String(refused.data?.reason)}`
  }

  private newHead(wait: OpenedWait): string | null {
    if (wait.pr === null)
      return this.newAnswerHead(wait)
    const head = currentHeadOf(this.db, wait.pr)
    const before = wait.lift?.head ?? events(this.db, { types: [PR_OBSERVED], pr: wait.pr, before: wait.event, newestFirst: true, limit: 1 })[0]?.head ?? null
    return head !== null && before !== null && head !== before ? `lifted: a new head ${head} on pull request #${wait.pr}` : null
  }

  private newAnswerHead(wait: OpenedWait): string | null {
    if (wait.card === null)
      return null
    const answered = events(this.db, { types: [CARD_ANSWERED], card: wait.card, since: wait.event, newestFirst: true, limit: 1 })[0]?.data?.to
    return typeof answered === 'string' && answered !== wait.lift?.head ? `lifted: a new head ${answered} on card #${wait.card}` : null
  }

  private amended(wait: OpenedWait): string | null {
    if (wait.card === null)
      return null
    const amend = events(this.db, { types: [CARD_ADMITTED], card: wait.card, since: wait.event }).some(admitted => admitted.data?.source === AMEND_ADMISSION)
    return amend ? `lifted: card #${wait.card} was amended` : null
  }

  private passedOnHead(wait: OpenedWait): string | null {
    if (wait.pr === null)
      return null
    const head = headPassed(this.db, wait.pr)
    return head === null ? null : `lifted: green witnesses and a review pass on ${head} of pull request #${wait.pr}`
  }
}
