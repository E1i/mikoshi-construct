import { existsSync } from 'node:fs'
import { BUSY_TIMEOUT_MS, defaultBusPath, openBus } from './db.js'
import { events } from './events-query.js'
import { GHOST_LINE } from './events.js'
import { legacyHistory } from './legacy-history.js'
import { openDatabase } from './sqlite.js'
import { payloadOf } from './stored.js'

export type JournalEvent = Record<string, unknown>

export type GhostLine = Record<string, unknown>

export function ghostLines(busPath: string = defaultBusPath()): GhostLine[] {
  if (!existsSync(busPath))
    return []
  const db = openBus(busPath)
  try {
    return events(db, { types: [GHOST_LINE] }).map(payloadOf)
  }
  finally {
    db.close()
  }
}

export function busHistory(busPath: string = defaultBusPath()): JournalEvent[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return legacyHistory(db)
  }
  finally {
    db.close()
  }
}

export function ghostLinesText(busPath: string = defaultBusPath()): string {
  return ghostLines(busPath).map(line => `${JSON.stringify(line)}\n`).join('')
}
