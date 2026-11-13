import type { BusEvent } from '../../core/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AMEND_SOURCE } from '../../../src/commands/intake/admit.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { OWNER } from '../../core/inbox.js'
import { admitCommandOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'

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

function admitted(cardId: number, lane: string, extra: Record<string, unknown> = {}): BusEvent {
  sequence += 1
  return { ts: TS, type: 'card.admitted', actor: 'reducer', cardId, pr: null, head: null, dedupeKey: `card.admitted:${sequence}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], ...extra }, legacy: false }
}

function event(type: string, cardId: number | null, pr: number | null, payload: Record<string, unknown>, actor = 'reducer'): BusEvent {
  sequence += 1
  return { ts: TS, type, actor, cardId, pr, head: null, dedupeKey: `${type}:${sequence}`, payload, legacy: false }
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
    reduce(db, 'pending', busProjections())
    expect(waits(db).filter(row => row[2] === 'open')).toHaveLength(3)
    appendEvent(db, admitted(1407, 'lane-21'))
    reduce(db, 'pending', busProjections())
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
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([[amend, 1407, 'open', null]])
    db.close()
  })

  it('an amend admission closes the decision wait opened before it and leaves one opened after it', () => {
    const db = newBus()
    appendEvent(db, admitted(1475, 'lane-21'))
    const before = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'widen the touches?', card: 1475, request: 3 })
    const other = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'which path?', card: 1476, request: 4 })
    const merge = openOwnerWait(db, TS, 'policy', { need: 'merge', text: 'changes security invariants', card: 1475, pr: 1475 })
    appendEvent(db, admitted(1475, 'lane-21', { source: AMEND_SOURCE }))
    const after = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'a later question', card: 1475, request: 5 })
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([
      [before, 1475, 'closed', 'card #1475 amended'],
      [other, 1476, 'open', null],
      [merge, 1475, 'open', null],
      [after, 1475, 'open', null],
    ])
    db.close()
  })
})

describe('an answer or a merge closes the waits it settles', () => {
  it('an owner decision scoped to the card closes its question and leaves the next reading', () => {
    const db = newBus()
    const question = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'which path?', card: 1382, request: 3 })
    const other = openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'which release?', card: 1383, request: 4 })
    reduce(db, 'pending', busProjections())
    appendEvent(db, event('decision.recorded', null, null, { source: 'owner', decision_id: 259, text: '#1382 takes the cheap path', scope: [1382] }, OWNER))
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([[question, 1382, 'closed', 'D-259'], [other, 1383, 'open', null]])
    expect((db.prepare(`SELECT id FROM owner_waits WHERE state = 'open'`).all() as { id: string }[]).map(row => row.id)).toEqual([other])
    db.close()
  })

  it('an owner decision scoped to the card closes a command wait of the card and leaves another card\'s wait and a merge wait', () => {
    const db = newBus()
    const command = openOwnerWait(db, TS, 'policy', { need: 'command', text: 'card #1447 asks to widen its touches', command: 'pnpm some-command', card: 1447 })
    const other = openOwnerWait(db, TS, 'policy', { need: 'command', text: 'card #1448 asks to widen its touches', command: 'pnpm other-command', card: 1448 })
    const merge = openOwnerWait(db, TS, 'policy', { need: 'merge', text: 'changes security invariants', card: 1447, pr: 1447 })
    reduce(db, 'pending', busProjections())
    appendEvent(db, event('decision.recorded', null, null, { source: 'owner', decision_id: 296, text: '#1447 takes the wider touches', scope: [1447] }, OWNER))
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([
      [command, 1447, 'closed', 'D-296'],
      [other, 1448, 'open', null],
      [merge, 1447, 'open', null],
    ])
    db.close()
  })

  it('a merged pull request closes its merge wait', () => {
    const db = newBus()
    appendEvent(db, event('pr.observed', 1098, 1098, { base: 'main', head: 'a'.repeat(40), mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }))
    const merge = openOwnerWait(db, TS, 'policy', { need: 'merge', text: 'changes security invariants', card: 1098, pr: 1098 })
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([[merge, 1098, 'open', null]])
    appendEvent(db, event('pr.closed', 1098, 1098, { merged: true }))
    reduce(db, 'pending', busProjections())
    expect(waits(db)).toEqual([[merge, 1098, 'closed', 'PR #1098 merged']])
    db.close()
  })
})
