import type { BusFacts } from '../../src/commands/board/bus.js'
import type { SeedEvent } from './bus-fixture.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REVIEW_DRIP } from '../../scripts/core/events.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { boardScreens, tailLines } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-15T12:00:00.000Z')
const LIVE_CARD = 1900
const LONG_MERGED_CARD = 1700
const PR = 1529
const HEAD = 'c0ffee1234567890'
const QUEUE_DRIP = 'scripts/core/queue.ts: the answer candidates query reads tasks without the generation filter'
const WATCH_DRIP = 'scripts/window/watch.ts:289 reads the handoff before the lock is held'
const OLD_DRIP = 'scripts/supervisor/run.ts BusTick.run swallows the error of a failed reduce'

function drip(card: number, finding: string, legacy = false): SeedEvent {
  return { ts: NOW.toISOString(), type: REVIEW_DRIP, card, pr: PR, head: HEAD, payload: JSON.stringify({ card, pr: PR, head: HEAD, finding }), legacy }
}

function facts(events: SeedEvent[]): BusFacts {
  const file = writeBus(path.join(mkdtempSync(path.join(tmpdir(), 'drip-tail-')), 'bus.db'), {
    cards: [
      { id: LIVE_CARD, state: 'changes', lane: 'L1', line: `card: #${LIVE_CARD} review-refuses-drip-finding`, since: NOW.toISOString() },
      { id: LONG_MERGED_CARD, state: 'merged', lane: null, line: `card: #${LONG_MERGED_CARD} long-gone`, since: '2026-11-01T00:00:00.000Z' },
    ],
    events,
  })
  const reading = busReaderAt(file, () => NOW)()
  if (reading.status !== 'read')
    throw new Error(`the bus was not read: ${reading.status}`)
  return reading.facts
}

describe('the tail of a card on the board', () => {
  it('shows each marked drip finding of a card once, with its PR and head, on the flow screen', () => {
    const read = facts([drip(LIVE_CARD, QUEUE_DRIP), drip(LIVE_CARD, WATCH_DRIP), drip(LIVE_CARD, QUEUE_DRIP), drip(LIVE_CARD, 'a legacy line', true)])

    expect(read.tails).toEqual([
      { card: LIVE_CARD, pr: PR, head: HEAD, finding: WATCH_DRIP },
      { card: LIVE_CARD, pr: PR, head: HEAD, finding: QUEUE_DRIP },
    ])
    const flow = boardScreens(read, PLAIN_LORE).screens[0]!.lines
    const tail = tailLines(read, PLAIN_LORE)
    expect(tail).toHaveLength(2)
    expect(tail.every(line => line.includes(`#${LIVE_CARD}`) && line.includes(`PR #${PR}`) && line.includes(HEAD.slice(0, 7)))).toBe(true)
    expect(tail.some(line => line.includes(QUEUE_DRIP))).toBe(true)
    expect(tail.some(line => line.includes(WATCH_DRIP))).toBe(true)
    expect(flow).toEqual(expect.arrayContaining(tail))
  })

  it('leaves the tail of a card ended long ago to the full board', () => {
    const read = facts([drip(LONG_MERGED_CARD, OLD_DRIP)])

    expect(tailLines(read, PLAIN_LORE)).toEqual([])
    expect(tailLines(read, PLAIN_LORE, true)).toEqual([expect.stringContaining(OLD_DRIP)])
  })

  it('reads no tail where no finding was marked', () => {
    const read = facts([])

    expect(read).not.toHaveProperty('tails')
    expect(tailLines(read, PLAIN_LORE)).toEqual([])
  })
})
