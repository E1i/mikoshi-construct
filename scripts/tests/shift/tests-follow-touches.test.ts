import type { TreeCard, TreePrPorts } from '../../shift/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { treePr } from '../../shift/tree-pr.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const CARD: TreeCard = {
  branch: 'feat/review-worker',
  title: 'review-worker (#1128)',
  commitMessage: 'review-worker (#1128)',
  cardLine: '#1128 review-worker [implement/netwatch/S/ladder/auto] · depends — · blocks —',
  contour: 'ladder',
  touches: ['scripts/bus/review-worker.ts'],
  namedPathReason: null,
}

const BASE: Record<string, string> = {
  'scripts/bus/review-worker.ts': 'export function runReviewWorker(): number {\n  return 1\n}\n',
  'scripts/bus/merge-worker.ts': 'export function runMergeWorker(): number {\n  return 1\n}\n',
  'scripts/tests/bus/review-worker.test.ts': 'import { runReviewWorker } from \'../../bus/review-worker.js\'\n\nexport const ran = runReviewWorker()\n',
  'scripts/shift/shift.ts': 'export function runShift(): number {\n  return 1\n}\n',
  'tests/decisions-read-through-reader.test.ts': 'export const scanned = \'scripts/shift\'\n',
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}

function cardTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tests-follow-touches-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const worktree = path.join(root, 'tree')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', worktree])
  git(worktree, ['config', 'user.email', 'shift@example.com'])
  git(worktree, ['config', 'user.name', 'shift'])
  git(worktree, ['config', 'commit.gpgsign', 'false'])
  write(worktree, BASE)
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-q', '-m', 'base'])
  git(worktree, ['remote', 'add', 'origin', origin])
  git(worktree, ['push', '-q', 'origin', 'main'])
  git(worktree, ['fetch', '-q', 'origin'])
  git(worktree, ['checkout', '-q', '-b', CARD.branch])
  return worktree
}

function ports(): TreePrPorts {
  return {
    git,
    gh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list')
        return '[]'
      if (args[0] === 'pr' && args[1] === 'create')
        return 'https://github.com/owner/repo/pull/954\n'
      throw new Error(`unexpected gh ${args.join(' ')}`)
    },
  }
}

describe('the shift gate lets the tests that cover the touched files follow the touches', () => {
  it('an edit of a covering test outside touches does not stop the card', () => {
    const worktree = cardTree()
    write(worktree, {
      'scripts/bus/review-worker.ts': 'export function runReviewWorker(): number {\n  return 2\n}\n',
      'scripts/tests/bus/review-worker.test.ts': 'import { runReviewWorker } from \'../../bus/review-worker.js\'\n\nexport const ran = runReviewWorker() + 1\n',
    })
    expect(treePr(ports(), CARD, worktree, null)).toEqual({ kind: 'pr', number: '954' })
  })

  it('an edit of code outside touches still stops the card', () => {
    const worktree = cardTree()
    write(worktree, {
      'scripts/bus/review-worker.ts': 'export function runReviewWorker(): number {\n  return 2\n}\n',
      'scripts/bus/merge-worker.ts': 'export function runMergeWorker(): number {\n  return 2\n}\n',
    })
    const result = treePr(ports(), CARD, worktree, null)
    expect(result.kind).toBe('problem')
    expect(result.kind === 'problem' && result.why).toContain('the card\'s touches for scripts/bus/merge-worker.ts, which it changes outside them')
  })
  it('an edit of a test that scans the tree of a touched file outside touches does not stop the card', () => {
    const worktree = cardTree()
    write(worktree, {
      'scripts/shift/shift.ts': 'export function runShift(): number {\n  return 2\n}\n',
      'tests/decisions-read-through-reader.test.ts': 'export const scanned = \'scripts/shift/\'\n',
    })
    expect(treePr(ports(), { ...CARD, touches: ['scripts/shift/**'] }, worktree, null)).toEqual({ kind: 'pr', number: '954' })
  })
})
