import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../../core/events-query.js'
import type { RequestContext, RequestExecutor } from './context.js'
import type { RequestPayload } from './request.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { EITHER_JOURNAL, events } from '../../core/events-query.js'
import { plans } from '../../core/plan-readings.js'
import { appendEvent, CARD_PLANNED, CARD_UNPLANNED, cardIdOf, MAIN_REF, OWNER, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_OPENED, VERSION_PR_REF } from './reach.js'
import { PLAN_OPS, text } from './request.js'

function ownerEventsOf(db: DatabaseSync, type: string): EventRow[] {
  return events(db, { types: [type], valid: true, legacy: EITHER_JOURNAL }).filter(row => row.actor === OWNER)
}

function releaseOpenInTheLog(db: DatabaseSync, plan: string): boolean {
  const opened = ownerEventsOf(db, PLAN_OPENED).find(row => row.data?.id === plan)
  return opened !== undefined && !ownerEventsOf(db, PLAN_CLOSED).some(row => row.id > opened.id && row.data?.plan === plan)
}

function planEventPayload(context: RequestContext, type: string, plan: string, payload: RequestPayload): RequestPayload | string {
  const gate = text(payload.gate)
  if (type === PLAN_OPENED) {
    const title = text(payload.title)
    const file = text(payload.file)
    const goal = text(payload.goal)
    if (title === null || goal === null || file === null || !path.isAbsolute(file) || !existsSync(file))
      return `${type} needs a --title, a --goal and an absolute --file that exists`
    const version = context.releaseVersion()
    if (version === null)
      return `${type} could not fetch and read the version changesets will release from ${MAIN_REF} and ${VERSION_PR_REF}`
    return { id: plan, title, goal, plan_file: file, version, ...(gate === null ? {} : { gate }) }
  }
  if (type === PLAN_CLOSED)
    return { plan }
  if (type === PLAN_BACKFILLED) {
    const cards = plans.linkedCards(context.db, plan)
    if (gate === null || cards.length === 0)
      return `${type} needs a --gate and a plan whose items link cards`
    return { plan, gate, cards }
  }
  const card = cardIdOf(payload.card)
  if (card === null)
    return `${type} needs a --card`
  if (type === CARD_UNPLANNED)
    return { card }
  if (!releaseOpenInTheLog(context.db, plan))
    return `${type}: release ${plan} is not open`
  return { release: plan, card }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const type = PLAN_OPS.get(String(payload.op))
  const plan = text(payload.plan)
  if (type === undefined || (plan === null && type !== CARD_UNPLANNED))
    return { done: false, why: `plan needs --op ${[...PLAN_OPS.keys()].join('|')} and a --plan id; remove needs only the --card` }
  const event = planEventPayload(context, type, plan ?? '', payload)
  if (typeof event === 'string')
    return { done: false, why: event }
  const cardId = cardIdOf(payload.card)
  appendEvent(context.db, { ts: context.now(), type, actor: OWNER, cardId: type === CARD_PLANNED || type === CARD_UNPLANNED ? cardId : null, pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { ...event, request }, legacy: false })
  return { done: true, why: `${type}${plan === null ? '' : ` ${plan}`}${cardId === null ? '' : ` #${cardId}`}` }
}
