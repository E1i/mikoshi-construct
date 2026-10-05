import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ghosts/task-start.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#101 task-card [implement/ghosts/M/cheap/owner] · depends #86 #87 · blocks —'
const INTAKE = { event: 'intake', task: '101', card: CARD, confirmation: 'none', corrections: [], ts: '2026-10-05T07:00:00.000Z' }
const DONE_86 = { event: 'path', task: '86', path: 'cheap', pr: 530, verification: 'run' }
const MERGED_86 = { event: 'merge', task: '86', pr: 530, by: 'owner', commit: 'abc' }
const MERGED_87 = { event: 'merge', task: '87', pr: 531, by: 'owner', commit: 'def' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function world(journalLines: object[]): { root: string, repo: string, handoff: string, journal: string, deps: TaskStartDeps } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-merged-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  const handoff = path.join(root, 'handoff')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  mkdirSync(handoff)
  const journal = path.join(handoff, 'ghosts.jsonl')
  const text = journalLines.map(line => `${JSON.stringify(line)}\n`).join('')
  writeFileSync(journal, text)
  const deps: TaskStartDeps = {
    cwd: repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: () => {},
    exists: existsSync,
    append: (file, added) => appendFileSync(file, added),
    now: () => NOW,
    session: undefined,
    handoffDir: handoff,
    readJournal: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
  }
  return { root, repo, handoff, journal, deps }
}

describe('task:start takes a card only when its depends are merged', () => {
  it('refuses a card with a depends not merged and leaves the journal unchanged', () => {
    const w = world([INTAKE, DONE_86, MERGED_87])
    const before = readFileSync(w.journal, 'utf8')
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr.join(' ')).toContain('#86')
    expect(result.stderr.join(' ')).not.toContain('#87')
    expect(result.stderr.join(' ')).toContain('not merged')
    expect(result.exitCode).toBe(1)
    expect(readFileSync(w.journal, 'utf8')).toBe(before)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(false)
  })

  it('does not let the intake waiver skip the check', () => {
    const w = world([DONE_86, MERGED_87])
    const result = runTaskStart(['feat/t101', '--card', CARD, '--without-intake', 'testing'], w.deps)
    expect(result.stderr.join(' ')).toContain('#86')
    expect(result.exitCode).toBe(1)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(false)
  })

  it('starts the card once every depends has a merge line', () => {
    const w = world([INTAKE, DONE_86, MERGED_86, MERGED_87])
    const result = runTaskStart(['feat/t101', '--card', CARD], w.deps)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(existsSync(path.join(w.root, 'mc-101'))).toBe(true)
  })
})
