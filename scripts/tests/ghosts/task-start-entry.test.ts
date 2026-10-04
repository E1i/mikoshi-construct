import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ghosts/task-start.js'

const NOW = new Date('2026-10-04T08:00:00.000Z')
const CARD = '#41 entry-card [implement/ghosts/M/cheap/owner] · depends — · blocks —'

function world(session: string | undefined): { deps: TaskStartDeps, appended: string[] } {
  const appended: string[] = []
  return {
    appended,
    deps: {
      cwd: '/repo',
      git: (_cwd, args) => {
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
      session,
      handoffDir: '/handoff',
    },
  }
}

describe('task:start prints the entry card and writes it beside the start line', () => {
  it('prints the four fields with RESULT accepted · not started', () => {
    const { deps } = world('s1')
    const rows = runTaskStart(['feat/entry', '--card', CARD], deps).stdout.slice(1)
    expect(rows.map(row => row.split(' ')[0])).toEqual(['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'])
    expect(rows[3]).toBe('RESULT   | accepted · not started')
  })

  it('writes the start line and the entry line in one append, the entry carrying what was printed', () => {
    const { deps, appended } = world('s1')
    const result = runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(appended).toHaveLength(1)
    const [start, entry] = appended[0]!.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, string>)
    expect(start).toMatchObject({ event: 'path', task: '41' })
    expect(entry).toMatchObject({ event: 'entry', task: '41', RESULT: 'accepted · not started', ts: NOW.toISOString() })
    expect(result.stdout.slice(1)).toEqual((['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'] as const).map(field => `${field.padEnd(8)} | ${entry![field]}`))
  })

  it('names a forecast no source holds, and a missing session, in the card', () => {
    const rows = runTaskStart(['feat/entry', '--card', CARD], world(undefined).deps).stdout
    expect(rows[2]).toContain('expect not recorded on the start line')
    expect(rows[3]).toContain('CLAUDE_CODE_SESSION_ID is not set')
  })
})
