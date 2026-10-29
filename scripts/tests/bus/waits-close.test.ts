import type { BusEvent } from '../../core/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { admitCommandOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'

const TS = '2026-10-29T12:00:00.000Z'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'waits-close-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function admitted(cardId: number, lane: string): BusEvent {
  sequence += 1
  return { ts: TS, type: 'card.admitted', actor: 'reducer', cardId, pr: null, head: null, dedupeKey: `card.admitted:${sequence}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false }
}

function waits(db: ReturnType<typeof openBus>): unknown[][] {
  return (db.prepare('SELECT id, card_id, state, answer FROM owner_waits ORDER BY id').all() as { id: string, card_id: number, state: string, answer: string | null }[])
    .map(row => [row.id, row.card_id, row.state, row.answer])
}

describe('a card amend closes the waits that asked for it', () => {
  it('an amend that removes the cause closes the wait', () => {
    const db = newBus()
    appendEvent(db, admitted(1407, 'lane-21'))
    const amend = openOwnerWait(db, TS, 'policy', { need: 'command', text: 'card #1407 asks to widen its touches', command: admitCommandOf(1407, 'lane-21'), card: 1407 })
    const question = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'which path?', card: 1407, request: 3 })
    const other = openOwnerWait(db, TS, 'policy', { need: 'command', text: 'card #1408 asks to widen its touches', command: admitCommandOf(1408, 'lane-22'), card: 1408 })
    reduce(db)
    expect(waits(db).filter(row => row[2] === 'open')).toHaveLength(3)
    appendEvent(db, admitted(1407, 'lane-21'))
    reduce(db)
    expect(waits(db)).toEqual([
      [amend, 1407, 'closed', 'card #1407 amended'],
      [question, 1407, 'open', null],
      [other, 1408, 'open', null],
    ])
    db.close()
  })

  it('an admission before the wait opened leaves it open', () => {
    const db = newBus()
    appendEvent(db, admitted(1407, 'lane-21'))
    const amend = openOwnerWait(db, TS, 'policy', { need: 'command', text: 'card #1407 asks to widen its touches', command: admitCommandOf(1407, 'lane-21'), card: 1407 })
    reduce(db)
    expect(waits(db)).toEqual([[amend, 1407, 'open', null]])
    db.close()
  })
})
