import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../../core/db.js'
import type { Lease } from '../../../core/lease.js'
import type { AnswerInput } from '../../../ports/prompt-store.js'
import type { CardSession } from '../answer-source.js'
import type { Answered, StepSeconds } from '../answerer.js'
import type { AnswerOutcome, AnswerOutcomes } from './outcomes.js'
import type { Answering } from './source.js'
import { CARD_ANSWERED, POLICY_DENIED, PR_OBSERVED, PR_OPENED } from '../../../core/events.js'
import { assertHeld, completeTask } from '../../../core/lease.js'
import { FAILURES_TO_STOP, REVIEW_ROUNDS } from '../../../core/queue.js'
import { sha256, storedInput } from '../../../ports/prompt-store.js'

export interface TreePublishing {
  committed: (card: CardSession) => boolean
  publish: (card: CardSession, cardId: number) => void
}

export interface PublishingParts {
  db: DatabaseSync
  prompts?: string
  publishing?: TreePublishing
}

const FAILURES_IN_A_ROW = 'SELECT failures FROM tasks WHERE task_key = ?'

const LEFT_NOTHING = 'left_nothing'

const A_PR_OF_THE_CARD = `
  SELECT pr FROM prs WHERE card_id = :card
  UNION ALL SELECT pr FROM events WHERE card_id = :card AND pr IS NOT NULL AND type IN ('${PR_OPENED}', '${PR_OBSERVED}')
  LIMIT 1
`

const DENIALS_OF_THE_TASK = `type = '${POLICY_DENIED}' AND substr(dedupe_key, 1, length(:prefix)) = :prefix`

const EMPTY_ANSWERS_IN_A_ROW = `
  SELECT count(*) AS n FROM events
  WHERE ${DENIALS_OF_THE_TASK} AND json_extract(payload, '$.reason') = '${LEFT_NOTHING}'
    AND id > coalesce((SELECT max(id) FROM events WHERE ${DENIALS_OF_THE_TASK} AND json_extract(payload, '$.reason') != '${LEFT_NOTHING}'), 0)
`

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
    completeTask(this.parts.db, this.outcomes.ts(), lease, [...scope, this.outcomes.event(lease, CARD_ANSWERED, payload), linkAfterTheStopLifts])
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
    const row = this.parts.db.prepare(A_PR_OF_THE_CARD).get({ card: cardId }) as { pr: number } | undefined
    return row === undefined ? null : Number(row.pr)
  }

  private emptyAnswersInARow(lease: Lease): number {
    return Number((this.parts.db.prepare(EMPTY_ANSWERS_IN_A_ROW).get({ prefix: `${POLICY_DENIED}:${lease.taskKey}:` }) as { n: number }).n)
  }

  private failuresInARow(lease: Lease): number {
    const row = this.parts.db.prepare(FAILURES_IN_A_ROW).get(lease.taskKey) as { failures: number } | undefined
    return row?.failures ?? 0
  }
}
