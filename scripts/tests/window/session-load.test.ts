import type { ProcessCwds } from '../../ports/client/contract.js'
import { describe, expect, it } from 'vitest'
import { CLIENT_CWDS_COMMAND } from '../../ports/process-table.js'
import { PRODUCED_BY, readingOf, readSessionLoad } from '../../window/session-load.js'

const TOP = [
  'Processes: 900 total',
  'CPU usage: 40.00% user, 55.00% sys, 5.00% idle',
  '',
  'COMMAND          %CPU',
  'syspolicyd       99.0',
  'node             99.0',
  'Processes: 900 total',
  'CPU usage: 33.10% user, 25.20% sys, 41.70% idle',
  '',
  'COMMAND          %CPU',
  'syspolicyd       27.0',
  'syspolicyd       1.5',
  'fseventsd        4.5',
  'node             12.0',
  'node             0.2',
  'node             0.1',
  'Google Chrome He 3.0',
  'nodemon          2.0',
].join('\n')

const TWO_SESSIONS: ProcessCwds = { kind: 'listed', cwds: ['/trees/1', '/trees/2'] }

describe('the session load reading', () => {
  it('a reading gives sys percent and node per session with what produced it', () => {
    expect(readingOf(TOP, TWO_SESSIONS)).toEqual({
      sysPercent: 25.2,
      syspolicydPercent: 28.5,
      fseventsdPercent: 4.5,
      nodeProcesses: 3,
      liveSessions: 2,
      nodePerSession: 1.5,
      producedBy: PRODUCED_BY,
    })
    expect(PRODUCED_BY).toContain('top')
    expect(PRODUCED_BY).toContain('lsof')
    expect(PRODUCED_BY).toContain(CLIENT_CWDS_COMMAND)
    expect(PRODUCED_BY).toContain('claude or a version number')
  })

  it('no live session gives no node per session rather than a division by zero', () => {
    expect(readingOf(TOP, { kind: 'listed', cwds: [] })).toMatchObject({ nodeProcesses: 3, liveSessions: 0, nodePerSession: null })
  })

  it('a top with no CPU line is an error, not a zero', () => {
    expect(() => readingOf('COMMAND %CPU\nnode 1.0', TWO_SESSIONS)).toThrow('sys percent')
  })

  it('a top with no process table is an error, not a zero', () => {
    expect(() => readingOf('CPU usage: 1.00% user, 2.00% sys, 97.00% idle', TWO_SESSIONS)).toThrow('COMMAND')
    expect(() => readingOf('CPU usage: 1.00% user, 2.00% sys, 97.00% idle\nCOMMAND %CPU\n', TWO_SESSIONS)).toThrow('process row')
  })

  it('an unreadable lsof is an error, not zero sessions', () => {
    expect(() => readingOf(TOP, { kind: 'unreadable', why: 'refused' })).toThrow('refused')
  })

  it('the reading comes from one run of top and one listing of claude processes', () => {
    let tops = 0
    let listings = 0
    const reading = readSessionLoad(() => {
      tops += 1
      return TOP
    }, () => {
      listings += 1
      return TWO_SESSIONS
    })
    expect([tops, listings]).toEqual([1, 1])
    expect(reading.sysPercent).toBe(25.2)
  })
})
