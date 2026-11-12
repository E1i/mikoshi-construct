import type { BusEvent } from '../../core/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { REJECTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'

const CARD = 1843
const PR = 1601
const OLD_HEAD = '0123456789abcdef0123456789abcdef01234567'
const NEW_HEAD = '89abcdef0123456789abcdef0123456789abcdef'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

function newBus(): Bus {
  const root = mkdtempSync(path.join(tmpdir(), 'answer-after-amend-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function event(type: string, fields: Partial<BusEvent>): BusEvent {
  sequence += 1
  return { ts: '2026-11-12T14:25:50.000Z', type, actor: 'netwatch', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${sequence}`, payload: {}, legacy: false, ...fields }
}

const admitted = (): BusEvent => event('card.admitted', { actor: 'reducer', payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [] } })
const started = (): BusEvent => event('card.started', { actor: 'worker:launch:s1', payload: { session: 's1' } })
const opened = (): BusEvent => event('pr.opened', { actor: 'worker:launch:s1', payload: { pr: PR } })
const observed = (head: string): BusEvent => event('pr.observed', { pr: PR, head, payload: { base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false } })
const reviewed = (head: string, verdict: string): BusEvent => event('review.recorded', { actor: 'worker:review:r1', pr: PR, head, payload: { head, verdict, reviewer_session: 'r1' } })
const stopped = (): BusEvent => event('card.stopped', { actor: 'worker:answer:a1', payload: { reason: 'review', detail: 'changes' } })
const answered = (): BusEvent => event('card.answered', { actor: 'worker:answer:a2', payload: { session: 'a2' } })

function stepThrough(db: Bus, steps: BusEvent[]): unknown[] {
  return steps.map((next) => {
    appendEvent(db, next)
    reduce(db)
    return stateOf(db)
  })
}

function stateOf(db: Bus): unknown {
  return (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: unknown } | undefined)?.state
}

function rejectionReasons(db: Bus): string[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(REJECTED) as { payload: string }[])
    .map(row => (JSON.parse(row.payload) as { reason: string }).reason)
}

function stoppedThenAmendedWithItsPullRequestOpen(db: Bus): void {
  stepThrough(db, [admitted(), started(), opened(), observed(OLD_HEAD), reviewed(OLD_HEAD, 'changes'), stopped(), admitted()])
}

describe('an answer after an amend', () => {
  it('an answer on a card re-admitted with an open PR is accepted and moves the card to review', () => {
    const db = newBus()
    stoppedThenAmendedWithItsPullRequestOpen(db)
    expect(stateOf(db)).toBe('queued')
    expect(stepThrough(db, [answered()])).toEqual(['in_review'])
    expect(rejectionReasons(db)).toEqual([])
    db.close()
  })

  it('an answer on a queued card with no open PR is still rejected', () => {
    const db = newBus()
    expect(stepThrough(db, [admitted(), answered()])).toEqual(['queued', 'queued'])
    expect(rejectionReasons(db)).toEqual([`card ${CARD} is queued, and card.answered moves only a card that is stopped | changes | in_review`])
    db.close()
  })

  it('after an amend the pushed answer ends the round with no empty answer on the old head', () => {
    const db = newBus()
    stoppedThenAmendedWithItsPullRequestOpen(db)
    expect(stepThrough(db, [answered(), observed(NEW_HEAD), reviewed(NEW_HEAD, 'pass')])).toEqual(['in_review', 'in_review', 'ready'])
    expect(db.prepare('SELECT head FROM prs WHERE pr = ?').get(PR)).toEqual({ head: NEW_HEAD })
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'card.stopped' AND json_extract(payload, '$.reason') = 'fault'`).get()).toEqual({ n: 0 })
    expect(rejectionReasons(db)).toEqual([])
    db.close()
  })
})
