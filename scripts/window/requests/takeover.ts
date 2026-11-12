import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed, RequestPayload } from './request.js'
import { windowSessionEndGround } from '../window-session-end.js'
import { appendEvent, CARD_ADMITTED, CARD_ANSWERED, CARD_HELD, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, cardIdOf, inTransaction, OPEN_OWNER_STOP_OF_CARD, openPrOfCard, OWNER, ownerHoldGround, WITNESS_RECORDED } from './reach.js'
import { TAKEOVER_AFTER_MINUTES, text } from './request.js'

const MS_PER_MINUTE = 60_000

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

function noRouteGround(context: RequestContext, cardId: number): { named: string } | string {
  const { db } = context
  const turn = context.latestTurn(cardId)
  const stop = db.prepare(OPEN_OWNER_STOP_OF_CARD).get(cardId) as { id: number } | undefined
  if (stop !== undefined && stop.id === turn?.id)
    return { named: `the owner stop ${stop.id} is its latest turn and has no lift` }
  const witness = db.prepare(LATEST_WITNESS_OF_CARD).get(cardId) as { head: string | null, verdict: unknown } | undefined
  if (witness?.verdict === 'green' && openPrOfCard(db, cardId) === null)
    return { named: `its witnesses are green at ${witness.head ?? 'its head'} and it has no open pull request` }
  const answerNeeded = db.prepare(OPEN_PR_ANSWER_NEEDED).get(cardId) as { pr: number } | undefined
  if (turn?.type !== CARD_STOPPED && answerNeeded === undefined)
    return `card #${cardId} is in no state that needs an answer or launch task, and no stop without a lift or green witness without a pull request names it; the bus has its route`
  const moved = db.prepare(LAST_MOVE_OF_CARD).get(cardId, cardId) as { ts: string } | undefined
  if (moved === undefined)
    return `card #${cardId} has no recorded turn or task to measure the ${TAKEOVER_AFTER_MINUTES} minutes from; the bus has not taken it yet`
  const minutes = Math.floor((context.clock().getTime() - Date.parse(moved.ts)) / MS_PER_MINUTE)
  return minutes >= TAKEOVER_AFTER_MINUTES
    ? { named: `no answer or launch task ran for ${minutes} minutes` }
    : `card #${cardId} last moved ${minutes} minutes ago, under the ${TAKEOVER_AFTER_MINUTES} a takeover waits for an answer or launch task`
}

export function takeover(context: RequestContext, request: number, payload: RequestPayload, owner = false): Executed {
  const { db } = context
  const cardId = cardIdOf(payload.card)
  const reason = text(payload.reason) ?? (owner ? `the owner's move` : null)
  if (cardId === null || reason === null)
    return { done: false, why: 'takeover needs a card and the reason the bus has no route for it' }
  const route = context.routeOf(cardId, owner)
  if (route !== null)
    return { done: false, why: route }
  const ground = owner ? { named: `the owner's word, with no ${TAKEOVER_AFTER_MINUTES} minutes and no route to wait out` } : windowSessionEndGround(db, cardId) ?? ownerHoldGround(db, cardId) ?? noRouteGround(context, cardId)
  if (typeof ground !== 'object')
    return { done: false, why: ground }
  const ts = context.now()
  const actor = owner ? OWNER : context.actorOf(request)
  inTransaction(db, () => {
    appendEvent(db, { ts, type: CARD_HELD, actor, cardId, pr: null, head: null, dedupeKey: `${CARD_HELD}:request-${request}`, payload: { request, reason, takeover: true }, legacy: false })
    appendEvent(db, { ts, type: CARD_TAKEOVER, actor, cardId, pr: null, head: null, dedupeKey: `${CARD_TAKEOVER}:request-${request}`, payload: { request, reason, ground: ground.named }, legacy: false })
  })
  return { done: true, why: `${CARD_TAKEOVER} #${cardId} (${ground.named}): ${reason}` }
}

export const execute: RequestExecutor = (context, request, payload) => takeover(context, request, payload)
