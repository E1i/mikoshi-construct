import type { DatabaseSync } from 'node:sqlite'
import { firstOfTypesOrNewHeadSince } from '../core/events-query.js'
import { CARD_ADMITTED, CHAIN_OBSERVED, MERGE_DONE, PR_OBSERVED, REVIEW_RECORDED } from '../core/events.js'

export { lastEventId } from '../core/watermark.js'

export const OPERATOR_WORK_EVENTS = [REVIEW_RECORDED, MERGE_DONE, CHAIN_OBSERVED, CARD_ADMITTED] as const

export function operatorWorkSince(db: DatabaseSync, cursor: number): number | null {
  return firstOfTypesOrNewHeadSince(db, cursor, OPERATOR_WORK_EVENTS, PR_OBSERVED)
}
