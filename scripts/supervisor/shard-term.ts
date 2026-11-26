export interface ShardOnTerm {
  id: string
  scope: string
  until: string
}

export interface ShardWait {
  text: string
  command: string
}

export interface ShardTermParts {
  noticeHours: number
  renewal: string
  active: (now: Date) => ShardOnTerm[]
  expired: (now: Date) => string[]
  noticed: (id: string) => boolean
  ask: (wait: ShardWait, now: Date, expiring: string | null) => string
}

export const SHARD_TERM_ACTOR = 'worker:supervisor:shard-term'
const HOUR_MS = 3_600_000

function hoursLeft(shard: ShardOnTerm, now: Date): string {
  return ((Date.parse(shard.until) - now.getTime()) / HOUR_MS).toFixed(1)
}

function noticeOf(id: string): string {
  return `window shard ${id} (scope `
}

export function namesNoticeOf(text: string, id: string): boolean {
  return text.includes(noticeOf(id))
}

export function endingShardsText(shards: readonly ShardOnTerm[], now: Date): string {
  const ends = shards.map(shard => `${noticeOf(shard.id)}${shard.scope}) ends at ${shard.until}, ${hoursLeft(shard, now)} h left`)
  return `${ends.join('; ')}; without a renewal the window works without a shard from then on, and a night run merges nothing a shard covers`
}

export function expiredShardText(id: string, now: Date): string {
  return `window shard ${id} expired at ${now.toISOString()}; until a renewal the window works without a shard and merges under it are refused`
}

export class ShardTerm {
  private readonly reported = new Set<string>()

  constructor(private readonly parts: ShardTermParts, private readonly clock: () => Date, private readonly prefix: string = '') {}

  step(): string[] {
    try {
      return this.sweep(this.clock())
    }
    catch (error) {
      return [`${this.prefix}reading the terms of window shards failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private noticeDue(shard: ShardOnTerm, now: Date): boolean {
    return Date.parse(shard.until) - now.getTime() <= this.parts.noticeHours * HOUR_MS && !this.parts.noticed(shard.id)
  }

  private sweep(now: Date): string[] {
    const expired = this.parts.expired(now).map(id => this.ask(now, expiredShardText(id, now), id))
    const due = this.parts.active(now).filter(shard => this.noticeDue(shard, now))
    const ending = due.length === 0 ? [] : [this.ask(now, endingShardsText(due, now), null)]
    return [...expired, ...ending].flatMap(line => line === null ? [] : [line])
  }

  private ask(now: Date, text: string, expiring: string | null): string | null {
    const wait = this.parts.ask({ text, command: this.parts.renewal }, now, expiring)
    if (this.reported.has(wait))
      return null
    this.reported.add(wait)
    return `${this.prefix}owner wait ${wait}: ${text}; renew with ${this.parts.renewal}`
  }
}
