import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewCarry } from '../../ghosts/review-carry.js'
import { checkVerdict, recordVerdict, REVIEW_CARRY_EVENT } from '../../ghosts/verdict.js'

const IMPLEMENT = '/implement the contour contracts (t)'
const REPORT = '[review:t]\nThe witnesses ran.\n'
const NOW = new Date('2026-10-06T02:00:00.000Z')

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

interface PullRequest { repo: string, reviewed: string }

function reviewedPullRequest(): PullRequest {
  const repo = mkdtempSync(path.join(tmpdir(), 'ghosts-review-carry-'))
  git(repo, 'init', '-q', '-b', 'main')
  commit(repo, { 'shared.txt': 'one\ntwo\nthree\n' }, 'base')
  git(repo, 'checkout', '-q', '-b', 'pr')
  const reviewed = commit(repo, { 'own.txt': 'the pull request\n' }, 'own')
  return { repo, reviewed }
}

function mainMoves(world: PullRequest, files: Record<string, string>): void {
  git(world.repo, 'checkout', '-q', 'main')
  commit(world.repo, files, 'main moved')
  git(world.repo, 'checkout', '-q', 'pr')
}

function updateBranch(world: PullRequest): string {
  git(world.repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
  return git(world.repo, 'rev-parse', 'HEAD')
}

function carry(world: PullRequest, to: string) {
  return reviewCarry(args => git(world.repo, ...args), world.reviewed, to, 'main')
}

describe('reviewCarry over a real repository', () => {
  it('carries the review across an update-branch whose merge git merge-tree reproduces, naming the merge', () => {
    const world = reviewedPullRequest()
    mainMoves(world, { 'other.txt': 'main moved\n' })
    const merged = updateBranch(world)
    expect(carry(world, merged)).toEqual({ ok: true, ownCommits: 1, merges: [merged] })
  })

  it('carries across two update-branch merges in a row', () => {
    const world = reviewedPullRequest()
    mainMoves(world, { 'other.txt': 'first\n' })
    const first = updateBranch(world)
    mainMoves(world, { 'third.txt': 'second\n' })
    const second = updateBranch(world)
    expect(carry(world, second)).toEqual({ ok: true, ownCommits: 1, merges: [second, first] })
  })

  it('refuses a merge whose conflict was resolved by hand', () => {
    const world = reviewedPullRequest()
    commit(world.repo, { 'shared.txt': 'one\nTWO from the pull request\nthree\n' }, 'own edits shared')
    const reviewed = git(world.repo, 'rev-parse', 'HEAD')
    mainMoves(world, { 'shared.txt': 'one\nTWO from main\nthree\n' })
    try {
      git(world.repo, 'merge', '-q', '--no-edit', 'main')
    }
    catch {
      commit(world.repo, { 'shared.txt': 'one\nTWO resolved\nthree\n' }, 'merge main')
    }
    const merged = git(world.repo, 'rev-parse', 'HEAD')
    const result = reviewCarry(args => git(world.repo, ...args), reviewed, merged, 'main')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain(`merge ${merged.slice(0, 7)} resolved a conflict`)
  })

  it('refuses a clean merge whose tree was edited by hand, naming both trees', () => {
    const world = reviewedPullRequest()
    mainMoves(world, { 'other.txt': 'main moved\n' })
    updateBranch(world)
    writeFileSync(path.join(world.repo, 'own.txt'), 'slipped into the merge\n')
    git(world.repo, 'commit', '-q', '-a', '--amend', '--no-edit')
    const merged = git(world.repo, 'rev-parse', 'HEAD')
    const result = carry(world, merged)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(new RegExp(`merge ${merged.slice(0, 7)} holds tree [0-9a-f]{7}, not the [0-9a-f]{7} git merge-tree gives its parents`))
  })

  it('refuses when the pull request gained a commit of its own after the review', () => {
    const world = reviewedPullRequest()
    mainMoves(world, { 'other.txt': 'main moved\n' })
    updateBranch(world)
    const after = commit(world.repo, { 'own.txt': 'changed after the review\n' }, 'own again')
    const result = carry(world, after)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('git range-diff of the pull request\'s own commits shows')
  })

  it('refuses a head the reviewed commit is not an ancestor of', () => {
    const world = reviewedPullRequest()
    mainMoves(world, { 'other.txt': 'main moved\n' })
    git(world.repo, 'rebase', '-q', 'main')
    const rebased = git(world.repo, 'rev-parse', 'HEAD')
    expect(carry(world, rebased)).toEqual({ ok: false, reason: `the review of ${world.reviewed.slice(0, 7)} does not carry to ${rebased.slice(0, 7)}: ${world.reviewed.slice(0, 7)} is not an ancestor of ${rebased.slice(0, 7)}; review again` })
  })
})

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function handoff(world: PullRequest): { dir: string, verdict: string, journal: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-review-carry-handoff-'))
  writeFileSync(path.join(dir, 'brief-t.md'), `# Brief\n\n${IMPLEMENT}\n`)
  writeFileSync(path.join(dir, 'brief-t.approved-sha256'), `sha256: ${sha256(IMPLEMENT)}\n`)
  writeFileSync(path.join(dir, 'review-t.md'), REPORT)
  const verdict = path.join(dir, 'review-t.verdict.json')
  const tree = git(world.repo, 'rev-parse', `${world.reviewed}^{tree}`)
  writeFileSync(verdict, `${JSON.stringify({ task: 't', verdict: 'pass', head: world.reviewed, tree, brief: { path: 'brief-t.md', sha256: sha256(IMPLEMENT) }, report: { path: 'review-t.md', sha256: sha256(REPORT) } }, null, 2)}\n`)
  return { dir, verdict, journal: path.join(dir, 'ghosts.jsonl') }
}

function journalLines(journal: string): Record<string, unknown>[] {
  return readFileSync(journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('ghosts:verdict on the head an update-branch left', () => {
  it('writes a review-carry line from the reviewed commit to the new head when a review line for the same verdict file stands', async () => {
    const world = reviewedPullRequest()
    const { dir, verdict, journal } = handoff(world)
    expect((await recordVerdict(verdict, dir, { commit: world.reviewed, repo: world.repo, main: 'main' })).ok).toBe(true)
    mainMoves(world, { 'other.txt': 'main moved\n' })
    const merged = updateBranch(world)
    const result = await recordVerdict(verdict, dir, { commit: merged, repo: world.repo, main: 'main' })
    expect(result.ok).toBe(true)
    const lines = journalLines(journal)
    expect(lines.map(line => line.event)).toEqual(['review', REVIEW_CARRY_EVENT])
    expect(lines[1]).toEqual({ event: REVIEW_CARRY_EVENT, ts: expect.any(String), task: 't', verdict: 'pass', from: world.reviewed, to: merged, tree: lines[0]!.tree, ownCommits: 1, merges: [merged], file: lines[0]!.file })
  })

  it('refuses a carry that fails with the tree reason and the carry reason both, and writes nothing', async () => {
    const world = reviewedPullRequest()
    const { dir, verdict, journal } = handoff(world)
    await recordVerdict(verdict, dir, { commit: world.reviewed, repo: world.repo, main: 'main' })
    mainMoves(world, { 'other.txt': 'main moved\n' })
    updateBranch(world)
    const after = commit(world.repo, { 'own.txt': 'changed after the review\n' }, 'own again')
    const result = await recordVerdict(verdict, dir, { commit: after, repo: world.repo, main: 'main' })
    expect(result.ok).toBe(false)
    const reasons = result.ok ? [] : result.reasons
    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toMatch(/^verdict tree [0-9a-f]{40} is not the tree of [0-9a-f]{40}/)
    expect(reasons[1]).toContain(`the review of ${world.reviewed.slice(0, 7)} does not carry to ${after.slice(0, 7)}`)
    expect(journalLines(journal).map(line => line.event)).toEqual(['review'])
  })

  it('keeps the plain tree refusal when no review line for this verdict file stands', () => {
    const world = reviewedPullRequest()
    const { dir, verdict } = handoff(world)
    mainMoves(world, { 'other.txt': 'main moved\n' })
    const merged = updateBranch(world)
    const result = checkVerdict(verdict, dir, { commit: merged, repo: world.repo, main: 'main' }, NOW)
    expect(result.ok ? [] : result.reasons).toEqual([`verdict tree ${git(world.repo, 'rev-parse', `${world.reviewed}^{tree}`)} is not the tree of ${merged} (${git(world.repo, 'rev-parse', `${merged}^{tree}`)})`])
  })

  it('keeps the plain tree refusal when the review line stands for another verdict file of the same task and tree', async () => {
    const world = reviewedPullRequest()
    const { dir, verdict } = handoff(world)
    await recordVerdict(verdict, dir, { commit: world.reviewed, repo: world.repo, main: 'main' })
    writeFileSync(verdict, readFileSync(verdict, 'utf8').replace('"verdict": "pass"', '"verdict": "changes"'))
    mainMoves(world, { 'other.txt': 'main moved\n' })
    const merged = updateBranch(world)
    const result = checkVerdict(verdict, dir, { commit: merged, repo: world.repo, main: 'main' }, NOW)
    expect(result.ok ? [] : result.reasons).toEqual([`verdict tree ${git(world.repo, 'rev-parse', `${world.reviewed}^{tree}`)} is not the tree of ${merged} (${git(world.repo, 'rev-parse', `${merged}^{tree}`)})`])
  })
})
