import type { TaskStartDeps } from '../scripts/ghosts/task-start.js'
import type { ShiftDeps } from '../scripts/shift/shift.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../scripts/bus/db.js'
import { busCardEvents } from '../scripts/bus/intake.js'
import { runTaskStart } from '../scripts/ghosts/task-start.js'
import { cardStartedLines } from '../scripts/ghosts/tasks.js'
import { runShift } from '../scripts/shift/shift.js'
import { CARD_ADMITTED } from '../src/commands/intake/index.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#61 door-card [implement/ghosts/S/cheap/owner] · depends — · blocks —'
const JOURNAL = path.join('/handoff', 'ghosts.jsonl')

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

function world(journal: string | null, admitted?: string): World {
  const bus = path.join(mkdtempSync(path.join(tmpdir(), 'intake-door-')), 'bus.db')
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
      handoffDir: '/handoff',
      readJournal: file => file === JOURNAL ? journal : null,
    },
  }
}

function startLine(starts: () => Record<string, unknown>[]): Record<string, unknown> {
  return starts()[0]!
}

describe('task:start takes only a card that intake admitted in the bus', () => {
  it('refuses a card with no card.admitted in the bus, names why and how, and cuts and writes nothing', () => {
    const { deps, starts, gitCalls } = world(`${JSON.stringify({ event: 'path', task: '7', path: 'cheap', ts: 'x' })}\n`)
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:start] card #61 has no card.admitted in the bus ${deps.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`])
    expect(gitCalls).toEqual([])
    expect(starts()).toEqual([])
  })

  it('refuses when the journal does not exist', () => {
    const { deps, starts } = world(null)
    expect(runTaskStart(['feat/door', '--card', CARD], deps).exitCode).toBe(1)
    expect(starts()).toEqual([])
  })

  it('accepts a card intake admitted in the bus, and records the admission on its card.started', () => {
    const { deps, starts } = world(null, CARD)
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(starts)).toMatchObject({ event: 'path', task: '61', admission: { by: 'bus', event: ADMISSION, admitted: ADMITTED_TS } })
  })

  it('refuses a card that differs from the one intake admitted in the bus', () => {
    const { deps, starts } = world(null, CARD.replace('cheap', 'ladder'))
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain(`was admitted in the bus ${deps.bus} as a different card`)
    expect(starts()).toEqual([])
  })

  it('accepts a card with no intake line only under --without-intake, and records the flag and its reason', () => {
    const { deps, starts } = world(null)
    const result = runTaskStart(['feat/door', '--card', CARD, '--without-intake', 'hotfix the owner asked for by hand'], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(starts)).toMatchObject({ task: '61', admission: { by: 'waiver', flag: '--without-intake', reason: 'hotfix the owner asked for by hand' } })
  })

  it('refuses --without-intake without a reason', () => {
    for (const argv of [['feat/door', '--card', CARD, '--without-intake'], ['feat/door', '--card', CARD, '--without-intake', ' ']]) {
      const { deps, starts } = world(null)
      expect(runTaskStart(argv, deps).stderr).toEqual(['[task:start] usage: pnpm task:start <branch> --card "<card>" [--parking <dir>] [--without-intake "<reason>"]'])
      expect(starts()).toEqual([])
    }
  })
})

describe('the shift starts its tasks through the same door', () => {
  it('leaves a task whose card has no card.admitted in the bus not started, and spawns no session', async () => {
    const files: Record<string, string> = { '/shift/01.md': `card: ${CARD}\nbranch: feat/door\ntouches: scripts/door/**\n\ndo it\n` }
    const appended: Record<string, string> = {}
    const out: string[] = []
    const runs: unknown[] = []
    const start = world(null).deps
    const deps: ShiftDeps = {
      ...start,
      claude: 'claude',
      header: '',
      projectsDir: '/projects',
      gh: () => '[]',
      listDir: dir => Object.keys(files).filter(file => path.dirname(file) === dir).map(file => path.basename(file)),
      read: file => files[file] ?? '',
      exists: file => file in files,
      append: (file, text) => {
        appended[file] = (appended[file] ?? '') + text
      },
      uuid: () => 'u1',
      run: async (run) => {
        runs.push(run)
        return { kind: 'exited', code: 0, signal: null }
      },
      out: line => out.push(line),
      err: () => undefined,
    }
    expect(await runShift(['/shift'], deps)).toBe(1)
    expect(runs).toEqual([])
    expect(out).toContain(`[shift] 01.md 61: not started: [task:start] card #61 has no card.admitted in the bus ${start.bus}: it was not admitted; admit it through pnpm intake --admit, or pass --without-intake "<reason>" to record an exception; nothing written`)
    expect(appended[JOURNAL]).toBeUndefined()
  })
})
