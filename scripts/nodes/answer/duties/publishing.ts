import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../../core/db.js'
import type { CardTransitions, Lease } from '../../../core/lease.js'
import type { AnswerInput } from '../../../ports/prompt-store.js'
import type { CardSession } from '../answer-source.js'
import type { Answered, StepSeconds } from '../answerer.js'
import type { AnswerOutcome, AnswerOutcomes } from './outcomes.js'
import type { Answering } from './source.js'
import { EITHER_JOURNAL, events } from '../../../core/events-query.js'
import { CARD_ANSWERED, POLICY_DENIED, PR_OBSERVED, PR_OPENED } from '../../../core/events.js'
import { REVIEW_ROUNDS } from '../../../core/identifiers.js'
import { assertHeld, completeTask } from '../../../core/lease.js'
import { ofCard as prsOfCard } from '../../../core/pr-readings.js'
import { FAILURES_TO_STOP } from '../../../core/queue.js'
import { byKey as taskByKey } from '../../../core/tasks-query.js'
import { sha256, storedInput } from '../../../ports/prompt-store.js'

export interface TreePublishing {
  committed: (card: CardSession) => boolean
  publish: (card: CardSession, cardId: number) => void
}

export interface PublishingParts {
  db: DatabaseSync
  cards: CardTransitions
  prompts?: string
  publishing?: TreePublishing
}

const LEFT_NOTHING = 'left_nothing'

const PULL_REQUEST_LINKS = [PR_OPENED, PR_OBSERVED]

function emptyRunAfter(run: number, reason: unknown): number {
  if (reason === LEFT_NOTHING)
    return run + 1
  return reason === undefined || reason === null ? run : 0
}

function cardBodyOf(input: AnswerInput | undefined): { card_body_sha: string } | Record<string, never> {
  return input === undefined || input.cardBody === null ? {} : { card_body_sha: sha256(input.cardBody) }
}

function measurementOf(answered: Answered, minutes: number): { minutes: number, tokens: number | null } | Record<string, never> {
  return answered.tokens === undefined ? {} : { minutes, tokens: answered.tokens }
}

function stepsOf(answered: Answered): { steps: StepSeconds } | Record<string, never> {
  return answered.steps === undefined ? {} : { steps: answered.steps }
}

export class AnswerPublishing {
  constructor(private readonly parts: PublishingParts, private readonly outcomes: AnswerOutcomes) {}

  answeredPayload(source: Answering, card: CardSession, answered: Answered, minutes: number, extra: object): object {
    return { session: answered.session, worktree: card.worktree, resumed: answered.resumed, source: source.kind, from: answered.before, to: answered.after, ...extra, ...measurementOf(answered, minutes), ...stepsOf(answered), ...storedInput(this.parts.prompts, answered.input), ...cardBodyOf(answered.input) }
  }

  published(lease: Lease, source: Answering, card: CardSession, answered: Answered, minutes: number, scope: BusEvent[]): AnswerOutcome | null {
    const publishing = this.parts.publishing
    if (publishing === undefined || this.prOfTheCard(lease.cardId) !== null || !publishing.committed(card))
      return null
    assertHeld(this.parts.db, lease)
    publishing.publish(card, lease.cardId)
    const pr = this.prOfTheCard(lease.cardId)
    if (pr === null)
      return null
    const payload = this.answeredPayload(source, card, answered, minutes, { published: true, pr })
    const linkAfterTheStopLifts: BusEvent = { ...this.outcomes.event(lease, PR_OPENED, { pr }), pr }
    completeTask(this.parts.db, this.parts.cards, this.outcomes.ts(), lease, [...scope, this.outcomes.event(lease, CARD_ANSWERED, payload), linkAfterTheStopLifts])
    return { kind: 'published', taskKey: lease.taskKey, session: answered.session, pr }
  }

  leftDirty(lease: Lease, card: CardSession, session: string): AnswerOutcome {
    return this.outcomes.denied(lease, { kind: 'technical', reason: 'answer_failed', detail: `the answer session ${session} pushed nothing and left uncommitted changes in ${card.worktree}; the answer goes again over that tree` })
  }

  leftNothing(lease: Lease, answered: Answered, scope: BusEvent[]): AnswerOutcome {
    const cause = `the answer session ${answered.session} left ${lease.taskKey} at ${answered.after ?? 'no pushed head'} with no new commit, no owner question and a clean tree`
    const empty = this.emptyAnswersInARow(lease) + 1
    const failures = this.failuresInARow(lease) + 1
    if (empty < REVIEW_ROUNDS && failures < FAILURES_TO_STOP)
      return this.outcomes.denied(lease, { kind: 'technical', reason: LEFT_NOTHING, detail: `${cause}; the answer goes again, empty answer ${empty} of the review round limit ${REVIEW_ROUNDS}` })
    const limit = empty >= REVIEW_ROUNDS
      ? `${empty} empty answers in a row reach the review round limit ${REVIEW_ROUNDS}`
      : `${empty} empty answers in a row and ${failures} failures in a row of any kind reach the ${FAILURES_TO_STOP} failures that stop the task`
    const detail = `${cause}: ${limit}, and the bus answers the card no further`
    return this.outcomes.ownersStop(lease, detail, scope, `card #${lease.cardId} stands on a faulted answer: ${detail}; decide it: a re-cut, an amend of the card or a drop`)
  }

  private prOfTheCard(cardId: number): number | null {
    const recorded = prsOfCard(this.parts.db, cardId)[0]
    if (recorded !== undefined)
      return recorded.pr
    return events(this.parts.db, { card: cardId, types: PULL_REQUEST_LINKS, withPr: true, legacy: EITHER_JOURNAL, limit: 1 })[0]?.pr ?? null
  }

  private emptyAnswersInARow(lease: Lease): number {
    const denials = events(this.parts.db, { types: [POLICY_DENIED], keyPrefix: `${POLICY_DENIED}:${lease.taskKey}:`, legacy: EITHER_JOURNAL })
    return denials.reduce((run, denial) => emptyRunAfter(run, denial.data?.reason), 0)
  }

  private failuresInARow(lease: Lease): number {
    return taskByKey(this.parts.db, lease.taskKey)?.failures ?? 0
  }
}
