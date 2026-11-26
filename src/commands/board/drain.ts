import type { Lore } from '../../ui/lore.js'
import type { BusDb } from '../cost/bus.js'
import { EITHER_JOURNAL, lastPer, latest } from '../../../scripts/core/card-readings.js'
import { LEASES_DRAINING, RESTARTED } from '../../../scripts/core/events.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { SHORT_SHA } from './bus.js'

export interface BoardDrain {
  node: string
  sha: string
  from: string | null
  until: string
}

const DRAIN_NODE = '$.node'

function lastDrainOfEachNodeSinceRestart(db: BusDb): BoardDrain[] {
  const restart = latest(db, { types: [RESTARTED], legacy: EITHER_JOURNAL })?.id ?? 0
  return lastPer(db, DRAIN_NODE, { types: [LEASES_DRAINING], since: restart, legacy: EITHER_JOURNAL })
    .flatMap(row => drainOf(row.payload) ?? [])
    .sort((a, b) => a.node < b.node ? -1 : a.node > b.node ? 1 : 0)
}

function drainOf(payload: string): BoardDrain | null {
  const { node, sha, from, until } = JSON.parse(payload) as Record<string, unknown>
  if (typeof node !== 'string' || typeof sha !== 'string' || typeof until !== 'string')
    return null
  return { node, sha, from: typeof from === 'string' ? from : null, until }
}

export function openDrains(db: BusDb, now: Date): BoardDrain[] {
  const at = now.toISOString()
  return lastDrainOfEachNodeSinceRestart(db).filter(drain => drain.until > at)
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
