import type { ShardOnTerm, ShardTermParts, ShardWait } from '../../supervisor/shard-term.js'
import { describe, expect, it } from 'vitest'
import { ownerWaitCommand, shardRenewalCommand } from '../../core/owner-commands.js'
import { ShardTerm } from '../../supervisor/shard-term.js'

const NOW = new Date('2026-11-17T18:54:00.000Z')
const HOUR_MS = 3_600_000
const NOTICE_HOURS = 2
const RENEWAL = shardRenewalCommand(6)

interface OpenedWait extends ShardWait {
  id: string
}

class FakeBus {
  readonly shards: ShardOnTerm[] = []
  readonly expiries: string[] = []
  readonly waits: OpenedWait[] = []
  readonly closed = new Set<string>()

  issue(id: string, until: Date): void {
    this.shards.push({ id, scope: 'merge+decisions', until: until.toISOString() })
  }

  parts(): ShardTermParts {
    const unended = (): ShardOnTerm[] => this.shards.filter(shard => !this.expiries.includes(shard.id))
    return {
      noticeHours: NOTICE_HOURS,
      renewal: RENEWAL,
      active: now => unended().filter(shard => Date.parse(shard.until) > now.getTime()),
      expired: now => unended().filter(shard => Date.parse(shard.until) <= now.getTime()).map(shard => shard.id),
      ask: (wait, _now, expiring) => {
        if (expiring !== null)
          this.expiries.push(expiring)
        const open = this.waits.find(each => each.command === wait.command && !this.closed.has(each.id))
        if (open !== undefined)
          return open.id
        const id = `Q${this.waits.length + 1}`
        this.waits.push({ id, ...wait })
        return id
      },
    }
  }
}

function tickOn(bus: FakeBus, at: Date = NOW): ShardTerm {
  return new ShardTerm(bus.parts(), () => at, '[test] ')
}

describe('the supervisor tick warns before a window shard ends and turns its expiry into an owner wait', () => {
  it('a window shard with less than the notice left opens one owner wait naming its id and its end', () => {
    const bus = new FakeBus()
    const until = new Date(NOW.getTime() + HOUR_MS)
    bus.issue('6da9c1c0', until)

    const lines = tickOn(bus).step()

    expect(bus.waits).toHaveLength(1)
    const [wait] = bus.waits
    expect(wait?.command).toBe(RENEWAL)
    expect(wait?.text).toContain('6da9c1c0')
    expect(wait?.text).toContain(until.toISOString())
    expect(wait?.text).toContain('merge+decisions')
    expect(wait?.text).toContain('1.0 h left')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(wait?.id))
    expect(bus.expiries).toEqual([])
  })

  it('a window shard past its end with nothing to merge is expired on the tick and leaves an owner wait', () => {
    const bus = new FakeBus()
    bus.issue('6da9c1c0', new Date(NOW.getTime() - 60_000))

    const lines = tickOn(bus).step()

    expect(bus.expiries).toEqual(['6da9c1c0'])
    expect(bus.waits).toHaveLength(1)
    expect(bus.waits[0]?.command).toBe(RENEWAL)
    expect(bus.waits[0]?.text).toContain('6da9c1c0 expired')
    expect(lines).toHaveLength(1)
  })

  it('a second tick opens no second wait for the same shard', () => {
    const bus = new FakeBus()
    bus.issue('shard-a', new Date(NOW.getTime() + HOUR_MS))
    bus.issue('shard-b', new Date(NOW.getTime() + 30 * 60_000))
    const tick = tickOn(bus)

    const first = tick.step()
    const second = tick.step()
    bus.closed.add(bus.waits[0]!.id)
    const afterTheOwnerAnswered = tick.step()

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(afterTheOwnerAnswered).toEqual([])
    expect(bus.waits).toHaveLength(1)
  })

  it('a window shard with more than the notice left opens no wait', () => {
    const bus = new FakeBus()
    bus.issue('far-off', new Date(NOW.getTime() + NOTICE_HOURS * HOUR_MS + 60_000))

    expect(tickOn(bus).step()).toEqual([])
    expect(bus.waits).toEqual([])
    expect(bus.expiries).toEqual([])
  })

  it('a reader that throws is reported as a line and retried on the next tick', () => {
    const locked = (): ShardOnTerm[] => {
      throw new Error('locked')
    }
    const parts = { ...new FakeBus().parts(), active: locked }

    expect(new ShardTerm(parts, () => NOW).step()).toEqual([expect.stringContaining('locked')])
  })

  it('the board shows the owner the renewal command, not an answer form', () => {
    expect(ownerWaitCommand({ id: 'Q9', need: 'command', card: null, pr: null }, RENEWAL)).toBe(RENEWAL)
  })
})
