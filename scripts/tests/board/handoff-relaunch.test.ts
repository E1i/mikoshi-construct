import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHandoff } from '../../board/handoff.js'

const BASIC = path.join(import.meta.dirname, 'fixtures/basic')
const RELAUNCH = { repo: 'repo', status: 'status.md', out: '.', tasks: [{ id: 'alpha-2b', brief: 'brief-alpha.md', card: '#102 alpha-2 [implement/ghosts/S/ladder/owner] · depends — · blocks —' }] }
const RELAUNCHED = { event: 'task', ts: '2026-09-28T10:00:00.000Z', task: 'alpha-2b', baseSha: 'base', session: null, install: 0, exit: 0, ladder: 'blocked', run: null, iterations: 1, class: null, contour: null, resultLine: 'present', total_cost_usd: null, num_turns: null, duration_ms: null, usage: null, review: null }

describe('board: a relaunch on the same card under a new tasks id', () => {
  it('reads one attempt for the card, carrying the later tasks id, its task line and the card\'s task:start tree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-relaunch-'))
    try {
      cpSync(BASIC, dir, { recursive: true })
      const before = readHandoff(dir).attempts.length
      writeFileSync(path.join(dir, 'tasks-relaunch.json'), JSON.stringify(RELAUNCH))
      appendFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify(RELAUNCHED)}\n`)

      const { attempts } = readHandoff(dir)
      const card = attempts.filter(attempt => attempt.id === '102' || attempt.ghost === 'alpha-2b')

      expect(attempts).toHaveLength(before)
      expect(card).toHaveLength(1)
      expect(card[0]).toMatchObject({ id: '102', ghost: 'alpha-2b', worktree: path.join(dir, 'worktrees/alpha-2'), branch: 'ghost/alpha-2' })
      expect(card[0]!.taskEvent).toMatchObject({ task: 'alpha-2b', ladder: 'blocked' })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'before the relaunch, the attempt is superseded', relaunched: false, superseded: true },
    { name: 'after the relaunch, the live attempt is not', relaunched: true, superseded: false },
  ])('a superseded line names the old tasks id: $name', ({ relaunched, superseded }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-relaunch-'))
    try {
      cpSync(BASIC, dir, { recursive: true })
      appendFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify({ event: 'superseded', task: 'alpha-2', by: 'b'.repeat(40), ts: '2026-09-28T09:00:00.000Z' })}\n`)
      if (relaunched)
        writeFileSync(path.join(dir, 'tasks-relaunch.json'), JSON.stringify(RELAUNCH))

      const attempt = readHandoff(dir).attempts.find(candidate => candidate.id === '102')

      expect(attempt?.supersededEvent !== undefined).toBe(superseded)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
