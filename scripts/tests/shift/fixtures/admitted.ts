import { parseCard } from '../../../../src/card/grammar.js'
import { appendEvent, openBus } from '../../../core/db.js'

export function admitCards(bus: string, lines: string[]): void {
  const db = openBus(bus)
  try {
    for (const line of lines) {
      const parsed = parseCard(line)
      if (parsed.kind !== 'card')
        throw new Error(`not a card: ${line}`)
      const { id, depends, decision, contour } = parsed.card
      appendEvent(db, { ts: '2026-10-03T00:00:00.000Z', type: 'card.admitted', actor: 'worker:intake:test', cardId: id, pr: null, head: null, dedupeKey: `card.admitted:${id}:${line}`, payload: { card: line, lane: null, depends, decision, contour }, legacy: false })
    }
  }
  finally {
    db.close()
  }
}
