import type { TaskStartDeps } from '../../ports/task-start.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ports/task-start.js'
import { cardStartedLines } from '../../core/tasks.js'
import { admitCards } from '../shift/fixtures/admitted.js'

const NOW = new Date('2026-10-04T08:00:00.000Z')
const CARD = '#41 entry-card [implement/ghosts/M/cheap/owner] · depends — · blocks —'

function world(session: string | undefined): { deps: TaskStartDeps, starts: () => Record<string, unknown>[] } {
  const bus = path.join(mkdtempSync(path.join(tmpdir(), 'task-start-')), 'bus.db')
  admitCards(bus, [CARD])
  return {
    starts: () => cardStartedLines(bus),
    deps: {
      cwd: '/repo',
      git: (_cwd, args) => {
        if (args[0] === 'show-ref')
          throw new Error('no such branch')
        return args[0] === 'rev-parse' ? '/work/repo\n' : ''
      },
      install: () => undefined,
      exists: () => false,
      bus,
      now: () => NOW,
      session,
    },
  }
}

describe('task:start prints the entry card and writes it into the start', () => {
  it('prints the four fields with RESULT accepted · not started', () => {
    const { deps } = world('s1')
    const rows = runTaskStart(['feat/entry', '--card', CARD], deps).stdout.slice(1)
    expect(rows.map(row => row.split(' ')[0])).toEqual(['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'])
    expect(rows[3]).toBe('RESULT   | accepted · not started')
  })

  it('writes one card.started whose entry carries what was printed', () => {
    const { deps, starts } = world('s1')
    const result = runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(starts()).toHaveLength(1)
    const start = starts()[0]!
    const entry = start.entry as Record<string, string>
    expect(start).toMatchObject({ task: '41', started: NOW.toISOString() })
    expect(entry).toMatchObject({ RESULT: 'accepted · not started' })
    expect(result.stdout.slice(1)).toEqual((['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'] as const).map(field => `${field.padEnd(8)} | ${entry[field]}`))
  })

  it('names a forecast no source holds, and a missing session, in the card', () => {
    const rows = runTaskStart(['feat/entry', '--card', CARD], world(undefined).deps).stdout
    expect(rows[2]).toContain('expect not recorded on the start line')
    expect(rows[3]).toContain('CLAUDE_CODE_SESSION_ID is not set')
  })

  it('the start records the printed forecast as a value', () => {
    const handed = { CONTRACT: 'contract', EXPECT: 'expect tokens ≈ 1.2M' }
    const startOf = (forecast: Parameters<typeof runTaskStart>[2]): Record<string, unknown> => {
      const { deps, starts } = world('s1')
      const result = runTaskStart(['feat/entry', '--card', CARD], deps, forecast)
      expect(result.stdout[2]).toBe(`EXPECT   | ${forecast!.EXPECT}`)
      return starts()[0]!
    }
    expect(startOf({ ...handed, forecast: { kind: 'forecast', taskClass: 'XS', n: 7, tokens: 1_234_567, minutes: 12.34 } }).forecast).toEqual({ tokens: 1_234_567, minutes: 12.34, class: 'XS', n: 7 })
    expect(startOf({ ...handed, forecast: { kind: 'none', taskClass: 'M', n: 2 } }).forecast).toEqual({ kind: 'none', class: 'M', n: 2 })
    expect(startOf(handed)).not.toHaveProperty('forecast')
  })
})
