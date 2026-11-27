import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../../core/events-query.js'
import type { CardBodiesBus, RequestContext, RequestExecutor } from './context.js'
import type { AdmitResult, AmendedStop, AmendFlags, CardAdmissionsPort, CardEventPort } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { bodyLineOf, heldCardStates } from '../../core/card-readings.js'
import { events } from '../../core/events-query.js'
import { withWitnessRecords, witnessRecordsOf } from '../../quality/witness-records.js'
import { answerToResumeAfterAmend, appendCardEvent, bodyNotFoldedYet, BusDecisions, CARD_ADMITTED, cardBodyText, cardIdOf, correctionText, INTAKE_ACTOR_PREFIX, inTransaction, laid, launchWaitsOf, layLanes, OPEN_OWNER_STOP_OF_CARD, queueAgain, repositoryLanes, runAmend } from './reach.js'
import { messageOf, text } from './request.js'

const HELD_WITHOUT_STATE = 'held'

function latestIntakeAdmission(db: DatabaseSync, cardId: number): EventRow | null {
  return events(db, { types: [CARD_ADMITTED], card: cardId, actorPrefix: INTAKE_ACTOR_PREFIX, present: ['bodySha'], newestFirst: true })
    .find(row => typeof row.data?.card === 'string') ?? null
}

function latestAdmissionOf(db: DatabaseSync): CardAdmissionsPort {
  return (cardId) => {
    const row = latestIntakeAdmission(db, cardId)
    if (row === null)
      return null
    const { card, bodySha, confirmation, source } = row.data as { card: string, bodySha: unknown, confirmation: unknown, source: unknown }
    const body = cardBodyText(db, cardId)
    const admission = { card, bodySha, ts: row.ts, confirmation, source, event: row.id }
    return withWitnessRecords(body === null ? admission : { ...admission, text: body }, witnessRecordsOf(db, cardId))
  }
}

function textList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : undefined
}

function amendFlagsOf(payload: RequestPayload): AmendFlags {
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

function amendEvents(context: RequestContext, bus: CardBodiesBus, request: number): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}request-${request}`
  return event => inTransaction(context.db, () => {
    if (event.type !== CARD_ADMITTED) {
      appendCardEvent(bus, context.db, actor, event)
      return
    }
    appendCardEvent(bus, context.db, actor, laid(context.db, event))
    layLanes(context.db, repositoryLanes(context.repository)(), event.ts, actor, event.cardId)
  })
}

function resumeAfterAmend(context: RequestContext, request: number, cardId: number, stop: AmendedStop, payload: RequestPayload): string {
  const task = answerToResumeAfterAmend(context.db, cardId, stop, text(payload.touches))
  try {
    if (typeof task !== 'string')
      inTransaction(context.db, () => queueAgain(context.db, context.now(), task, request, `request-${request}`))
    return typeof task === 'string' ? task : `the stop ${stop.id} is settled: its answer ${task.task_key} queued again`
  }
  catch (error) {
    return `the stop ${stop.id} is settled but its answer stays: ${messageOf(error)}; card #${cardId} waits for the window's takeover`
  }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const { db, bus } = context
  const cardId = cardIdOf(payload.card)
  if (cardId === null)
    return { done: false, why: 'amend names no card' }
  if (bus === null)
    return { done: false, why: `#${cardId}: this request runner was composed without the bus contract; amend runs only under bus:run` }
  if (bodyNotFoldedYet(bus, db, cardId))
    return { done: false, why: `#${cardId}: the bus has not folded its latest body yet; ask again on the next tick` }
  const lane = bodyLineOf(db, cardId)?.lane ?? null
  const stop = db.prepare(OPEN_OWNER_STOP_OF_CARD).get(cardId) as { id: number, payload: string } | undefined
  const cardStates = (): Map<string, string> => new Map([...heldCardStates(db)].map(([card, state]) => [String(card), state ?? HELD_WITHOUT_STATE]))
  const result = runAmend({ card: `#${cardId}`, flags: amendFlagsOf(payload), dir: context.repository, dryRun: false, autoConfirm: payload.auto_confirm === true, events: amendEvents(context, bus, request), admissions: latestAdmissionOf(db), decisions: new BusDecisions(db), cardStates, cardWaits: launchWaitsOf(db, context.repository) }, context.clock)
  const answered = amendAnswer(cardId, result, lane)
  return stop === undefined || result.status !== 'admitted' ? answered : { done: true, why: `${answered.why}; ${resumeAfterAmend(context, request, cardId, stop, payload)}` }
}
