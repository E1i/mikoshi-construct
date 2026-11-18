import type { DatabaseSync } from 'node:sqlite'
import type { WindowShard } from '../policy/shards.js'
import { appendEvent, openBusWait } from '../core/db.js'
import { OWNER_WAIT_OPENED } from '../core/events.js'
import { activeWindowShards, expiredWindowShards, SHARD_NOTICE_HOURS, WINDOW_SHARD_HOURS } from '../policy/shards.js'
import { ghostProtocolWord, MODE_FLAG, sayCommand, START_BIN } from './start.js'
import { FACTORY_MODES } from './workers.js'

export const SHARD_TERM_ACTOR = 'worker:supervisor:shard-term'
const HOUR_MS = 3_600_000
const LAST_EVENT = 'SELECT coalesce(max(id), 0) AS id FROM events'
const OPENED_AFTER = `SELECT 1 FROM events WHERE type = '${OWNER_WAIT_OPENED}' AND json_extract(payload, '$.id') = ? AND id > ? LIMIT 1`

export function shardRenewalCommand(): string {
  return `${sayCommand(ghostProtocolWord(WINDOW_SHARD_HOURS))} && ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[1]}`
}

function hoursLeft(shard: WindowShard, nowMs: number): string {
  return ((Date.parse(shard.until) - nowMs) / HOUR_MS).toFixed(1)
}

export class ShardTerm {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly prefix: string = '') {}

  step(): string[] {
    try {
      return this.tick(this.now())
    }
    catch (error) {
      return [`${this.prefix}reading the term of the window shards failed: ${error instanceof Error ? error.message : String(error)}; read again on the next tick`]
    }
  }

  private tick(nowMs: number): string[] {
    const now = new Date(nowMs)
    const expired = expiredWindowShards(this.db, now, SHARD_TERM_ACTOR).flatMap((event) => {
      appendEvent(this.db, event)
      const id = String((event.payload as { id: string }).id)
      return this.ask(now, `window shard ${id} reached its end at ${now.toISOString()} and is expired: nothing merges under the owner's shard until the owner renews it`)
    })
    const ending = activeWindowShards(this.db, now)
      .filter(shard => Date.parse(shard.until) - nowMs <= SHARD_NOTICE_HOURS * HOUR_MS)
      .flatMap(shard => this.ask(now, `window shard ${shard.id}, scope ${shard.scope}, ends at ${shard.until}, ${hoursLeft(shard, nowMs)} h left: after it nothing merges under the owner's shard until the owner renews it`))
    return [...expired, ...ending]
  }

  private ask(now: Date, text: string): string[] {
    const before = (this.db.prepare(LAST_EVENT).get() as { id: number }).id
    const id = openBusWait(this.db, now.toISOString(), SHARD_TERM_ACTOR, { need: 'command', text, command: shardRenewalCommand() })
    return this.db.prepare(OPENED_AFTER).get(id, before) === undefined ? [] : [`${this.prefix}owner wait ${id} opened: ${text}; the owner runs ${shardRenewalCommand()}`]
  }
}
