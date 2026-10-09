import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../bus/db.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { projectionDump, reduce } from '../../bus/reducer.js'

const HEADS = ['0123456789abcdef0123456789abcdef01234567', '89abcdef0123456789abcdef0123456789abcdef']
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-replay-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function live(type: string, dedupeKey: string, fields: Partial<BusEvent>): BusEvent {
  return { ts: '2026-10-09T12:00:00.000Z', type, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey, payload: {}, legacy: false, ...fields }
}

function observed(pr: number, cardId: number, head: string, ci: string): BusEvent {
  return live('pr.observed', `pr:${pr}:${head}:${ci}`, { pr, cardId, head, payload: { base: 'main', head, mergeable: 'clean', ci, auto_merge: false, draft: false } })
}

const LOG: BusEvent[] = [
  { ...observed(799, 790, HEADS[0]!, 'green'), actor: null, legacy: true, dedupeKey: 'legacy:1' },
  observed(800, 793, HEADS[0]!, 'pending'),
  observed(801, 794, HEADS[0]!, 'green'),
  live('pr.opened', 'pr.opened:795', { actor: 'worker:launch:s1', cardId: 795, payload: { pr: 802 } }),
  observed(800, 793, HEADS[1]!, 'green'),
  live('pr.closed', 'pr:801:closed', { pr: 801, payload: { merged: true, commit: MAIN } }),
  live('main.advanced', `main:${MAIN}`, { payload: { sha: MAIN, touches_mechanics: true } }),
  live('pr.opened', 'pr.opened:793', { actor: 'worker:launch:s2', cardId: 793, payload: { pr: 803 } }),
  live('pr.closed', 'pr:804:closed', { pr: 804, payload: { merged: false } }),
  live('card.started', 'card.started:796', { actor: 'worker:launch:s3', cardId: 796, payload: { session: 's3' } }),
  observed(802, 795, HEADS[1]!, 'red'),
]

function replayedFromEmpty(log: readonly { [key: string]: unknown }[]): string {
  const db = newBus()
  for (const row of log) {
    db.prepare(`INSERT INTO events (id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id as number, row.ts as string | null, row.type as string, row.actor as string | null, row.card_id as number | null, row.pr as number | null, row.head as string | null, row.dedupe_key as string, row.payload as string, row.legacy as number)
  }
  reduce(db)
  const dump = projectionDump(db)
  db.close()
  return dump
}

describe('replay determinism', () => {
  it('replaying the log from empty twice gives byte-identical prs, cards and tasks dumps', () => {
    const source = newBus()
    for (const each of LOG)
      appendEvent(source, each)
    reduce(source)
    const live = projectionDump(source)
    const log = source.prepare('SELECT * FROM events ORDER BY id').all()
    source.close()

    const first = replayedFromEmpty(log)
    const second = replayedFromEmpty(log)
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
    expect(first).toBe(live)
    const dump = JSON.parse(first) as { prs: unknown[], cards: unknown[], tasks: unknown[] }
    expect(dump.prs).toHaveLength(3)
    expect(dump.cards).toHaveLength(3)
  })

  it('a replay of the events alone, without the rejections the reducer wrote, rebuilds the same projections', () => {
    const source = newBus()
    for (const each of LOG)
      appendEvent(source, each)
    reduce(source)
    const live = projectionDump(source)
    const log = source.prepare(`SELECT * FROM events WHERE type != 'reducer.rejected' ORDER BY id`).all()
    expect(log.length).toBeLessThan((source.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
    source.close()

    expect(replayedFromEmpty(log)).toBe(live)
  })
})
