import type { CheckRunner } from '../../ghosts/regenerated.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { approvalCarryEvent, REGENERATED, REGENERATED_PATHS, regeneratedCheckFailedOutcome, regeneratedCheckFailures } from '../../ghosts/regenerated.js'
import { rangeDiffVerdict } from '../../ghosts/sketch.js'

const GENERATED = 'templates/attach/earlier-carriers.json'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(repo: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files))
    write(repo, file, text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

interface Sketches { repo: string, approved: string, main: string }

function approvedThenMainMoved(): Sketches {
  const repo = mkdtempSync(path.join(tmpdir(), 'ghosts-regenerated-'))
  git(repo, 'init', '-q', '-b', 'main')
  commit(repo, { 'src.txt': 'one\n', [GENERATED]: '[]\n' }, 'base')
  git(repo, 'checkout', '-q', '-b', 'approved')
  const approved = commit(repo, { 'src.txt': 'one\ntwo\n', [GENERATED]: '[1]\n' }, 'sketch')
  git(repo, 'checkout', '-q', 'main')
  const main = commit(repo, { 'other.txt': 'main moved\n' }, 'main moved')
  git(repo, 'checkout', '-q', '-b', 'launched', approved)
  git(repo, 'rebase', '-q', '-X', 'theirs', main)
  return { repo, approved, main }
}

function runner(repo: string): (args: string[]) => string {
  return args => git(repo, ...args)
}

function verdictOf(world: Sketches, regenerated: readonly string[] = REGENERATED_PATHS) {
  return rangeDiffVerdict(runner(world.repo), world.approved, git(world.repo, 'rev-parse', 'HEAD'), world.main, regenerated)
}

describe('rangeDiffVerdict over a generated file', () => {
  it('keeps the approval when the rebased commit differs from the approved one only in the generated file, naming it', () => {
    const world = approvedThenMainMoved()
    commit(world.repo, { [GENERATED]: '[1,2]\n' }, 'sketch')
    git(world.repo, 'reset', '-q', '--soft', 'HEAD~2')
    git(world.repo, 'commit', '-q', '-m', 'sketch')
    expect(verdictOf(world)).toEqual({ ok: true, regenerated: [GENERATED] })
  })

  it('keeps the approval when a new commit only regenerates the generated file, naming it', () => {
    const world = approvedThenMainMoved()
    commit(world.repo, { [GENERATED]: '[1,2]\n' }, 'regenerate earlier-carriers.json')
    expect(verdictOf(world)).toEqual({ ok: true, regenerated: [GENERATED] })
  })

  it('refuses a rebase that changed a source file beside the generated one, naming what range-diff shows outside it', () => {
    const world = approvedThenMainMoved()
    commit(world.repo, { 'src.txt': 'one\ntwo, edited\n', [GENERATED]: '[1,2]\n' }, 'regenerate and edit')
    const verdict = verdictOf(world)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok || verdict.reason).toContain(`, and outside ${GENERATED} it shows '= >' for 2; re-approve the brief`)
  })

  it('refuses a regeneration commit when no generated path is registered, as before', () => {
    const world = approvedThenMainMoved()
    commit(world.repo, { [GENERATED]: '[1,2]\n' }, 'regenerate earlier-carriers.json')
    const verdict = verdictOf(world, [])
    expect(verdict.ok || verdict.reason).toMatch(/not every one '='; re-approve the brief$/)
  })
})

describe('regeneratedCheckFailures', () => {
  it('registers earlier-carriers.json with its --check through pnpm exec tsx', () => {
    expect(REGENERATED).toEqual([{ path: GENERATED, check: ['exec', 'tsx', 'scripts/attach/earlier-carriers.ts', '--check'] }])
  })

  it('runs the check of every named path in the worktree and is empty when each exits 0', () => {
    const calls: { cwd: string, args: readonly string[] }[] = []
    const run: CheckRunner = (cwd, args) => {
      calls.push({ cwd, args })
      return { status: 0, stderr: '' }
    }
    expect(regeneratedCheckFailures('/wt', [GENERATED], run)).toEqual([])
    expect(calls).toEqual([{ cwd: '/wt', args: ['exec', 'tsx', 'scripts/attach/earlier-carriers.ts', '--check'] }])
  })

  it('runs nothing for a path the range did not touch', () => {
    const run: CheckRunner = () => {
      throw new Error('ran')
    }
    expect(regeneratedCheckFailures('/wt', [], run)).toEqual([])
  })

  it('names the path, the command, the exit and the first stderr line of a red check', () => {
    const run: CheckRunner = () => ({ status: 1, stderr: '\nmissing from the file: x 1\nmore\n' })
    expect(regeneratedCheckFailures('/wt', [GENERATED], run)).toEqual([`${GENERATED}: pnpm exec tsx scripts/attach/earlier-carriers.ts --check exited 1: missing from the file: x 1`])
  })

  it('says no session started and what to do next', () => {
    expect(regeneratedCheckFailedOutcome(['a: b'])).toBe('regenerated check failed, no session: a: b; regenerate on the sketch or re-approve the brief')
  })
})

describe('approvalCarryEvent', () => {
  it('records why the approval carried: the kind, both shas and the regenerated paths', () => {
    const now = new Date('2026-10-05T12:00:00.000Z')
    expect(approvalCarryEvent('g2', 'a'.repeat(40), 'b'.repeat(40), [GENERATED], now)).toEqual({ event: 'approval-carry', ts: now.toISOString(), task: 'g2', kind: 'regenerated', approvedSketch: 'a'.repeat(40), sketch: 'b'.repeat(40), regenerated: [GENERATED] })
  })
})
