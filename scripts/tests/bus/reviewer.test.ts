import type { TreeTools } from '../../bus/reviewer.js'
import type { SpawnSessionParams } from '../../ghosts/session.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { fullReview } from '../../bus/review-depth.js'
import { claudeReviewer, commandMayWrite, GIT_TREE_TOOLS, HEAD_MOVED, mutatedPaths, PREPARE_TREE, PREPARED_TREE_LINE, prepareEnv, ReviewFailed, reviewOf, reviewPrompt, reviewSession, ReviewTrees } from '../../bus/reviewer.js'
import { sessionArgv } from '../../ghosts/session.js'
import { sha } from './github-fake.js'

const lease = { taskKey: `review:1050:950:${sha('a')}`, queue: 'review' as const, cardId: 1050, pr: 950, head: sha('a'), leaseGen: 1, actor: 'worker:review:w' }
const full = fullReview('a fixed plan')
const cleanTree: Pick<TreeTools, 'prepare' | 'state'> = { prepare: () => {}, state: () => ({ head: sha('a'), status: [] }) }
const unprepared: TreeTools = { ...GIT_TREE_TOOLS, prepare: () => {} }
const WORKAROUNDS = [/\b(?:pnpm|npm|yarn) (?:i|install|add)\b/, /\bln -s\b/, /symlink/i, /git archive/]

function gitRun(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

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

  it('the prompt of a first diff review reads only since..head against the card, its witnesses and touches, and makes each touch finding a finding', () => {
    const prompt = reviewPrompt(lease, { depth: 'diff', round: 'first', why: 'by rule docs-only', since: sha('c'), touchFindings: ['architecture/window.md is outside the touches of card #1050 (docs/**)'] }, '/tmp/t', '/tmp/v.json')
    expect(prompt).toContain(`Read only the diff ${sha('c')}..${sha('a')} against the card, its witnesses, its touches and its runs (the tests the card's Runs: line names); do not walk the modules it touches.`)
    expect(prompt).toContain('Report as a finding of this review: architecture/window.md is outside the touches of card #1050 (docs/**)')
    expect(prompt).not.toContain('Review the whole pull request')
    expect(prompt).toContain('report every finding of this pass in one verdict, not in portions')
  })

  it('the prompt of a re-review names the earlier findings, the diff since..head and a regression outside the diff the change causes', () => {
    const prompt = reviewPrompt(lease, { depth: 'diff', round: 'again', why: 'after changes', since: sha('b'), findings: ['a.ts:1 x'] }, '/tmp/t', '/tmp/v.json')
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

  it('the review session passes CONSTRUCT_REVIEW_MODEL as its model, and none without it', () => {
    expect(reviewSession('/repo', '/reviews', 's-1', lease, full, { CONSTRUCT_REVIEW_MODEL: 'claude-sonnet-5-5' }).model).toBe('claude-sonnet-5-5')
    expect(reviewSession('/repo', '/reviews', 's-1', lease, full, {}).model).toBeUndefined()
  })

  it('the review carries the model the session ran from its stream-json, not the env value', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-model-'))
    vi.stubEnv('CONSTRUCT_REVIEW_MODEL', 'claude-sonnet-5-5')
    try {
      const spawned: SpawnSessionParams[] = []
      const running = async (params: SpawnSessionParams): Promise<number> => {
        spawned.push(params)
        writeFileSync(params.stdoutPath, '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}\n')
        writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
        return 0
      }
      const trees = new ReviewTrees('/repo', dir, { git: () => {}, worktrees: () => [], ...cleanTree })
      expect(await claudeReviewer(trees, running)(lease, full)).toMatchObject({ verdict: 'pass', model: 'claude-haiku-5-5' })
      expect(spawned.map(params => params.model)).toEqual(['claude-sonnet-5-5'])
    }
    finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failing worktree remove does not mask the review, and the release of the tree returns git\'s reason', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-'))
    try {
      const git = (_cwd: string, args: string[]): void => {
        if (args[0] === 'worktree' && args[1] === 'remove')
          throw new Error('fatal: the tree is locked')
      }
      let given = ''
      const passing = async (params: SpawnSessionParams): Promise<number> => {
        given = params.prompt
        writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
        return 0
      }

      const trees = new ReviewTrees('/repo', dir, { git, worktrees: () => [], ...cleanTree })
      const review = await claudeReviewer(trees, passing)(lease, full)
      expect(review).toMatchObject({ verdict: 'pass', findings: [] })
      expect(given).toContain(`[review:${lease.taskKey}]`)
      expect(review.input).toEqual({ prompt: given })
      expect(review.tree!.path.startsWith(`${dir}/`)).toBe(true)
      expect(review.tree!.release()).toBe('fatal: the tree is locked')
      const failed = await claudeReviewer(trees, async () => 1)(lease, full).catch((error: unknown) => error)
      expect(failed).toMatchObject({ message: expect.stringMatching(/exited 1/) })
      expect((failed as { held: { release: () => string | null } }).held.release()).toBe('fatal: the tree is locked')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('after ReviewTrees.add prepares the tree node_modules/.bin/vitest exists in it', () => {
    const repo = gitRun(process.cwd(), 'rev-parse', '--show-toplevel').trim()
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-reviewer-prepare-')))
    const trees = new ReviewTrees(repo, dir)
    const tree = path.join(dir, 'prepared')
    try {
      trees.add(tree, gitRun(repo, 'rev-parse', 'HEAD').trim())

      expect(existsSync(path.join(tree, 'node_modules', '.bin', 'vitest'))).toBe(true)
      expect(trees.state(tree).status).toEqual([])
    }
    finally {
      trees.release(tree)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('a review tree that is not clean before the review is refused before the session runs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-dirty-'))
    try {
      const spawned: string[] = []
      const trees = new ReviewTrees('/repo', dir, { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: sha('a'), status: [' M a.txt'] }) })

      await expect(claudeReviewer(trees, async (params) => {
        spawned.push(params.sessionId)
        return 0
      })(lease, full)).rejects.toThrow(/not clean before the review: {2}M a\.txt/)
      expect(spawned).toEqual([])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the tree state names a renamed file by both paths and a path with spaces unquoted', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-reviewer-status-')))
    try {
      gitRun(root, 'init', '-q')
      writeFileSync(path.join(root, 'a.txt'), 'a\n')
      gitRun(root, 'add', 'a.txt')
      gitRun(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a')
      gitRun(root, 'mv', 'a.txt', 'b c.txt')
      writeFileSync(path.join(root, 'd "e".txt'), 'd\n')

      expect(GIT_TREE_TOOLS.state(root).status).toEqual(['R  b c.txt', 'R  a.txt', '?? d "e".txt'])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a tree mutated outside the review session is a node fault, not a changes verdict', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-foreign-'))
    try {
      const transcript = (tool: object): string => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', ...tool }] } })}\n`
      const run = async (stdout: string): Promise<unknown> => {
        let states = 0
        const trees = new ReviewTrees('/repo', dir, { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: sha('a'), status: states++ === 0 ? [] : [' D a.txt', ' D b.txt'] }) })
        return claudeReviewer(trees, async (params) => {
          writeFileSync(params.stdoutPath, stdout)
          writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
          return 0
        })(lease, full).catch((error: unknown) => error)
      }

      const foreign = await run(`\nnot json\n${transcript({ name: 'Bash', input: { command: 'git status --short' } })}${transcript({ name: 'Bash', input: { command: 'pnpm exec vitest run 2>&1 | tail' } })}${transcript({ name: 'Read', input: { file_path: '/x' } })}`)
      expect(foreign).toBeInstanceOf(ReviewFailed)
      expect((foreign as Error).message).toMatch(/changed outside the review session .*node fault/)
      expect((foreign as Error).message).toContain('a.txt, b.txt')

      const own = await run(transcript({ name: 'Bash', input: { command: 'rm a.txt b.txt' } }))
      expect(own).toMatchObject({ verdict: 'changes', tree: { mutated: ['a.txt', 'b.txt'] } })

      const mutation = await run(transcript({ name: 'Bash', input: { command: 'construct mutate apply scripts/bus/reviewer.ts' } }))
      expect(mutation).toMatchObject({ verdict: 'changes' })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const COMMANDS_THAT_MAY_WRITE: Record<string, boolean> = {
    'pnpm exec vitest run 2>&1 | tail': false,
    'ls >/dev/null': false,
    'git diff main 2>/dev/null; echo done': false,
    'cmd >>/dev/null 2>&1': false,
    'node -p "[1].map(x => x)"': false,
    'git log --format=%H -n1': false,
    'git status --short': false,
    'echo x > out.txt': true,
    'echo x >>out.txt': true,
    'cmd 2>err.log': true,
    'cmd &> all.log': true,
    'rm a.txt': true,
    'construct mutate apply scripts/bus/reviewer.ts': true,
    'npx mikoshi-construct mutate judge': true,
    'pnpm composition:render': true,
    'pnpm run model:render': true,
    'pnpm lint:fix': true,
    'pnpm exec eslint --fix scripts': true,
    'node -e "require(\'fs\').rmSync(\'x\')"': true,
    'perl -pi -e s/a/b/ f': true,
  }

  it.each(Object.entries(COMMANDS_THAT_MAY_WRITE))('a review command %s may write: %s', (command, writes) => {
    expect(commandMayWrite(command)).toBe(writes)
  })

  it('a moved HEAD is a mutation even when the status is clean', () => {
    expect(mutatedPaths({ head: sha('a'), status: [] }, { head: sha('b'), status: [] })).toEqual([HEAD_MOVED])
    expect(mutatedPaths({ head: sha('a'), status: [] }, { head: sha('a'), status: ['?? x.txt'] })).toEqual(['x.txt'])
  })

  it('the tree is prepared without lifecycle scripts and without the worker credentials', () => {
    expect(PREPARE_TREE).toContain('--ignore-scripts')
    expect(prepareEnv({ PATH: '/bin', HOME: '/home/w', GH_TOKEN: 'secret-token', ANTHROPIC_API_KEY: 'secret-key' })).toEqual({ PATH: '/bin', HOME: '/home/w' })
  })

  it('the tree is prepared from the cache first and fetches a package the cache does not hold', () => {
    expect(PREPARE_TREE).toContain('--prefer-offline')
    expect(PREPARE_TREE).not.toContain('--offline')
  })

  it('a worktree add that fails is not a held tree, so nothing is left to release', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-reviewer-add-'))
    try {
      const trees = new ReviewTrees('/repo', dir, {
        git: (_cwd, args) => {
          if (args[1] === 'add')
            throw new Error('fatal: invalid reference')
        },
        worktrees: () => [],
        ...cleanTree,
      })
      const failed = await claudeReviewer(trees, async () => 0)(lease, full).catch((error: unknown) => error)

      expect(failed).toBeInstanceOf(Error)
      expect(failed).not.toBeInstanceOf(ReviewFailed)
      expect((failed as Error).message).toBe('fatal: invalid reference')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the reviewer instruction names no install, symlink or git archive workaround', () => {
    const prompt = reviewPrompt(lease, full, '/tmp/t', '/tmp/v.json')
    const role = readFileSync(path.join(process.cwd(), '.claude', 'agents', 'review.md'), 'utf8')

    expect(prompt).toContain(PREPARED_TREE_LINE)
    expect(role).toContain('never prepare it yourself')
    for (const text of [prompt, role])
      expect(WORKAROUNDS.filter(workaround => workaround.test(text))).toEqual([])
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
      new ReviewTrees(repo, dir, unprepared).add(killed, head)
      const sessionFiles = ['killed.out.jsonl', 'killed.err.log', 'killed.verdict.json'].map(name => path.join(dir, name))
      for (const file of sessionFiles)
        writeFileSync(file, '{}')
      run(repo, 'worktree', 'add', '-q', '--detach', outside, head)
      const next = new ReviewTrees(repo, dir, unprepared)
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
    const trees = new ReviewTrees('/repo', '/reviews', { git, worktrees: () => ['/repo', '/reviews/stuck'], ...cleanTree })

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
