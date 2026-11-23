import type { DatabaseSync } from 'node:sqlite'
import type { Admits, Candidate, CandidateRules, QueuedTask, QueueSource, RecordedOrder, RequeueRow } from '../../core/queue.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { cardDecisionKeyOf, MAIN_BRANCH } from '../../core/identifiers.js'
import { withTheHeadsARerunIsDueOn } from '../../core/observations.js'
import { all } from '../../core/pr-readings.js'
import { A_DEPENDENCY_UPDATE_DUE, A_MERGE_SENT_TO_UPDATE_ON_THE_HEAD, aMergeCandidate, aTaskInFlight, candidateRows, COMPLETED, decidedPastRoundLimit, holdsTheTurn, keyOf, noTurnHeldBeside, openCandidates, recordedOrder, taskRow } from '../../core/queue.js'

export interface UpdateSourceParts {
  rules: CandidateRules
  topPriority: string
}

function openPrsByCardPriority(topPriority: string, condition: string, column = ''): string {
  return `
  SELECT prs.pr, prs.card_id, prs.head, prs.verdict_on_head${column} FROM prs
  LEFT JOIN ${CARD_BODIES} AS body ON body.card_id = prs.card_id
  WHERE prs.state = 'open' AND prs.base = '${MAIN_BRANCH}' AND prs.draft = 0 AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL
    AND ${condition}
  ORDER BY body.priority IS NOT '${topPriority}', prs.pr
`
}

function openPrsWithTheirUpdateCauses(topPriority: string): string {
  return openPrsByCardPriority(topPriority, '1', `, prs.mergeable, ${A_MERGE_SENT_TO_UPDATE_ON_THE_HEAD} AS sent_at, ${A_DEPENDENCY_UPDATE_DUE} AS dependency_due, ${aTaskInFlight('answer', 'live.card_id = prs.card_id')} AS answering`)
}

function aMergeSentToUpdate(topPriority: string): string {
  return openPrsByCardPriority(topPriority, `sent_at IS NOT NULL`, `, ${A_MERGE_SENT_TO_UPDATE_ON_THE_HEAD} AS sent_at`)
}

interface UpdateCauses extends Candidate {
  mergeable: string | null
  sent_at: number | null
  dependency_due: number
  answering: number
}

function updateDue(order: RecordedOrder, mayMerge: Admits, decided: Admits): Admits {
  return (candidate) => {
    const row = candidate as UpdateCauses
    const ownWork = row.mergeable === 'dirty' ? row.answering === 0 : row.dependency_due === 1
    const turn = holdsTheTurn(order, row.pr) || (decided(row) && noTurnHeldBeside(order, row.pr))
    const inTurn = turn && mayMerge(row) && (ownWork || row.sent_at !== null || order.needUpdate.has(row.pr!))
    return inTurn || (ownWork && noTurnHeldBeside(order, row.pr))
  }
}

export function updateCandidates(db: DatabaseSync, ts: string, parts: UpdateSourceParts): QueuedTask[] {
  const { rules } = parts
  return openCandidates(db, ts, 'update', withTheHeadsARerunIsDueOn(db, all(db), candidateRows(db, openPrsWithTheirUpdateCauses(parts.topPriority), updateDue(recordedOrder(db), aMergeCandidate(db, ts, rules), decidedPastRoundLimit(db, ts, rules)), rules.mergedCards(db))), rules)
}

function updatesSpentBeforeAMergeSentThem(db: DatabaseSync, ts: string, parts: UpdateSourceParts): RequeueRow[] {
  const { rules } = parts
  return (candidateRows(db, aMergeSentToUpdate(parts.topPriority), aMergeCandidate(db, ts, rules), rules.mergedCards(db)) as (Candidate & { sent_at: number })[]).flatMap((row) => {
    const spent: RequeueRow = { task_key: keyOf({ queue: 'update', cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, decision: cardDecisionKeyOf('update', row.card_id, () => rules.decisionsAt(db, ts)) }), queue: 'update', card_id: row.card_id, pr: row.pr, head: row.head, failure: Number(row.sent_at) }
    const task = taskRow(db, spent.task_key)
    return task?.state === COMPLETED && Number(task.event_id) < spent.failure ? [spent] : []
  })
}

export function updateSource(parts: UpdateSourceParts): QueueSource {
  return { queue: 'update', requeue: (db, ts) => updatesSpentBeforeAMergeSentThem(db, ts, parts) }
}
