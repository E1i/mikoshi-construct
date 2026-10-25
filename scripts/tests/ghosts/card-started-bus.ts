import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED } from '../../core/events.js'
import { legacyEventOf } from '../../intake/import.js'

export function journalInBus(busPath: string, journal: readonly string[]): void {
  const db = openBus(busPath)
  try {
    journal.forEach((line, index) => {
      const event = legacyEventOf(line, index + 1)
      if (event !== null)
        appendEvent(db, event)
    })
  }
  finally {
    db.close()
  }
}

export interface StartedBus {
  file: string
  remove: () => void
}

export function busWithCardStarted(starts: { cardId: number, ts: string, payload: Record<string, unknown> }[]): StartedBus {
  const dir = mkdtempSync(path.join(tmpdir(), 'card-started-bus-'))
  const file = path.join(dir, 'bus.db')
  const db = openBus(file)
  try {
    for (const [index, start] of starts.entries())
      appendEvent(db, { ts: start.ts, type: CARD_STARTED, actor: 'worker:start:window', cardId: start.cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${start.cardId}:${index}`, payload: start.payload, legacy: false })
  }
  finally {
    db.close()
  }
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
