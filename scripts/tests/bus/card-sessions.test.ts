import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_CONTINUED, CARD_STARTED } from '../../core/events.js'
import { busCardSessions } from '../../nodes/launch/launch-root.js'

const CARD = 1583
const STARTED = '221f6276'
const FIRST_CONTINUATION = '819e7cbf'
const SECOND_CONTINUATION = 'ddfa773b'

describe('busCardSessions', () => {
  it('busCardSessions names a session that continued the card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'card-sessions-'))
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const event = (id: number, type: string, session: string): void => {
      appendEvent(db, { ts: `2026-11-05T10:00:0${id}.000Z`, type, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `test:${id}`, payload: { session }, legacy: false })
    }
    try {
      event(1, CARD_STARTED, STARTED)
      event(2, CARD_CONTINUED, FIRST_CONTINUATION)
      event(3, CARD_CONTINUED, SECOND_CONTINUATION)
      db.close()

      expect(busCardSessions(busPath)(CARD)).toEqual([STARTED, FIRST_CONTINUATION, SECOND_CONTINUATION])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
