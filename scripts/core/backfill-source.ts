import { BACKFILL_SOURCE } from './identifiers.js'

export { BACKFILL_SOURCE }

export const NOT_A_BACKFILL = `json_extract(payload, '$.source') IS NOT '${BACKFILL_SOURCE}'`

export function isBackfill(payload: Record<string, unknown>): boolean {
  return payload.source === BACKFILL_SOURCE
}
