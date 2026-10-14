import type { SpawnSessionParams } from '../ghosts/session.js'
import type { Lease } from './lease.js'
import type { VerdictWord } from './record-verdict.js'
import type { ReviewPlan } from './review-depth.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { reviewModelOf, sessionModelOf, spawnSession } from '../ghosts/session.js'

export interface TreeState {
  head: string
  status: string[]
}

export interface HeldTree {
  path: string
  release: () => string | null
}

export interface ReviewedTree extends HeldTree {
  before: TreeState
  after: TreeState
  mutated: string[]
}

export interface Review {
  verdict: VerdictWord
  findings: string[]
  session: string
  model?: string
  tree?: ReviewedTree
}

export class ReviewFailed extends Error {
  constructor(message: string, readonly held: HeldTree) {
    super(message)
  }
}

export type Reviewer = (lease: Lease, plan: ReviewPlan) => Promise<Review>

export interface TreeTools {
  git: (cwd: string, args: string[]) => void
  worktrees: (repo: string) => string[]
  prepare: (tree: string) => void
  state: (tree: string) => TreeState
}

export interface LeftoverTree {
  path: string
  left: string | null
}

export const PREFIX = '[bus:review] '

const VERDICTS = new Set<string>(['pass', 'changes'])

export const PREPARE_TREE = ['pnpm', 'install', '--frozen-lockfile', '--offline']

export const PREPARED_TREE_LINE = 'The worker prepared this tree before the session: its dependencies are in place, so run the harness there as it is. Read and run; leave the tree as the worker left it, because the worker compares it before and after the review and a changed or new file makes the verdict changes.'

export function reviewOf(text: string, session: string): Review {
  const parsed = JSON.parse(text) as { verdict?: unknown, findings?: unknown }
  if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict))
    throw new Error(`the review of session ${session} names no verdict pass | changes`)
  if (!Array.isArray(parsed.findings) || !parsed.findings.every(finding => typeof finding === 'string'))
    throw new Error(`the review of session ${session} has no findings list of strings`)
  return { verdict: parsed.verdict as VerdictWord, findings: parsed.findings as string[], session }
}

const ONE_PASS = 'Walk every mutation over the changed lines and report every finding of this pass in one verdict, not in portions.'

function reReviewLines(since: string, head: string | null, findings: readonly string[]): string[] {
  return [
    `This is a re-review: check that each finding of the earlier verdict is closed, one still open stays a finding, and explore the diff ${since}..${head}.`,
    `A new finding is allowed on the changed lines and on code the change affects: its callers, the modules that depend on it, its tests, and a regression outside the diff that the change causes. Do not re-read the whole pull request without a reason; a new finding on code the change neither touches nor affects, which the first pass already read, is not allowed.`,
    ...findings.map(finding => `Earlier finding: ${finding}`),
  ]
}

function depthLines(lease: Lease, plan: ReviewPlan): string[] {
  const depth = `Review depth ${plan.depth}: ${plan.why}.`
  if (plan.depth === 'cheap')
    return [depth, `Read only the diff ${plan.base}..${lease.head} against the card and its witnesses; do not walk the modules it touches.`, ONE_PASS]
  if (plan.depth === 'diff')
    return [depth, ...reReviewLines(plan.since, lease.head, plan.findings), ONE_PASS]
  const ladder = plan.prediction?.verdict === 'ladder'
    ? [`MORSE predicts the ladder by rule ${plan.prediction.rule} (${plan.prediction.why.join(', ')}): check that the card or the pull request names the reason this change takes the ladder (D-76), and make a missing reason a finding.`]
    : []
  return [depth, `Review the whole pull request and walk every module it touches.`, ...ladder, ONE_PASS]
}

export function reviewPrompt(lease: Lease, plan: ReviewPlan, tree: string, verdictPath: string): string {
  return [
    `[review:${lease.taskKey}]`,
    `Act as the review role defined in .claude/agents/review.md. Pull request #${lease.pr} of card #${lease.cardId} is checked out at ${tree}, at its head ${lease.head}; read it there.`,
    PREPARED_TREE_LINE,
    `Review it against its card (the first line of the pull request description) and the repository's rules. Change nothing, commit nothing, push nothing, and post nothing to GitHub.`,
    ...depthLines(lease, plan),
    `Finish by writing ${verdictPath} as JSON: {"verdict": "pass" | "changes", "findings": ["one finding per string"]}.`,
  ].join('\n')
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function worktrees(repo: string): string[] {
  return execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
}

function prepare(tree: string): void {
  execFileSync(PREPARE_TREE[0]!, PREPARE_TREE.slice(1), { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] })
}

function state(tree: string): TreeState {
  const read = (args: string[]): string => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { head: read(['rev-parse', 'HEAD']).trim(), status: read(['status', '--porcelain']).split('\n').filter(line => line !== '') }
}

export const GIT_TREE_TOOLS: TreeTools = { git, worktrees, prepare, state }

function pathOfStatus(line: string): string {
  return line.slice(3)
}

function failureOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const said = Buffer.isBuffer(stderr) || typeof stderr === 'string' ? String(stderr).trim() : ''
  return said !== '' ? said : error instanceof Error ? error.message : String(error)
}

function canonical(where: string): string {
  const resolved = path.resolve(where)
  if (existsSync(resolved))
    return realpathSync(resolved)
  const parent = path.dirname(resolved)
  return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved))
}

export class ReviewTrees {
  private readonly held = new Set<string>()

  constructor(readonly repo: string, readonly dir: string, private readonly tools: TreeTools = GIT_TREE_TOOLS) {}

  add(tree: string, head: string): void {
    this.tools.git(this.repo, ['worktree', 'add', '--detach', tree, head])
    this.held.add(canonical(tree))
    this.tools.prepare(tree)
  }

  state(tree: string): TreeState {
    return this.tools.state(tree)
  }

  fetch(ref: string): void {
    this.tools.git(this.repo, ['fetch', '--quiet', 'origin', ref])
  }

  release(tree: string): string | null {
    this.held.delete(canonical(tree))
    const failure = this.remove(tree)
    if (failure === null)
      this.tools.git(this.repo, ['worktree', 'prune'])
    return failure
  }

  clearLeftovers(): LeftoverTree[] {
    const inside = canonical(this.dir) + path.sep
    const leftovers = this.tools.worktrees(this.repo).filter(tree => canonical(tree).startsWith(inside) && !this.held.has(canonical(tree)))
    const cleared = leftovers.map(tree => ({ path: tree, left: this.remove(tree) }))
    this.tools.git(this.repo, ['worktree', 'prune'])
    return cleared
  }

  private remove(tree: string): string | null {
    try {
      this.tools.git(this.repo, ['worktree', 'remove', '--force', tree])
      return null
    }
    catch (error) {
      return failureOf(error)
    }
  }
}

export function reviewSession(repo: string, dir: string, session: string, lease: Lease, plan: ReviewPlan, env: NodeJS.ProcessEnv = process.env): SpawnSessionParams & { tree: string, verdictPath: string } {
  const tree = path.join(dir, session)
  const verdictPath = path.join(dir, `${session}.verdict.json`)
  return {
    cwd: repo,
    addDirs: [dir],
    sessionId: session,
    prompt: reviewPrompt(lease, plan, tree, verdictPath),
    stdoutPath: path.join(dir, `${session}.out.jsonl`),
    stderrPath: path.join(dir, `${session}.err.log`),
    model: reviewModelOf(env),
    tree,
    verdictPath,
  }
}

export function claudeReviewer(trees: ReviewTrees, spawn: (params: SpawnSessionParams) => Promise<number> = spawnSession): Reviewer {
  return async (lease, plan) => {
    const session = randomUUID()
    const { tree, verdictPath, ...params } = reviewSession(trees.repo, trees.dir, session, lease, plan)
    mkdirSync(trees.dir, { recursive: true })
    trees.fetch(`pull/${lease.pr}/head`)
    const held: HeldTree = { path: tree, release: () => trees.release(tree) }
    try {
      trees.add(tree, lease.head!)
      const before = trees.state(tree)
      if (before.status.length > 0)
        throw new Error(`the review tree ${tree} is not clean before the review: ${before.status.join('; ')}`)
      const code = await spawn(params)
      if (code !== 0)
        throw new Error(`the review session ${session} exited ${code}`)
      const review = reviewOf(readFileSync(verdictPath, 'utf8'), session)
      const after = trees.state(tree)
      const mutated = after.status.map(pathOfStatus)
      const model = existsSync(params.stdoutPath) ? sessionModelOf(readFileSync(params.stdoutPath, 'utf8')) : undefined
      return { ...review, ...withoutPassOnMutation(review, mutated), model, tree: { ...held, before, after, mutated } }
    }
    catch (error) {
      throw new ReviewFailed(error instanceof Error ? error.message : String(error), held)
    }
  }
}

function withoutPassOnMutation(review: Review, mutated: string[]): Pick<Review, 'verdict' | 'findings'> {
  if (mutated.length === 0)
    return review
  return { verdict: 'changes', findings: [...review.findings, `the review session changed its tree, so its verdict ${review.verdict} does not count as pass: ${mutated.join(', ')}`] }
}
