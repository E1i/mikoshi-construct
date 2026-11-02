import type { Lore } from '../../ui/lore.js'
import type { BusDb } from '../cost/bus.js'
import { LEASES_DRAINING, RESTARTED } from '../../../scripts/core/events.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { SHORT_SHA } from './bus.js'

export interface BoardDrain {
  node: string
  sha: string
  from: string | null
  until: string
}

const LAST_DRAIN_OF_EACH_NODE_SINCE_RESTART = `
  SELECT payload FROM events WHERE id IN (
    SELECT max(id) FROM events
    WHERE type = '${LEASES_DRAINING}' AND json_valid(payload)
      AND id > (SELECT coalesce(max(id), 0) FROM events WHERE type = '${RESTARTED}')
    GROUP BY json_extract(payload, '$.node')
  )
  ORDER BY json_extract(payload, '$.node')
`

function drainOf(payload: string): BoardDrain | null {
  const { node, sha, from, until } = JSON.parse(payload) as Record<string, unknown>
  if (typeof node !== 'string' || typeof sha !== 'string' || typeof until !== 'string')
    return null
  return { node, sha, from: typeof from === 'string' ? from : null, until }
}

export function openDrains(db: BusDb, now: Date): BoardDrain[] {
  const at = now.toISOString()
  return (db.prepare(LAST_DRAIN_OF_EACH_NODE_SINCE_RESTART).all() as { payload: string }[]).flatMap((row) => {
    const drain = drainOf(row.payload)
    return drain !== null && drain.until > at ? [drain] : []
  })
}

export function drainsAt(file: string, now: Date): BoardDrain[] {
  try {
    return withReadOnlyBus(file, db => openDrains(db, now))
  }
  catch {
    return []
  }
}

const short = (sha: string): string => sha.slice(0, SHORT_SHA)

const DRAIN_ROLE = 'drain'
const UNRECORDED_SHA = '?'

export function drainLines(lore: Lore, drains: readonly BoardDrain[]): string[] {
  return drains.map(drain => lore.boardServiceLine(DRAIN_ROLE, drain.node, undefined, `${drain.from === null ? UNRECORDED_SHA : short(drain.from)} \u2192 ${short(drain.sha)} until ${drain.until}`))
}
