import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { OWNER_WAIT_OPENED, SHARD_EXPIRED, SHARD_ISSUED } from '../../core/events.js'
import { DECISIONS_SCOPE, SHARD_NOTICE_HOURS } from '../../policy/shards.js'
import { shardRenewalCommand, shardTermParts } from '../../supervisor/composition.js'
import { SHARD_TERM_ACTOR, ShardTerm } from '../../supervisor/shard-term.js'

const NOW = new Date('2026-11-17T18:00:00.000Z')
const HOUR_MS = 3_600_000

const roots: string[] = []
const buses: DatabaseSync[] = []

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'shard-term-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  buses.push(db)
  return db
}

function issue(db: DatabaseSync, id: string, until: Date): void {
  appendEvent(db, { ts: NOW.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by: 'owner-word', run: null, window: true, scope: DECISIONS_SCOPE, until: until.toISOString() }, legacy: false })
}

function waits(db: DatabaseSync): { actor: string, text: string, need: string, command: string }[] {
  return (db.prepare(`SELECT actor, json_extract(payload, '$.text') AS text, json_extract(payload, '$.need') AS need, json_extract(payload, '$.command') AS command FROM events WHERE type = '${OWNER_WAIT_OPENED}' ORDER BY id`).all() as { actor: string, text: string, need: string, command: string }[])
}

function expiries(db: DatabaseSync): { actor: string, id: string }[] {
  return db.prepare(`SELECT actor, json_extract(payload, '$.id') AS id FROM events WHERE type = '${SHARD_EXPIRED}'`).all() as { actor: string, id: string }[]
}

function tickAt(db: DatabaseSync, at: Date): string[] {
  return new ShardTerm(db, () => at.getTime(), 'supervisor: ', shardTermParts()).step()
}

describe('the supervisor tick warns before a window shard ends and when it ends', () => {
  it('a window shard with less than the notice left opens one owner wait naming its id and its end', () => {
    const db = bus()
    const until = new Date(NOW.getTime() + HOUR_MS)
    issue(db, 'shard-ending', until)
    const lines = tickAt(db, NOW)
    expect(lines).toHaveLength(1)
    expect(waits(db)).toEqual([{ actor: SHARD_TERM_ACTOR, need: 'command', command: shardRenewalCommand(), text: expect.stringContaining('shard-ending') }])
    expect(waits(db)[0]!.text).toContain(until.toISOString())
    expect(waits(db)[0]!.text).toContain(DECISIONS_SCOPE)
    expect(waits(db)[0]!.text).toContain('1.0 h left')
    expect(expiries(db)).toEqual([])
  })

  it('a window shard past its end with nothing to merge is expired on the tick and leaves an owner wait', () => {
    const db = bus()
    issue(db, 'shard-gone', new Date(NOW.getTime() - HOUR_MS))
    const lines = tickAt(db, NOW)
    expect(expiries(db)).toEqual([{ actor: SHARD_TERM_ACTOR, id: 'shard-gone' }])
    expect(lines).toHaveLength(1)
    expect(waits(db)).toHaveLength(1)
    expect(waits(db)[0]!.text).toContain('shard-gone')
    expect(waits(db)[0]!.text).toContain('expired')
  })

  it('a second tick opens no second wait for the same shard', () => {
    const db = bus()
    issue(db, 'shard-ending', new Date(NOW.getTime() + HOUR_MS))
    issue(db, 'shard-other', new Date(NOW.getTime() + HOUR_MS / 2))
    expect(tickAt(db, NOW)).toHaveLength(1)
    expect(tickAt(db, new Date(NOW.getTime() + 60_000))).toEqual([])
    expect(tickAt(db, new Date(NOW.getTime() + 2 * HOUR_MS))).toEqual([])
    expect(waits(db)).toHaveLength(1)
    expect(expiries(db).map(row => row.id).sort()).toEqual(['shard-ending', 'shard-other'])
  })

  it('a window shard with more than the notice left opens no wait', () => {
    const db = bus()
    issue(db, 'shard-fresh', new Date(NOW.getTime() + (SHARD_NOTICE_HOURS + 1) * HOUR_MS))
    expect(tickAt(db, NOW)).toEqual([])
    expect(waits(db)).toEqual([])
    expect(expiries(db)).toEqual([])
  })
})
