import type { TaskStartDeps } from '../../ports/task-start.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { runTaskStart } from '../../ports/task-start.js'
import { admitCards } from '../shift/fixtures/admitted.js'
import { journalInBus } from './card-started-bus.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#101 task-card [implement/ghosts/M/cheap/owner] · depends #86 #87 · blocks —'
const DONE_86 = { event: 'path', task: '86', path: 'cheap', pr: 530, verification: 'run' }
const MERGED_86 = { event: 'merge', task: '86', pr: 530, by: 'owner', commit: 'abc' }
const MERGED_87 = { event: 'merge', task: '87', pr: 531, by: 'owner', commit: 'def' }
const roots: string[] = []

function holdInBus(bus: string, cardId: number, state: string): void {
  const db = openBus(bus)
  try {
    db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)').run(cardId, state)
  }
  finally {
    db.close()
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function world(journalLines: object[]): { root: string, repo: string, deps: TaskStartDeps } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-merged-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const deps: TaskStartDeps = {
    cwd: repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: () => {},
    exists: existsSync,
    bus: path.join(root, 'bus', 'bus.db'),
    now: () => NOW,
    session: undefined,
  }
  admitCards(deps.bus, [CARD])
  journalInBus(deps.bus, journalLines.map(line => JSON.stringify(line)))
  return { root, repo, deps }
}

describe('task:start takes a card only when its depends are merged in the bus', () => {
  it('refuses a card with a depends not merged and cuts no tree', () => {
    const w = world([DONE_86, MERGED_87])
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr.join(' ')).toContain('#86')
    expect(result.stderr.join(' ')).not.toContain('#87')
    expect(result.stderr.join(' ')).toContain('not merged')
    expect(result.exitCode).toBe(1)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(false)
  })

  it('does not let the intake waiver skip the check', () => {
    const w = world([DONE_86, MERGED_87])
    const result = runTaskStart(['feat/t101', '--card', CARD, '--without-intake', 'testing'], w.deps)
    expect(result.stderr.join(' ')).toContain('#86')
    expect(result.exitCode).toBe(1)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(false)
  })

  it('starts the card once every depends has a legacy merge line in the bus', () => {
    const w = world([DONE_86, MERGED_86, MERGED_87])
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(true)
  })

  it('takes a depends the bus holds merged or closed as merged, though no legacy merge line names it', () => {
    const w = world([DONE_86])
    holdInBus(w.deps.bus, 86, 'closed')
    holdInBus(w.deps.bus, 87, 'merged')
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('does not take a merge line written once the journal half of history ended, while the bus holds the card running', () => {
    const w = world([MERGED_86, { ...MERGED_87, ts: '2026-10-12T18:00:00.000Z' }])
    holdInBus(w.deps.bus, 87, 'running')
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr.join(' ')).toContain('#87')
    expect(result.exitCode).toBe(1)
  })
})
