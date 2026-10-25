export const BACKFILL_SOURCE = 'backfill'

export const NOT_A_BACKFILL = `json_extract(payload, '$.source') IS NOT '${BACKFILL_SOURCE}'`

export function isBackfill(payload: Record<string, unknown>): boolean {
  return payload.source === BACKFILL_SOURCE
}
