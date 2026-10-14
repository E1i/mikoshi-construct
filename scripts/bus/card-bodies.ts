import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask } from '../../src/card/parking.js'
import type { StoredEvent } from './stored.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'

export const CARD_BODIES = 'card_bodies'

interface ParsedColumns {
  who: string | null
  priority: string | null
  branch: string | null
  touches: string | null
  creates: string | null
  card_line: string | null
  contour: string | null
  decision: string | null
  depends: string | null
}

const UNPARSED: ParsedColumns = { who: null, priority: null, branch: null, touches: null, creates: null, card_line: null, contour: null, decision: null, depends: null }

function columnsOf(parked: ParkedTask): ParsedColumns {
  const { task } = parked
  return {
    who: parked.who,
    priority: parked.priority,
    branch: task.branch,
    touches: JSON.stringify(task.touches),
    creates: JSON.stringify(parked.creates),
    card_line: task.card.line,
    contour: task.card.contour,
    decision: task.card.decision,
    depends: JSON.stringify(task.card.depends),
  }
}

function payloadOrNull(event: StoredEvent): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(event.payload) as unknown
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

export function foldCardBody(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOrNull(event)
  const text = payload?.text
  if (event.card_id === null || typeof text !== 'string' || payload?.textSha !== textSha(text))
    return
  const parsed = parseParkingFile(`${event.card_id}.md`, text)
  const columns = parsed.kind === 'parked' ? columnsOf(parsed.parked) : UNPARSED
  const lane = typeof payload.lane === 'string' ? payload.lane : null
  db.prepare(`
    INSERT INTO ${CARD_BODIES} (card_id, admission_event_id, text, text_sha, lane, who, priority, branch, touches, creates, card_line, contour, decision, depends)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET admission_event_id = excluded.admission_event_id, text = excluded.text, text_sha = excluded.text_sha,
      lane = excluded.lane, who = excluded.who, priority = excluded.priority, branch = excluded.branch, touches = excluded.touches,
      creates = excluded.creates, card_line = excluded.card_line, contour = excluded.contour, decision = excluded.decision, depends = excluded.depends
  `).run(event.card_id, event.id, text, payload.textSha, lane, columns.who, columns.priority, columns.branch, columns.touches, columns.creates, columns.card_line, columns.contour, columns.decision, columns.depends)
}
