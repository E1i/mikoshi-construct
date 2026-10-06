import type { Attempt } from '../../board/handoff.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { closedTasks, mergedTasks } from '../../../src/card/closed.js'
import { readCheapTasks } from '../../../src/commands/cost/cheap.js'
import { readHandoff } from '../../board/handoff.js'

const CARD = { id: 7, name: 'n', kind: 'implement', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'owner', depends: [], blocks: [], line: 'l' }
const START = { event: 'path', task: '7', path: 'cheap', started: '2026-10-04T08:00:00.000Z', worktree: '/w', branch: 'b', card: CARD, ts: '2026-10-04T08:00:00.000Z' }
const CLOSE = { event: 'path', task: '7', path: 'cheap', pr: 9, verification: 'run', ended: '2026-10-04T09:00:00.000Z', sessions: [{ id: 's', project: '-w' }], ts: '2026-10-04T09:00:00.000Z' }
const STOP = { event: 'stop', task: '7', at: 'merge', why: 'w', worktree: '/w', shift: '/s', session: 's', ts: '2026-10-04T09:00:01.000Z', pr: 9 }
const AUTOPILOT = { event: 'autopilot', state: 'off', shift: '/s', ts: '2026-10-04T08:00:00.000Z' }

function journalDir(entries: object[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-readers-'))
  writeFileSync(path.join(dir, 'ghosts.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
  return dir
}

describe('the readers of ghosts.jsonl read a journal that holds stop and autopilot lines as one that does not', () => {
  it('gives the board the same attempts and warnings', () => {
    const without = readHandoff(journalDir([START, CLOSE]))
    const withStops = readHandoff(journalDir([AUTOPILOT, START, STOP, CLOSE]))
    const bare = ({ journalPath: _journalPath, ...rest }: Attempt): Omit<Attempt, 'journalPath'> => rest
    expect(withStops.attempts.map(bare)).toEqual(without.attempts.map(bare))
    expect(withStops.warnings).toEqual(without.warnings)
  })

  it('gives construct cost the same window tasks', () => {
    const none = path.join(mkdtempSync(path.join(tmpdir(), 'stop-shift-')), 'none')
    const without = readCheapTasks(none, path.join(journalDir([START, CLOSE]), 'ghosts.jsonl'))
    const withStops = readCheapTasks(none, path.join(journalDir([AUTOPILOT, START, STOP, CLOSE]), 'ghosts.jsonl'))
    expect(withStops).toEqual(without)
  })

  it('closes and merges nothing by a stop line, even one that carries a pr', () => {
    const text = `${[STOP, AUTOPILOT].map(entry => JSON.stringify(entry)).join('\n')}\n`
    expect([...closedTasks(text)]).toEqual([])
    expect([...mergedTasks(text)]).toEqual([])
  })
})
