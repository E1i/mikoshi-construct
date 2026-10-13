import type { SpawnSessionParams } from '../../ghosts/session.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fullReview } from '../../bus/review-depth.js'
import { claudeReviewer, GIT_TREE_TOOLS, PREFIX, reviewOf, reviewPrompt, reviewSession, ReviewTrees } from '../../bus/reviewer.js'
import { sessionArgv } from '../../ghosts/session.js'
import { sha } from './github-fake.js'

const lease = { taskKey: `review:1050:950:${sha('a')}`, queue: 'review' as const, cardId: 1050, pr: 950, head: sha('a'), leaseGen: 1, actor: 'worker:review:w' }
const full = fullReview('a fixed plan')

describe('reviewer', () => {
  it('a review file gives the verdict, the findings and the session', () => {
    expect(reviewOf('{"verdict":"changes","findings":["x"]}', 's-1')).toEqual({ verdict: 'changes', findings: ['x'], session: 's-1' })
  })

  it('a review file without a verdict word or a findings list is refused', () => {
    expect(() => reviewOf('{"verdict":"approve","findings":[]}', 's-1')).toThrow(/names no verdict/)
    expect(() => reviewOf('{"verdict":"pass"}', 's-1')).toThrow(/no findings list/)
  })

  it('the prompt names the task, the pull request, its tree, its head and the verdict file', () => {
    const prompt = reviewPrompt(lease, full, '/tmp/t', '/tmp/v.json')
    expect(prompt.split('\n')[0]).toBe(`[review:${lease.taskKey}]`)
    expect(prompt).toContain(`Pull request #950 of card #1050 is checked out at /tmp/t, at its head ${sha('a')}`)
    expect(prompt).toContain('writing /tmp/v.json as JSON')
  })

  it('the prompt of the first full review asks for every finding of the pass in one verdict, not in portions', () => {
    const prompt = reviewPrompt(lease, full, '/tmp/t', '/tmp/v.json')
    expect(prompt).toContain('Walk every mutation over the changed lines and report every finding of this pass in one verdict, not in portions.')
  })

  it('the prompt of the first cheap review asks for every finding of the pass in one verdict too', () => {
    const prompt = reviewPrompt(lease, { depth: 'cheap', why: 'inside the touches', base: sha('c') }, '/tmp/t', '/tmp/v.json')
    expect(prompt).toContain('report every finding of this pass in one verdict, not in portions')
  })

  it('the prompt of a re-review names the earlier findings, the diff since..head and a regression outside the diff the change causes', () => {
    const prompt = reviewPrompt(lease, { depth: 'diff', why: 'after changes', since: sha('b'), findings: ['a.ts:1 x'] }, '/tmp/t', '/tmp/v.json')
    expect(prompt).toContain('Earlier finding: a.ts:1 x')
    expect(prompt).toContain(`explore the diff ${sha('b')}..${sha('a')}`)
    expect(prompt).toContain('its callers, the modules that depend on it, its tests, and a regression outside the diff that the change causes')
    expect(prompt).toContain('report every finding of this pass in one verdict, not in portions')
  })

  it('the review session starts in the worker repository, never in the tree of the pull request it reviews', () => {
    const params = reviewSession('/repo', '/reviews', 's-1', lease, full)
    expect(params.cwd).toBe('/repo')
    expect(params.tree).toBe('/reviews/s-1')
    expect(params.cwd).not.toBe(params.tree)
    expect(params.addDirs).toEqual(['/reviews'])
    expect(params.prompt).toContain('checked out at /reviews/s-1')
  })

  it('a failing worktree remove does not mask the review', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-'))
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const git = (_cwd: string, args: string[]): void => {
        if (args[0] === 'worktree' && args[1] === 'remove')
          throw new Error('fatal: the tree is locked')
      }
      const passing = async (params: SpawnSessionParams): Promise<number> => {
        writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
        return 0
      }

      const trees = new ReviewTrees('/repo', dir, { git, worktrees: () => [] })
      expect(await claudeReviewer(trees, passing)(lease, full)).toMatchObject({ verdict: 'pass', findings: [] })
      await expect(claudeReviewer(trees, async () => 1)(lease, full)).rejects.toThrow(/exited 1/)
      const lines = printed.mock.calls.map(call => String(call[0]))
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        expect(line.startsWith(`${PREFIX}could not remove the review tree ${dir}/`)).toBe(true)
        expect(line.endsWith('fatal: the tree is locked')).toBe(true)
      }
    }
    finally {
      printed.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a leftover tree of a killed review session goes on the next pass, while a held tree, a tree outside the reviews dir and the session files stay', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-reviewer-leftover-')))
    const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const repo = path.join(root, 'repo')
      const dir = path.join(root, 'reviews')
      mkdirSync(repo)
      mkdirSync(dir)
      run(repo, 'init', '-q')
      writeFileSync(path.join(repo, 'a.txt'), 'a\n')
      run(repo, 'add', 'a.txt')
      run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a')
      const head = run(repo, 'rev-parse', 'HEAD').trim()
      const killed = path.join(dir, 'killed')
      const held = path.join(dir, 'held')
      const outside = path.join(root, 'card-tree')
      new ReviewTrees(repo, dir).add(killed, head)
      const sessionFiles = ['killed.out.jsonl', 'killed.err.log', 'killed.verdict.json'].map(name => path.join(dir, name))
      for (const file of sessionFiles)
        writeFileSync(file, '{}')
      run(repo, 'worktree', 'add', '-q', '--detach', outside, head)
      const next = new ReviewTrees(repo, dir)
      next.add(held, head)

      expect(next.clearLeftovers()).toEqual([{ path: killed, left: null }])
      expect(existsSync(killed)).toBe(false)
      expect(existsSync(held)).toBe(true)
      expect(existsSync(outside)).toBe(true)
      expect(sessionFiles.filter(file => existsSync(file))).toEqual(sessionFiles)
      expect(GIT_TREE_TOOLS.worktrees(repo).sort()).toEqual([repo, held, outside].sort())
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a leftover tree git cannot remove comes back with its path and git\'s reason, and stays for the next pass', () => {
    const removes: string[] = []
    const git = (_cwd: string, args: string[]): void => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removes.push(args[3]!)
        throw Object.assign(new Error('Command failed: git worktree remove'), { stderr: Buffer.from('error: unable to remove /reviews/stuck/node_modules: Resource busy\n') })
      }
    }
    const trees = new ReviewTrees('/repo', '/reviews', { git, worktrees: () => ['/repo', '/reviews/stuck'] })

    expect(trees.clearLeftovers()).toEqual([{ path: '/reviews/stuck', left: 'error: unable to remove /reviews/stuck/node_modules: Resource busy' }])
    expect(trees.clearLeftovers()).toEqual([{ path: '/reviews/stuck', left: 'error: unable to remove /reviews/stuck/node_modules: Resource busy' }])
    expect(removes).toEqual(['/reviews/stuck', '/reviews/stuck'])
  })

  it('an added directory goes before the headless flags, so it cannot take the prompt as a second directory', () => {
    const argv = sessionArgv('s-1', 'the prompt', ['/reviews'])
    expect(argv.slice(0, 3)).toEqual(['--add-dir', '/reviews', '-p'])
    expect(argv.at(-1)).toBe('the prompt')
    expect(sessionArgv('s-1', 'the prompt')[0]).toBe('-p')
  })
})
