import type { BusFacts } from '../../src/commands/board/bus.js'
import type { SeedEvent } from './bus-fixture.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_PULSE, CARD_SESSION_ENDED, CARD_STARTED, SESSION_HEARTBEAT } from '../../scripts/core/events.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { BOARD_BUS } from '../../src/commands/board/index.js'
import { screenLines } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-17T12:00:00.000Z')
const MINUTE = 60_000
const CARD = 1999
const SESSION = 's-1999'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * MINUTE).toISOString()
}

const started: SeedEvent = { ts: ago(60), type: CARD_STARTED, card: CARD, payload: JSON.stringify({ session: SESSION, worktree: '/trees/mc-1999' }) }
const oldBeat: SeedEvent = { ts: ago(29), type: SESSION_HEARTBEAT, card: CARD, payload: JSON.stringify({ session: SESSION, step: 'launch' }) }

function factsOf(events: SeedEvent[], state = 'running'): BusFacts {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-no-pulse-'))
  dirs.push(dir)
  const file = writeBus(path.join(dir, 'bus.db'), { cards: [{ id: CARD, state, lane: 'lane-a', line: `card: #${CARD} long command` }], events })
  const reading = busReaderAt(file, () => NOW, () => null)(BOARD_BUS)
  if (reading.status !== 'read')
    throw new Error(`the bus was not read: ${reading.status}`)
  return reading.facts
}

function tileOf(facts: BusFacts): string | undefined {
  return facts.services.find(service => service.task === `#${CARD}`)?.step
}

describe('the board keeps every live session', () => {
  it('a started session with an old heartbeat stays on the board with no pulse', () => {
    const facts = factsOf([started, oldBeat])
    expect(tileOf(facts)).toContain(`launch · ${PLAIN_LORE.boardSessionNoPulse(29)} · `)
    expect(screenLines(facts, PLAIN_LORE).join('\n')).toContain('WAITING · NO PULSE 29 min')
    expect(facts.services.find(service => service.task === `#${CARD}`)?.session).toBeUndefined()
  })

  it('a started session with no heartbeat at all stays on the board with no pulse since its start', () => {
    expect(tileOf(factsOf([started]))).toContain(`launch · ${PLAIN_LORE.boardSessionNoPulse(60)} · `)
  })

  it('a session whose card pulses during a long command is shown live', () => {
    const pulse: SeedEvent = { ts: ago(2), type: CARD_PULSE, card: CARD, payload: JSON.stringify({ session: SESSION, pgid: 4242, since: ago(60) }) }
    const facts = factsOf([started, oldBeat, pulse])
    expect(tileOf(facts)).toContain('launch · pulse 2 min ago · ')
    expect(tileOf(facts)).not.toContain('NO PULSE')
    expect(facts.services.find(service => service.task === `#${CARD}`)?.session).toBe(SESSION)
  })

  it('a session that ended leaves the board once its heartbeat is old', () => {
    const ended: SeedEvent = { ts: ago(20), type: CARD_SESSION_ENDED, card: CARD, payload: JSON.stringify({ session: SESSION }) }
    expect(tileOf(factsOf([started, oldBeat, ended]))).toBeUndefined()
  })

  it('a session on a merged card is not shown', () => {
    expect(tileOf(factsOf([started, oldBeat], 'merged'))).toBeUndefined()
  })

  it('the no-pulse line has its plain twin', () => {
    expect(LORE.boardSessionNoPulse(7)).toBe(PLAIN_LORE.boardSessionNoPulse(7))
  })
})
