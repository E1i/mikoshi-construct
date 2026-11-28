import { describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { admittedCardRow } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'

const CARD = 4242
const LANE = 'lane-1'
const STATE = 'started'
const TEXT = `card: #${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nThe admitted text.\n`

describe('admittedCardRow reads the admitted body of a card with the state its cards row holds', () => {
  it('returns the body, its admission and lane, with no state until the cards row holds one', () => {
    const db = openBus(':memory:')
    try {
      appendEvent(db, { ts: '2026-11-28T09:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: LANE, decision: 'auto', contour: 'cheap', depends: [], admission: 'a1', text: TEXT, textSha: textSha(TEXT) }, legacy: false })
      const admission = (db.prepare('SELECT id FROM events WHERE type = ?').get(CARD_ADMITTED) as { id: number }).id
      db.prepare('INSERT OR REPLACE INTO card_bodies (card_id, admission_event_id, text, text_sha, lane) VALUES (?, ?, ?, ?, ?)').run(CARD, admission, TEXT, textSha(TEXT), LANE)
      expect(admittedCardRow(db, CARD)).toEqual({ admission_event_id: admission, text: TEXT, text_sha: textSha(TEXT), lane: LANE, state: null })
      db.prepare('INSERT OR REPLACE INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, ?)').run(CARD, STATE, null, admission)
      expect(admittedCardRow(db, CARD)).toEqual({ admission_event_id: admission, text: TEXT, text_sha: textSha(TEXT), lane: LANE, state: STATE })
    }
    finally {
      db.close()
    }
  })

  it('returns null for a card with no admitted body', () => {
    const db = openBus(':memory:')
    try {
      expect(admittedCardRow(db, CARD)).toBeNull()
    }
    finally {
      db.close()
    }
  })
})
