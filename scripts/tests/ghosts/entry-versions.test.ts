import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import { describe, expect, it } from 'vitest'
import { entryOf } from '../../ghosts/entry.js'
import { runTaskClose } from '../../ghosts/task-close.js'

const JOURNAL = '/handoff/ghosts.jsonl'
const V1 = '{"event":"entry","task":"548","CONTRACT":"implement · cheap · owner · touches not recorded on the card · law not recorded on the card","EXPECT":"expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone","ACTION":"task:start fix/shift-left-reason-closed-first #548: cut /Users/eli/projects/mc-548 from origin/main; start line written to /Users/eli/.construct/handoff/ghosts.jsonl","RESULT":"accepted · not started","ts":"2026-10-04T19:04:01.015Z"}'
const V2 = JSON.stringify({ event: 'entry', schema: 2, task: '549', CONTRACT: 'implement · cheap · auto · touches a.ts, b/** · law not recorded on the card', EXPECT: 'expect none — n=0 for implement/S', ACTION: 'a', RESULT: 'accepted · not started', ts: '2026-10-05T08:00:00.000Z' })

function startLine(id: string): string {
  return JSON.stringify({ event: 'path', task: id, path: 'cheap', started: 'x', worktree: `/mc-${id}`, branch: `feat/${id}`, card: { id: Number(id), name: 'n', kind: 'implement', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'owner', depends: [], blocks: [], line: 'l' }, ts: 'x' })
}

function closeCard(journal: string[], id: string): string[] {
  const deps: TaskCloseDeps = {
    cwd: '/work',
    read: file => file === JOURNAL ? `${journal.join('\n')}\n` : null,
    append: () => undefined,
    now: () => new Date('2026-10-05T09:00:00.000Z'),
    handoffDir: '/handoff',
    exists: () => false,
    session: undefined,
    projectsDir: '/projects',
  }
  return runTaskClose([id, '--pr', '1', '--verification', 'run'], deps).stdout
}

describe('entryOf and task:close read both versions of the entry line', () => {
  it('reads a v1 line, the shape of the entry line of #548, as it is', () => {
    expect(entryOf(`${V1}\n`, '548')).toMatchObject({ CONTRACT: expect.stringContaining('touches not recorded on the card'), RESULT: 'accepted · not started' })
  })

  it('reads a v2 line', () => {
    expect(entryOf(`${V2}\n`, '549')).toMatchObject({ CONTRACT: expect.stringContaining('touches a.ts, b/**'), EXPECT: 'expect none — n=0 for implement/S' })
  })

  it('reads the last line of the task whichever its version', () => {
    expect(entryOf(`${V2}\n${V2.replace('549', '548')}\n${V1}\n`, '548')?.CONTRACT).toContain('touches not recorded on the card')
    expect(entryOf(`${V1}\n${V2.replace('549', '548')}\n`, '548')?.CONTRACT).toContain('touches a.ts, b/**')
  })

  it('has task:close print the CONTRACT and the EXPECT of a v1 line byte for byte', () => {
    const rows = closeCard([startLine('548'), V1], '548')
    const entry = JSON.parse(V1) as Record<string, string>
    expect(rows[1]).toBe(`CONTRACT | ${entry.CONTRACT}`)
    expect(rows[2]).toBe(`EXPECT   | ${entry.EXPECT}`)
  })

  it('has task:close print the CONTRACT and the EXPECT of a v2 line byte for byte', () => {
    const rows = closeCard([startLine('549'), V2], '549')
    expect(rows[1]).toBe('CONTRACT | implement · cheap · auto · touches a.ts, b/** · law not recorded on the card')
    expect(rows[2]).toBe('EXPECT   | expect none — n=0 for implement/S')
  })
})
