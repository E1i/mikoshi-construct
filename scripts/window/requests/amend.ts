import type { DatabaseSync } from 'node:sqlite'
import type { RequestContext, RequestExecutor } from './context.js'
import type { AdmitResult, AmendedStop, AmendFlags, CardAdmissionsPort, CardEventPort } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { answerToResumeAfterAmend, appendCardEvent, bodyNotFoldedYet, BusDecisions, CARD_ADMITTED, CARD_BODIES, cardBodyText, cardIdOf, correctionText, INTAKE_ACTOR_PREFIX, inTransaction, laid, layLanes, OPEN_OWNER_STOP_OF_CARD, queueAgain, repositoryLanes, runAmend } from './reach.js'
import { messageOf, text } from './request.js'

const HELD_WITHOUT_STATE = 'held'
const CARD_STATES = `
  SELECT card_id, state FROM cards WHERE state IS NOT NULL
  UNION ALL
  SELECT DISTINCT card_id, NULL FROM events WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT card_id FROM cards WHERE state IS NOT NULL)
`
const LATEST_INTAKE_ADMISSION = `SELECT id, ts, payload FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND actor LIKE '${INTAKE_ACTOR_PREFIX}%' AND card_id = ? AND json_type(payload, '$.card') = 'text' AND json_extract(payload, '$.bodySha') IS NOT NULL ORDER BY id DESC LIMIT 1`

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

function amendEvents(context: RequestContext, request: number): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}request-${request}`
  return event => inTransaction(context.db, () => {
    if (event.type !== CARD_ADMITTED) {
      appendCardEvent(context.db, actor, event)
      return
    }
    appendCardEvent(context.db, actor, laid(context.db, event))
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
  const { db } = context
  const cardId = cardIdOf(payload.card)
  if (cardId === null)
    return { done: false, why: 'amend names no card' }
  if (bodyNotFoldedYet(db, cardId))
    return { done: false, why: `#${cardId}: the bus has not folded its latest body yet; ask again on the next tick` }
  const lane = (db.prepare(`SELECT lane FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { lane: string | null } | undefined)?.lane ?? null
  const stop = db.prepare(OPEN_OWNER_STOP_OF_CARD).get(cardId) as { id: number, payload: string } | undefined
  const cardStates = (): Map<string, string> => new Map((db.prepare(CARD_STATES).all() as unknown as { card_id: number, state: string | null }[]).map(row => [String(row.card_id), row.state ?? HELD_WITHOUT_STATE]))
  const result = runAmend({ card: `#${cardId}`, flags: amendFlagsOf(payload), dir: context.repository, dryRun: false, autoConfirm: payload.auto_confirm === true, events: amendEvents(context, request), admissions: latestAdmissionOf(db), decisions: new BusDecisions(db), cardStates }, context.clock)
  const answered = amendAnswer(cardId, result, lane)
  return stop === undefined || result.status !== 'admitted' ? answered : { done: true, why: `${answered.why}; ${resumeAfterAmend(context, request, cardId, stop, payload)}` }
}
