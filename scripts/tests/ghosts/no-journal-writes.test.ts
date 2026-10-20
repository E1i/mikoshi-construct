import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { recordFall } from '../../ghosts/supervise.js'
import { runTaskClose } from '../../ghosts/task-close.js'
import { recordDisposition } from '../../ghosts/verdict.js'
import { ownBusPerTest } from './own-bus.js'

const NOW = new Date('2026-10-21T09:00:00.000Z')

const busOf = ownBusPerTest()

function eventTypes(busPath: string): string[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT type FROM events WHERE legacy = 0 ORDER BY id').all() as { type: string }[]).map(row => row.type)
  }
  finally {
    db.close()
  }
}

function closeDeps(handoffDir: string, busPath: string): TaskCloseDeps {
  const start = JSON.stringify({ event: 'path', task: '123', path: 'cheap', started: 'x', worktree: '/mc-123', branch: 'feat/123', card: { id: 123, name: 'n', kind: 'implement', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'owner', depends: [], blocks: [], line: 'l' }, ts: 'x' })
  return {
    cwd: handoffDir,
    read: file => file === path.join(handoffDir, 'ghosts.jsonl') ? `${start}\n` : null,
    busPath,
    now: () => NOW,
    handoffDir,
    constructDir: path.join(handoffDir, '.construct'),
    realpath: file => file,
    exists: () => false,
    session: undefined,
    projectsDir: path.join(handoffDir, 'projects'),
    tokens: () => null,
    prBody: () => null,
  }
}

const COMMANDS: { name: string, run: (handoffDir: string, busPath: string) => Promise<unknown>, writes: string }[] = [
  { name: 'verdict --disposition', run: async handoffDir => recordDisposition({ task: 't', pr: '520', followUp: '519', by: 'window' }, handoffDir, NOW), writes: 'ghost.line' },
  { name: 'a ladder fall', run: async () => recordFall(123, 'ladder-not-done', 'session'), writes: 'ghost.line' },
  { name: 'task:close', run: async (handoffDir, busPath) => runTaskClose(['123', '--pr', '460', '--verification', 'run'], closeDeps(handoffDir, busPath)), writes: 'card.verified' },
]

describe('the window commands write the bus, not the journal', () => {
  it.each(COMMANDS)('no window command appends to ghosts.jsonl: $name writes $writes to the bus', async ({ run, writes }) => {
    const handoffDir = mkdtempSync(path.join(tmpdir(), 'no-journal-'))
    await run(handoffDir, busOf())
    expect(existsSync(path.join(handoffDir, 'ghosts.jsonl'))).toBe(false)
    expect(eventTypes(busOf())).toContain(writes)
  })
})
