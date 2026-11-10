import type { WaitClock } from './wait-for.js'
import { describe, expect, it } from 'vitest'
import { POLL_MS, waitFor } from './wait-for.js'

function steppedClock(): WaitClock & { elapsed: () => number } {
  let now = 0
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      now += ms
      queueMicrotask(run)
    },
    elapsed: () => now,
  }
}

describe('waitFor', () => {
  it('returns at once, without a poll, when the condition already holds', async () => {
    const clock = steppedClock()
    await waitFor(() => true, () => 'nothing', 1_000, clock)
    expect(clock.elapsed()).toBe(0)
  })

  it('polls on the injected clock until the condition holds', async () => {
    const clock = steppedClock()
    await waitFor(() => clock.elapsed() >= 4 * POLL_MS, () => 'four polls', 1_000, clock)
    expect(clock.elapsed()).toBe(4 * POLL_MS)
  })

  it('names what it waited for and how long once the deadline passes on the clock', async () => {
    const clock = steppedClock()
    await expect(waitFor(() => false, () => 'the marker', 100, clock)).rejects.toThrow('waited 100ms for the marker, and it never came')
    expect(clock.elapsed()).toBe(100)
  })
})
