import { describe, expect, it } from 'vitest'
import { ghostRowSessionId, upsertGhostRow, writingRow } from '../../ghosts/status.js'

const STATUS = `| window | tree | state | sha | task start | waits for | updated |
|---|---|---|---|---|---|---|
| A | — | free | bc27f2c | — | window B's ladder | 2026-09-27 21:26 |
`

describe('writingRow', () => {
  it('w4: names the supervisor pid before the session in the waits-for cell', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'brief-g1.md', supervisorPid: 4242, sessionId: 'sess-1' })
    expect(row.split('|').map(cell => cell.trim())[6]).toBe('/implement brief-g1.md, supervisor 4242, session sess-1')
    expect(ghostRowSessionId(upsertGhostRow(STATUS, 'g1', row), 'g1')).toBe('sess-1')
  })
})
