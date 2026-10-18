import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHandoff } from '../../ghosts/handoff.js'
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

  it('reads the entry of an attempt from card.started before the entry lines of the journal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-card-started-'))
    const entry = { schema: 2, CONTRACT: 'contract from the bus', EXPECT: 'expect from the bus', ACTION: 'a', RESULT: 'accepted · not started' }
    const bus = busWithCardStarted([
      { cardId: 894, ts: '2026-10-12T10:00:00.000Z', payload: { worktree: path.join(dir, 'mc-894'), branch: 'feat/894', entry } },
      { cardId: 895, ts: '2026-10-12T10:00:00.000Z', payload: { worktree: path.join(dir, 'mc-895'), branch: 'feat/895', entry } },
    ])
    try {
      writeFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify({ event: 'entry', task: '895', CONTRACT: 'contract from the journal', EXPECT: 'e', ACTION: 'a', RESULT: 'r', ts: 'x' })}\n`)
      const attempts = readHandoff(dir, undefined, bus.file).attempts
      expect(attempts.find(attempt => attempt.id === '894')!.entryLine).toMatchObject({ CONTRACT: 'contract from the bus', EXPECT: 'expect from the bus' })
      expect(attempts.find(attempt => attempt.id === '895')!.entryLine).toMatchObject({ CONTRACT: 'contract from the bus' })
    }
    finally {
      bus.remove()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the entry line ghosts:launch wrote under the Ghost id before the entry of card.started', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'board-card-started-'))
    const entry = { schema: 2, CONTRACT: 'task:start contract', EXPECT: 'e', ACTION: 'a', RESULT: 'accepted · not started' }
    const bus = busWithCardStarted([{ cardId: 900, ts: '2026-10-12T10:00:00.000Z', payload: { worktree: path.join(dir, 'mc-900'), branch: 'feat/900', entry } }])
    try {
      writeFileSync(path.join(dir, 'tasks-ladder.json'), JSON.stringify({ repo: 'repo', status: 'status.md', out: '.', tasks: [{ id: 'some-card', brief: 'brief-some-card.md', card: '#900 some-card [implement/netwatch/S/ladder/auto] · depends — · blocks —' }] }))
      writeFileSync(path.join(dir, 'ghosts.jsonl'), `${JSON.stringify({ event: 'entry', task: 'some-card', CONTRACT: 'ladder contract', EXPECT: 'e', ACTION: 'a', RESULT: 'r', ts: 'x' })}\n`)
      const attempt = readHandoff(dir, undefined, bus.file).attempts.find(candidate => candidate.ghost === 'some-card')
      expect(attempt!.entryLine).toMatchObject({ CONTRACT: 'ladder contract' })
    }
    finally {
      bus.remove()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
