import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { events } from '../../core/events-query.js'
import { OWNER_WAIT_OPENED, SHARD_EXPIRED, SHARD_ISSUED } from '../../core/events.js'
import { ownerWaitCommand } from '../../core/owner-commands.js'
import { activeWindowShards, DECISIONS_SCOPE, SHARD_NOTICE_HOURS } from '../../policy/shards.js'
import { SHARD_TERM_ACTOR, shardRenewalCommand, ShardTerm } from '../../supervisor/shard-term.js'

const NOW = new Date('2026-11-17T18:54:00.000Z')
const HOUR_MS = 3_600_000

const opened: { root: string, db: DatabaseSync }[] = []

afterEach(() => {
  for (const { root, db } of opened.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'shard-term-'))
  const db = openBus(path.join(root, 'bus.db'))
  opened.push({ root, db })
  return db
}

function issue(db: DatabaseSync, id: string, until: Date): void {
  appendEvent(db, { ts: new Date(until.getTime() - 6 * HOUR_MS).toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by: 'answers/ghost-protocol-6h', run: null, window: true, scope: DECISIONS_SCOPE, until: until.toISOString() }, legacy: false })
}

function waits(db: DatabaseSync): Record<string, unknown>[] {
  return events(db, { types: [OWNER_WAIT_OPENED] }).map(row => row.data ?? {})
}

function expiries(db: DatabaseSync): { actor: string | null, id: unknown }[] {
  return events(db, { types: [SHARD_EXPIRED] }).map(row => ({ actor: row.actor, id: row.data?.id }))
}

describe('the supervisor tick warns before a window shard ends and turns its expiry into an owner wait', () => {
  it('a window shard with less than the notice left opens one owner wait naming its id and its end', () => {
    const db = bus()
    const until = new Date(NOW.getTime() + HOUR_MS)
    issue(db, '6da9c1c0', until)

    const lines = new ShardTerm(db, () => NOW, '[test] ').step()

    const [wait, ...more] = waits(db)
    expect(more).toEqual([])
    expect(wait?.need).toBe('command')
    expect(wait?.command).toBe(shardRenewalCommand())
    expect(String(wait?.text)).toContain('6da9c1c0')
    expect(String(wait?.text)).toContain(until.toISOString())
    expect(String(wait?.text)).toContain(DECISIONS_SCOPE)
    expect(String(wait?.text)).toContain('1.0 h left')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(wait?.id))
    expect(expiries(db)).toEqual([])
  })

  it('a window shard past its end with nothing to merge is expired on the tick and leaves an owner wait', () => {
    const db = bus()
    issue(db, '6da9c1c0', new Date(NOW.getTime() - 60_000))

    const lines = new ShardTerm(db, () => NOW).step()

    expect(expiries(db)).toEqual([{ actor: SHARD_TERM_ACTOR, id: '6da9c1c0' }])
    expect(activeWindowShards(db, NOW)).toEqual([])
    const [wait, ...more] = waits(db)
    expect(more).toEqual([])
    expect(wait?.command).toBe(shardRenewalCommand())
    expect(String(wait?.text)).toContain('6da9c1c0 expired')
    expect(lines).toHaveLength(1)
  })

  it('a second tick opens no second wait for the same shard', () => {
    const db = bus()
    issue(db, 'shard-a', new Date(NOW.getTime() + HOUR_MS))
    issue(db, 'shard-b', new Date(NOW.getTime() + 30 * 60_000))
    const tick = new ShardTerm(db, () => NOW)

    const first = tick.step()
    const second = tick.step()
    const afterRestart = new ShardTerm(db, () => new Date(NOW.getTime() + 60_000)).step()

    expect(waits(db)).toHaveLength(1)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(afterRestart.length).toBeLessThanOrEqual(1)
    expect(waits(db)).toHaveLength(1)
  })

  it('a window shard with more than the notice left opens no wait', () => {
    const db = bus()
    issue(db, 'far-off', new Date(NOW.getTime() + SHARD_NOTICE_HOURS * HOUR_MS + 60_000))

    expect(new ShardTerm(db, () => NOW).step()).toEqual([])
    expect(waits(db)).toEqual([])
    expect(expiries(db)).toEqual([])
  })

  it('the board shows the owner the renewal command, not an answer form', () => {
    expect(ownerWaitCommand({ id: 'Q9', need: 'command', card: null, pr: null }, shardRenewalCommand())).toBe(shardRenewalCommand())
  })
})
