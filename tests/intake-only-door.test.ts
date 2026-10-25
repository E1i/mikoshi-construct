import type { TaskStartDeps } from '../scripts/ports/task-start.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { busCardEvents } from '../scripts/intake/intake.js'
import { CARD_ADMITTED } from '../scripts/core/events.js'
import { runTaskStart } from '../scripts/ports/task-start.js'
import { cardStartedLines } from '../scripts/core/tasks.js'
import { journalInBus } from '../scripts/tests/ghosts/card-started-bus.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#61 door-card [implement/ghosts/S/cheap/owner] · depends — · blocks —'

const ADMITTED_TS = '2026-10-04T10:00:00.000Z'
const ADMISSION = `${CARD_ADMITTED}:61:door`

function admitInBus(bus: string, card: string): void {
  const db = openBus(bus)
  try {
    busCardEvents(db)({ type: CARD_ADMITTED, cardId: 61, ts: ADMITTED_TS, dedupeKey: ADMISSION, payload: { card, lane: null, confirmation: 'person' } })
  }
  finally {
    db.close()
  }
}

interface World {
  deps: TaskStartDeps
  starts: () => Record<string, unknown>[]
  gitCalls: string[][]
}

function world(journal: string[], admitted?: string): World {
  const bus = path.join(mkdtempSync(path.join(tmpdir(), 'intake-door-')), 'bus.db')
  journalInBus(bus, journal)
  if (admitted !== undefined)
    admitInBus(bus, admitted)
  const gitCalls: string[][] = []
  return {
    starts: () => cardStartedLines(bus),
    gitCalls,
    deps: {
      cwd: '/repo',
      git: (_cwd, args) => {
        gitCalls.push(args)
        if (args[0] === 'show-ref')
          throw new Error('no such branch')
        return args[0] === 'rev-parse' ? '/work/repo\n' : ''
      },
      install: () => undefined,
      exists: () => false,
      bus,
      now: () => NOW,
      session: 's1',
    },
  }
}

function startLine(starts: () => Record<string, unknown>[]): Record<string, unknown> {
  return starts()[0]!
}

describe('task:start takes only a card that intake admitted in the bus', () => {
  it('refuses a card with no card.admitted in the bus, names why and how, and cuts and writes nothing', () => {
    const { deps, starts, gitCalls } = world([JSON.stringify({ event: 'path', task: '7', path: 'cheap', ts: 'x' })])
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #61 has no card.admitted in the bus ${deps.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(gitCalls).toEqual([])
    expect(starts()).toEqual([])
  })

  it('refuses when the bus holds no journal history', () => {
    const { deps, starts } = world([])
    expect(runTaskStart(['feat/door', '--card', CARD], deps).exitCode).toBe(1)
    expect(starts()).toEqual([])
  })

  it('accepts a card intake admitted in the bus, and records the admission on its card.started', () => {
    const { deps, starts } = world([], CARD)
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(starts)).toMatchObject({ event: 'path', task: '61', admission: { by: 'bus', event: ADMISSION, admitted: ADMITTED_TS } })
  })

  it('refuses a card that differs from the one intake admitted in the bus', () => {
    const { deps, starts } = world([], CARD.replace('cheap', 'ladder'))
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain(`was admitted in the bus ${deps.bus} as a different card`)
    expect(starts()).toEqual([])
  })

  it('accepts a card with no intake line only under --without-intake, and records the flag and its reason', () => {
    const { deps, starts } = world([])
    const result = runTaskStart(['feat/door', '--card', CARD, '--without-intake', 'hotfix the owner asked for by hand'], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(starts)).toMatchObject({ task: '61', admission: { by: 'waiver', flag: '--without-intake', reason: 'hotfix the owner asked for by hand' } })
  })

  it('refuses --without-intake without a reason', () => {
    for (const argv of [['feat/door', '--card', CARD, '--without-intake'], ['feat/door', '--card', CARD, '--without-intake', ' ']]) {
      const { deps, starts } = world([])
      expect(runTaskStart(argv, deps).stderr).toEqual(['[task:start] usage: pnpm task:start <branch> --card "<card>" [--without-intake "<reason>"]'])
      expect(starts()).toEqual([])
    }
  })
})
