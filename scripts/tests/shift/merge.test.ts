import type { ReviewStatus } from '../../ghosts/verdict.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isListed, prReviewLine, runCarry, runMerge, runVerdict } from '../../shift/merge.js'

const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8')
const GHOSTS_FILES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/ghosts-files.md'), 'utf8')
const HEAD = 'a1b2c3d'

function cardLine(decision: 'owner' | 'auto'): string {
  return `#7 shift-task [implement/runner/S/cheap/${decision}] · depends — · blocks —`
}

function run(body: string, files: string[]): { calls: string[][], result: ReturnType<typeof runMerge> } {
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    return args[1] === 'view' ? JSON.stringify({ body, headRefOid: HEAD, files: files.map(file => ({ path: file })) }) : ''
  }
  return { calls, result: runMerge(['42'], { gh, ownerMergesText: () => OWNER_MERGES }) }
}

function armed(calls: string[][]): boolean {
  return calls.some(args => args[0] === 'pr' && args[1] === 'merge')
}

describe('runMerge', () => {
  it('arms nothing for a card whose decision is owner, even when every path is plain', () => {
    const { calls, result } = run(`${cardLine('owner')}\n\nbody`, ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] decision owner — PR #42 and the report, merge is Eli\'s'])
  })

  it('arms auto-merge at the head sha for decision auto when every path is plain', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', 'scripts/ghosts/entry.ts'])
    expect(calls).toContainEqual(['pr', 'merge', '42', '--auto', '--squash', '--match-head-commit', HEAD, '-R', 'E1i/mikoshi-construct'])
    expect(result.exitCode).toBe(0)
  })

  it('arms nothing for decision auto when one path is owner-merged, and names that path', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', '.claude/agents/implementer.md'])
    expect(armed(calls)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] owner path .claude/agents/implementer.md — merge is Eli\'s'])
  })

  it('a PR touching .claude/settings.json, .claude/skills or .claude/commands is owner-merged and never armed', () => {
    for (const file of ['.claude/settings.json', '.claude/skills/x/SKILL.md', '.claude/commands/x.md']) {
      const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', file])
      expect(armed(calls)).toBe(false)
      expect(result.stdout).toEqual([`[shift:merge] owner path ${file} — merge is Eli's`])
    }
  })

  it('a PR touching .claude/hooks or .claude/eddies.json is owner-merged and never armed', () => {
    for (const file of ['.claude/hooks/role-guard.mjs', '.claude/eddies.json']) {
      const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', file])
      expect(armed(calls)).toBe(false)
      expect(result.stdout).toEqual([`[shift:merge] owner path ${file} — merge is Eli's`])
    }
  })

  it('a PR touching only .claude/statusline.sh is not listed', () => {
    const { calls, result } = run(cardLine('auto'), ['.claude/statusline.sh'])
    expect(armed(calls)).toBe(true)
    expect(result.stdout).toEqual([`[shift:merge] decision auto, no owner path — auto-merge armed on PR #42 at ${HEAD}`])
  })

  it('a PR touching only architecture/ghosts-files.md is not listed', () => {
    const { calls } = run(cardLine('auto'), ['architecture/ghosts-files.md'])
    expect(isListed('architecture/ghosts-files.md', GHOSTS_FILES)).toBe(false)
    expect(armed(calls)).toBe(true)
  })

  it('arms nothing for a pull request that changes src/ with no matrix count line, and names the path', () => {
    const { calls, result } = run(cardLine('auto'), ['src/program.ts', 'scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[shift:merge] PR #42 changes src/program.ts and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md); auto-merge not armed'])
  })

  it('arms nothing for a pull request that changes templates/ with no matrix count line', () => {
    const { calls, result } = run(cardLine('auto'), ['templates/base/architecture/principles.md'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('arms auto-merge for a pull request that changes src/ and ends with the matrix count line', () => {
    const { calls, result } = run(`${cardLine('auto')}\n\n|    | BD | E9 | FF |\n| 7A | ■ | · | · |\n\n■ 1 □ 0 · 5`, ['src/program.ts'])
    expect(armed(calls)).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('arms auto-merge for a pull request that changes only scripts/ with no matrix', () => {
    const { calls } = run(cardLine('auto'), ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(true)
  })

  it('refuses a pull request whose first line is not a card', () => {
    const { calls, result } = run('Some description', ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('refuses an argument that is not a pull request number', () => {
    expect(runMerge(['#42'], { gh: () => '', ownerMergesText: () => OWNER_MERGES }).exitCode).toBe(1)
  })
})

describe('isListed', () => {
  const text = '| file | kind |\n|---|---|\n| `scripts/ghosts/a.ts` | ghosts |\n| `scripts/ghosts/b.ts` | plain |\n'

  it('finds a path of either kind in ghosts-files.md, and not an unlisted one', () => {
    expect([isListed('scripts/ghosts/a.ts', text), isListed('scripts/ghosts/b.ts', text), isListed('scripts/ghosts/c.ts', text)]).toEqual([true, true, false])
  })

  it('reads a ghosts row and a plain row of the real ghosts-files.md as listed', () => {
    expect(isListed('scripts/ghosts/launch.ts', GHOSTS_FILES) && isListed('scripts/ghosts/entry.ts', GHOSTS_FILES)).toBe(true)
  })
})

describe('runVerdict', () => {
  const NOW = new Date('2026-10-09T03:00:00.000Z')

  function verdictRun(argv: string[], publish: (status: ReviewStatus) => void): { appended: string[], result: ReturnType<typeof runVerdict> } {
    const appended: string[] = []
    const gh = (): string => JSON.stringify({ body: cardLine('auto'), headRefOid: HEAD, files: [{ path: 'scripts/board/derive.ts' }] })
    const result = runVerdict(argv, { gh, journal: 'ghosts.jsonl', append: (_, text) => appended.push(text), now: () => NOW, publish })
    return { appended, result }
  }

  it.each([
    { verdict: 'pass', state: 'success' },
    { verdict: 'changes', state: 'failure' },
  ])('posts the review status on the reviewed commit of a cheap PR: $verdict is $state', ({ verdict, state }) => {
    const posted: ReviewStatus[] = []
    const { appended, result } = verdictRun(['42', '--verdict', verdict, '--commit', HEAD], status => posted.push(status))
    expect(result.exitCode).toBe(0)
    expect(appended).toHaveLength(1)
    expect(posted).toEqual([{ commit: HEAD, state, context: 'review', description: `review verdict ${verdict} for task 7` }])
  })

  it('posts nothing for a commit that is not the head', () => {
    const posted: ReviewStatus[] = []
    const { appended, result } = verdictRun(['42', '--verdict', 'pass', '--commit', 'f00dfee'], status => posted.push(status))
    expect(result.exitCode).toBe(1)
    expect([appended, posted]).toEqual([[], []])
  })

  it('reports a status gh could not post after the journal line is written', () => {
    const { appended, result } = verdictRun(['42', '--verdict', 'pass', '--commit', HEAD], () => {
      throw new Error('gh: HTTP 403\nmore')
    })
    expect(appended).toHaveLength(1)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[shift:verdict] the journal line is written, but the review status on ${HEAD} was not posted: gh: HTTP 403`])
  })
})

describe('runCarry', () => {
  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }

  function commit(repo: string, files: Record<string, string>, message: string): string {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), text)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }

  function reviewedPullRequest(own: Record<string, string>): { repo: string, reviewed: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'shift-merge-carry-'))
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, { 'shared.txt': 'one\ntwo\nthree\n' }, 'base')
    git(repo, 'checkout', '-q', '-b', 'pr')
    return { repo, reviewed: commit(repo, own, 'own') }
  }

  function mainMoves(repo: string, files: Record<string, string>): void {
    git(repo, 'checkout', '-q', 'main')
    commit(repo, files, 'main moved')
    git(repo, 'checkout', '-q', 'pr')
  }

  function carryRun(repo: string, reviewed: string, head: string, body = cardLine('auto')): { posted: ReviewStatus[], result: ReturnType<typeof runCarry> } {
    const posted: ReviewStatus[] = []
    const journal = prReviewLine({ task: '7', pr: 42, verdict: 'pass', commit: reviewed }, new Date('2026-10-09T03:00:00.000Z'))
    const gh = (): string => JSON.stringify({ body, headRefOid: head, files: [{ path: 'scripts/board/derive.ts' }] })
    const result = runCarry(['42', '--carry'], { gh, git: args => git(repo, ...args), fetch: () => {}, journal: () => journal, main: 'main', publish: status => posted.push(status) })
    return { posted, result }
  }

  it('carries a review success from head A to the head B a clean update-branch merge left', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
    mainMoves(repo, { 'other.txt': 'main moved\n' })
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const { posted, result } = carryRun(repo, reviewed, head)
    expect(posted).toEqual([{ commit: head, state: 'success', context: 'review', description: `carried from ${reviewed}` }])
    expect(result.exitCode).toBe(0)
  })

  it('carry accepts a body whose first line starts with card: ', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'own.txt': 'the pull request\n' })
    mainMoves(repo, { 'other.txt': 'main moved\n' })
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const { posted, result } = carryRun(repo, reviewed, head, `card: ${cardLine('auto')}\n\nbody`)
    expect(result.stderr).toEqual([])
    expect(posted).toEqual([{ commit: head, state: 'success', context: 'review', description: `carried from ${reviewed}` }])
    expect(result.exitCode).toBe(0)
  })

  it('publishes nothing on B when the update-branch merge resolved a conflict, and says a new review is needed', () => {
    const { repo, reviewed } = reviewedPullRequest({ 'shared.txt': 'one\nTWO from the pull request\nthree\n' })
    mainMoves(repo, { 'shared.txt': 'one\nTWO from main\nthree\n' })
    expect(() => git(repo, 'merge', '-q', '--no-edit', 'main')).toThrow()
    const head = commit(repo, { 'shared.txt': 'one\nTWO resolved\nthree\n' }, 'merge main')
    const { posted, result } = carryRun(repo, reviewed, head)
    expect(posted).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toContain(`[shift:carry] PR #42 needs a new review at ${head}`)
    expect(result.stderr[0]).toContain('resolved a conflict')
  })

  it('publishes nothing for a pull request with no review verdict on record', () => {
    const posted: ReviewStatus[] = []
    const gh = (): string => JSON.stringify({ body: cardLine('auto'), headRefOid: HEAD, files: [] })
    const result = runCarry(['42', '--carry'], { gh, git: () => '', fetch: () => {}, journal: () => null, main: 'main', publish: status => posted.push(status) })
    expect([posted, result.exitCode]).toEqual([[], 1])
  })
})
