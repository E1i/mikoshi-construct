import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import { appendEvent, openBusWait } from '../core/db.js'

export const SHARD_TERM_ACTOR = 'worker:supervisor:shard-term'
const HOUR_MS = 3_600_000

export interface TermedShard {
  id: string
  scope: string
  until: string
}

export interface ShardTermParts {
  expired: (db: DatabaseSync, now: Date, actor: string) => BusEvent[]
  active: (db: DatabaseSync, now: Date) => readonly TermedShard[]
  lastWaitOpenedBy: (db: DatabaseSync, actor: string) => number | null
  noticeHours: number
  renewal: string
}

function hoursLeft(shard: TermedShard, nowMs: number): string {
  return ((Date.parse(shard.until) - nowMs) / HOUR_MS).toFixed(1)
}

export class ShardTerm {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly prefix: string, private readonly parts: ShardTermParts) {}

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
    const expired = this.parts.expired(this.db, now, SHARD_TERM_ACTOR).flatMap((event) => {
      appendEvent(this.db, event)
      const id = String((event.payload as { id: string }).id)
      return this.ask(now, `window shard ${id} reached its end at ${now.toISOString()} and is expired: nothing merges under the owner's shard until the owner renews it`)
    })
    const ending = this.parts.active(this.db, now)
      .filter(shard => Date.parse(shard.until) - nowMs <= this.parts.noticeHours * HOUR_MS)
      .flatMap(shard => this.ask(now, `window shard ${shard.id}, scope ${shard.scope}, ends at ${shard.until}, ${hoursLeft(shard, nowMs)} h left: after it nothing merges under the owner's shard until the owner renews it`))
    return [...expired, ...ending]
  }

  private ask(now: Date, text: string): string[] {
    const before = this.parts.lastWaitOpenedBy(this.db, SHARD_TERM_ACTOR)
    const id = openBusWait(this.db, now.toISOString(), SHARD_TERM_ACTOR, { need: 'command', text, command: this.parts.renewal })
    return this.parts.lastWaitOpenedBy(this.db, SHARD_TERM_ACTOR) === before ? [] : [`${this.prefix}owner wait ${id} opened: ${text}; the owner runs ${this.parts.renewal}`]
  }
}
