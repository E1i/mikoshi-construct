import type { BusFacts, BusRestart } from '../../../src/commands/board/bus.js'
import { describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { busPanel, RESTART_ALLOWANCE_MS, restartingMs } from '../../cli/board-page/bus-panel.js'

const FRESH_MS = 15_000
const MINUTE_MS = 60_000
const LAST_PULSE = '2026-11-26T19:38:00.000Z'
const RESTARTED_AT = '2026-11-26T19:40:02.000Z'
const NEW_MAIN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const START_COMMAND = 'pnpm bus:run'

function at(base: string, plusMs: number): string {
  return new Date(Date.parse(base) + plusMs).toISOString()
}

function panelAt(now: string, restart?: BusRestart): string {
  const facts = { at: now, pulse: LAST_PULSE, slots: [], waits: [], ...(restart === undefined ? {} : { restart }) } as unknown as BusFacts
  return busPanel({ facts, freshMs: FRESH_MS, snapshot: null, startCommand: START_COMMAND })
}

describe('a planned restart of the bus', () => {
  it('a pulse gap after a restart renders RESTARTING and a gap with no restart past the allowance renders FLATLINED', () => {
    const restart = { sha: NEW_MAIN, at: RESTARTED_AT }
    const during = panelAt(at(RESTARTED_AT, 2 * MINUTE_MS), restart)
    expect(during).toContain('data-restarting')
    expect(during).toContain('RESTARTING · new main a1b2c3d · 2m')
    expect(during).toContain('BUS RESTARTING')
    expect(during).not.toContain('FLATLINED')
    expect(during).not.toContain(START_COMMAND)

    const silent = panelAt(at(RESTARTED_AT, 2 * MINUTE_MS))
    expect(silent).toContain('FLATLINED')
    expect(silent).toContain(`start the bus with ${START_COMMAND}`)
    expect(silent).not.toContain('RESTARTING')

    const pastAllowance = panelAt(at(RESTARTED_AT, RESTART_ALLOWANCE_MS + 1), restart)
    expect(pastAllowance).toContain('FLATLINED')
    expect(pastAllowance).not.toContain('RESTARTING')
  })

  it('the restart is counted from the supervisor.restarted event and stops counting at the allowance', () => {
    const facts = (now: string, restart?: BusRestart): BusFacts => ({ at: now, ...(restart === undefined ? {} : { restart }) }) as unknown as BusFacts
    expect(restartingMs(facts(at(RESTARTED_AT, 30_000), { sha: null, at: RESTARTED_AT }))).toBe(30_000)
    expect(restartingMs(facts(at(RESTARTED_AT, RESTART_ALLOWANCE_MS), { sha: null, at: RESTARTED_AT }))).toBe(RESTART_ALLOWANCE_MS)
    expect(restartingMs(facts(at(RESTARTED_AT, RESTART_ALLOWANCE_MS + 1), { sha: null, at: RESTARTED_AT }))).toBeNull()
    expect(restartingMs(facts(RESTARTED_AT))).toBeNull()
  })

  it('a live bus shows no restart stamp even right after a restart', () => {
    const live = busPanel({ facts: { at: at(RESTARTED_AT, 5_000), pulse: RESTARTED_AT, slots: [], waits: [], restart: { sha: NEW_MAIN, at: RESTARTED_AT } } as unknown as BusFacts, freshMs: FRESH_MS, snapshot: null, startCommand: START_COMMAND })
    expect(live).toContain('BUS LIVE')
    expect(live).not.toContain('RESTARTING')
  })

  it('the restart line has its plain twin and names a missing sha', () => {
    expect(PLAIN_LORE.boardBusRestarting('abc1234', '3m')).toBe('RESTARTING · new main abc1234 · 3m')
    expect(LORE.boardBusRestarting('abc1234', '3m')).toBe(PLAIN_LORE.boardBusRestarting('abc1234', '3m'))
    expect(PLAIN_LORE.boardBusRestarting(null, '10s')).toBe('RESTARTING · new main — · 10s')
  })
})
