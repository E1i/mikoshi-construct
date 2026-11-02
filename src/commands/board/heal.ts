import type { Lore } from '../../ui/lore.js'
import type { BusDb } from '../cost/bus.js'
import { BUS_HEAL_HELD, BUS_HEALED } from '../../../scripts/core/events.js'
import { withReadOnlyBus } from '../cost/bus.js'

export const HEALED_SHOWN_HOURS = 24
const HOUR_MS = 60 * 60_000
const HEAL_ROLE = 'heal'

export interface BoardHeal {
  kind: 'healed' | 'held'
  at: string
  backup: string | null
  done: string
}

const LAST_HEAL = `
  SELECT type, ts, payload FROM events
  WHERE type IN ('${BUS_HEALED}', '${BUS_HEAL_HELD}') AND json_valid(payload)
  ORDER BY id DESC LIMIT 1
`

function healOf(row: { type: string, ts: string, payload: string }): BoardHeal {
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  const backup = typeof payload.backup === 'string' ? payload.backup : null
  if (row.type === BUS_HEAL_HELD)
    return { kind: 'held', at: row.ts, backup, done: typeof payload.failure === 'string' ? payload.failure : '' }
  const broken = Array.isArray(payload.broken) ? payload.broken.length : 0
  const steps = Array.isArray(payload.steps) ? payload.steps.filter(each => typeof each === 'string') : []
  return { kind: 'healed', at: row.ts, backup, done: `${broken} broken · ${steps.join(' → ')}` }
}

export function lastHeal(db: BusDb, now: Date): BoardHeal | null {
  const row = db.prepare(LAST_HEAL).get() as { type: string, ts: string, payload: string } | undefined
  if (row === undefined)
    return null
  const heal = healOf(row)
  return heal.kind === 'held' || now.getTime() - Date.parse(heal.at) <= HEALED_SHOWN_HOURS * HOUR_MS ? heal : null
}

export function healAt(file: string, now: Date): BoardHeal | null {
  try {
    return withReadOnlyBus(file, db => lastHeal(db, now))
  }
  catch {
    return null
  }
}

export function healLines(lore: Lore, heal: BoardHeal | null): string[] {
  return heal === null ? [] : [lore.boardServiceLine(HEAL_ROLE, heal.kind, heal.backup ?? undefined, `${heal.at} · ${heal.done}`)]
}
