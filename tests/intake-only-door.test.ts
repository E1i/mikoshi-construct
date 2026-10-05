import type { TaskStartDeps } from '../scripts/ghosts/task-start.js'
import type { ShiftDeps } from '../scripts/shift/shift.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTaskStart } from '../scripts/ghosts/task-start.js'
import { runShift } from '../scripts/shift/shift.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#61 door-card [implement/ghosts/S/cheap/owner] · depends — · blocks —'
const JOURNAL = path.join('/handoff', 'ghosts.jsonl')

function intakeLine(card: string, confirmation = 'person'): string {
  return `${JSON.stringify({ event: 'intake', task: '61', card, confirmation, corrections: [], ts: '2026-10-04T10:00:00.000Z' })}\n`
}

interface World {
  deps: TaskStartDeps
  appended: string[]
  gitCalls: string[][]
}

function world(journal: string | null): World {
  const appended: string[] = []
  const gitCalls: string[][] = []
  return {
    appended,
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
      append: (_file, text) => {
        appended.push(text)
      },
      now: () => NOW,
      session: 's1',
      handoffDir: '/handoff',
      readJournal: file => file === JOURNAL ? journal : null,
    },
  }
}

function startLine(appended: string[]): Record<string, unknown> {
  return JSON.parse(appended[0]!.split('\n')[0]!) as Record<string, unknown>
}

describe('task:start takes only a card that intake sliced and confirmed', () => {
  it('refuses a card with no intake line, names why and how, and cuts and writes nothing', () => {
    const { deps, appended, gitCalls } = world(`${JSON.stringify({ event: 'path', task: '7', path: 'cheap', ts: 'x' })}\n`)
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[task:start] card #61 has no intake line in the journal: it was not sliced and confirmed; slice and confirm it with construct intake, or pass --without-intake "<reason>" to record an exception; nothing written'])
    expect(gitCalls).toEqual([])
    expect(appended).toEqual([])
  })

  it('refuses when the journal does not exist', () => {
    const { deps, appended } = world(null)
    expect(runTaskStart(['feat/door', '--card', CARD], deps).exitCode).toBe(1)
    expect(appended).toEqual([])
  })

  it('accepts a card whose intake line confirmed it, and records the admission on the start line', () => {
    const { deps, appended } = world(intakeLine(CARD))
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(appended)).toMatchObject({ event: 'path', task: '61', admission: { by: 'intake', confirmation: 'person', intake: '2026-10-04T10:00:00.000Z' } })
  })

  it('refuses a card that differs from the one its intake line confirmed', () => {
    const { deps, appended } = world(intakeLine(CARD.replace('cheap', 'ladder')))
    const result = runTaskStart(['feat/door', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('card #61 differs from the card its intake line confirmed')
    expect(appended).toEqual([])
  })

  it('accepts a card with no intake line only under --without-intake, and records the flag and its reason', () => {
    const { deps, appended } = world(null)
    const result = runTaskStart(['feat/door', '--card', CARD, '--without-intake', 'hotfix the owner asked for by hand'], deps)
    expect(result.exitCode).toBe(0)
    expect(startLine(appended)).toMatchObject({ task: '61', admission: { by: 'waiver', flag: '--without-intake', reason: 'hotfix the owner asked for by hand' } })
  })

  it('refuses --without-intake without a reason', () => {
    for (const argv of [['feat/door', '--card', CARD, '--without-intake'], ['feat/door', '--card', CARD, '--without-intake', ' ']]) {
      const { deps, appended } = world(null)
      expect(runTaskStart(argv, deps).stderr).toEqual(['[task:start] usage: pnpm task:start <branch> --card "<card>"'])
      expect(appended).toEqual([])
    }
  })
})

describe('the shift starts its tasks through the same door', () => {
  it('leaves a task whose card has no intake line not started, and spawns no session', async () => {
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
    expect(out).toContain('[shift] 01.md 61: not started: [task:start] card #61 has no intake line in the journal: it was not sliced and confirmed; slice and confirm it with construct intake, or pass --without-intake "<reason>" to record an exception; nothing written')
    expect(appended[JOURNAL]).toBeUndefined()
  })
})
