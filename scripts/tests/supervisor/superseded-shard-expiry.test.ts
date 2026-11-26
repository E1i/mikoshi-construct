import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { OWNER_WAIT_OPENED, SHARD_EXPIRED, SHARD_ISSUED } from '../../core/events.js'
import { DECISIONS_SCOPE } from '../../policy/shards.js'
import { openComposedBus, shardTermTick } from '../../supervisor/composition.js'

const HOUR_MS = 3_600_000
const buses: DatabaseSync[] = []

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openComposedBus(':memory:')
  buses.push(db)
  return db
}

function issued(db: DatabaseSync, id: string, scope: string, until: Date): void {
  appendEvent(db, { ts: new Date(until.getTime() - 6 * HOUR_MS).toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by: 'owner', run: null, window: true, scope, until: until.toISOString() }, legacy: false })
}

function count(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

const SUPERSEDED: Record<string, { ended: string, live: string, waits: number }> = {
  'a live shard of the same scope': { ended: DECISIONS_SCOPE, live: DECISIONS_SCOPE, waits: 0 },
  'a live shard of a wider scope': { ended: 'merge', live: DECISIONS_SCOPE, waits: 0 },
  'a live shard of a narrower scope': { ended: DECISIONS_SCOPE, live: 'merge', waits: 1 },
}

describe('shard expiry is judged against the live shard set', () => {
  it('the expiry of a shard superseded by a live shard of equal or wider scope opens no owner wait', () => {
    for (const [name, shape] of Object.entries(SUPERSEDED)) {
      const db = bus()
      const now = Date.now()
      issued(db, 'old', shape.ended, new Date(now - 60_000))
      issued(db, 'new', shape.live, new Date(now + 5 * HOUR_MS))

      shardTermTick(db).step()

      expect(count(db, SHARD_EXPIRED), name).toBe(1)
      expect(count(db, OWNER_WAIT_OPENED), name).toBe(shape.waits)
    }
  })
})
