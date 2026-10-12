import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHandoff } from '../../board/handoff.js'
import { busWithCardStarted } from '../ghosts/card-started-bus.js'

const CLOSE = { event: 'path', task: '891', path: 'ladder', pr: 790, verification: 'run', ts: '2026-10-12T11:00:00.000Z' }

describe('board: a card started through card.started in the bus', () => {
  it('reads an attempt for the card, with the tree, branch and session card.started carries and the closing line of the journal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-card-started-'))
    const bus = busWithCardStarted([{ cardId: 891, ts: '2026-10-12T10:00:00.000Z', payload: { path: 'ladder', started: '2026-10-12T10:00:00.000Z', session: 'start-session', worktree: path.join(dir, 'mc-891'), branch: 'feat/891' } }])
    try {
      writeFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify(CLOSE)}\n`)
      const attempt = readHandoff(dir, undefined, bus.file).attempts.find(candidate => candidate.id === '891')
      expect(attempt).toMatchObject({ worktree: path.join(dir, 'mc-891'), branch: 'feat/891' })
      expect(attempt!.pathEvent).toMatchObject({ session: 'start-session', pr: 790, verification: 'run' })
    }
    finally {
      bus.remove()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the closing line of the journal on top of card.started for every field both carry', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-card-started-'))
    const bus = busWithCardStarted([{ cardId: 893, ts: '2026-10-12T10:00:00.000Z', payload: { path: 'ladder', session: 'start-session', worktree: path.join(dir, 'mc-893'), branch: 'feat/893' } }])
    try {
      writeFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify({ event: 'path', task: '893', path: 'cheap', session: 'close-session', report: 'report-893.md', verification: 'run', ts: '2026-10-12T15:00:00.000Z' })}\n`)
      const attempt = readHandoff(dir, undefined, bus.file).attempts.find(candidate => candidate.id === '893')
      expect(attempt!.pathEvent).toMatchObject({ ts: '2026-10-12T15:00:00.000Z', path: 'cheap', session: 'close-session', report: 'report-893.md', worktree: path.join(dir, 'mc-893') })
    }
    finally {
      bus.remove()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names an attempt for a card whose only start is card.started', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-card-started-'))
    const bus = busWithCardStarted([{ cardId: 892, ts: '2026-10-12T10:00:00.000Z', payload: { worktree: path.join(dir, 'mc-892'), branch: 'feat/892' } }])
    try {
      writeFileSync(path.join(dir, 'ghosts.jsonl'), '')
      expect(readHandoff(dir, undefined, bus.file).attempts.map(attempt => attempt.id)).toEqual(['892'])
    }
    finally {
      bus.remove()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
