import type { DatabaseSync } from 'node:sqlite'
import type { OwnerWaitAsk } from '../core/db.js'
import type { WindowShard } from '../policy/shards.js'
import { closedWaitIds } from '../core/card-readings.js'
import { appendEvent, inTransaction, openBusWait } from '../core/db.js'
import { activeWindowShards, expiredWindowShards, SHARD_NOTICE_HOURS, WINDOW_SHARD_HOURS } from '../policy/shards.js'
import { ghostProtocolWord, MODE_FLAG, sayCommand, START_BIN } from './start.js'
import { FACTORY_MODES } from './workers.js'

export const SHARD_TERM_ACTOR = 'worker:supervisor:shard-term'
const HOUR_MS = 3_600_000

export function shardRenewalCommand(): string {
  return `${sayCommand(ghostProtocolWord(WINDOW_SHARD_HOURS))} && ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[1]}`
}

function hoursLeft(shard: WindowShard, now: Date): string {
  return ((Date.parse(shard.until) - now.getTime()) / HOUR_MS).toFixed(1)
}

export function endingShardText(shard: WindowShard, now: Date): string {
  return `window shard ${shard.id} (scope ${shard.scope}) ends at ${shard.until}, ${hoursLeft(shard, now)} h left; without a renewal the window works without a shard from then on, and a night run merges nothing a shard covers`
}

export function expiredShardText(id: string, now: Date): string {
  return `window shard ${id} expired at ${now.toISOString()}; until a renewal the window works without a shard and merges under it are refused`
}

export function noticeDue(shard: WindowShard, now: Date): boolean {
  return Date.parse(shard.until) - now.getTime() <= SHARD_NOTICE_HOURS * HOUR_MS
}

export class ShardTerm {
  private readonly reported = new Set<string>()
  private readonly noticed = new Set<string>()

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly prefix: string = '') {}

  step(): string[] {
    try {
      return this.sweep(this.clock())
    }
    catch (error) {
      return [`${this.prefix}reading the terms of window shards failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private sweep(now: Date): string[] {
    const expired = expiredWindowShards(this.db, now, SHARD_TERM_ACTOR).map(ended => this.ask(now, expiredShardText(ended.payload.id, now), () => appendEvent(this.db, ended)))
    const ending = activeWindowShards(this.db, now).filter(shard => noticeDue(shard, now) && !this.noticed.has(shard.id)).map((shard) => {
      this.noticed.add(shard.id)
      return this.ask(now, endingShardText(shard, now))
    })
    return [...expired, ...ending].flatMap(line => line === null ? [] : [line])
  }

  private ask(now: Date, text: string, before: () => unknown = () => null): string | null {
    const ask: OwnerWaitAsk = { need: 'command', text, command: shardRenewalCommand() }
    const wait = inTransaction(this.db, () => {
      before()
      return openBusWait(this.db, closedWaitIds(this.db), now.toISOString(), SHARD_TERM_ACTOR, ask)
    })
    if (this.reported.has(wait))
      return null
    this.reported.add(wait)
    return `${this.prefix}owner wait ${wait}: ${text}; renew with ${ask.command}`
  }
}
