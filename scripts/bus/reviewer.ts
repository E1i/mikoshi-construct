import type { SpawnSessionParams } from '../ghosts/session.js'
import type { Lease } from './lease.js'
import type { SessionInput } from './prompt-store.js'
import type { VerdictWord } from './record-verdict.js'
import type { ReviewPlan } from './review-depth.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readResultFields } from '../ghosts/result.js'
import { reviewModelOf, sessionModelOf, spawnSession, withoutCard } from '../ghosts/session.js'

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
  cache?: CacheTokens
  tree?: ReviewedTree
  input?: SessionInput
}

export interface CacheTokens {
  cache_w: number | null
  cache_r: number | null
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

export function cacheTokensOf(usage: unknown): CacheTokens {
  const fields = usage !== null && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  return { cache_w: tokenCount(fields.cache_creation_input_tokens), cache_r: tokenCount(fields.cache_read_input_tokens) }
}

export class ReviewFailed extends Error {
  constructor(message: string, readonly held: HeldTree) {
    super(message)
  }
}

export type Reviewer = (lease: Lease, plan: ReviewPlan, card?: string | null) => Promise<Review>

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

export const PREPARE_TREE = ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']

export const PREPARE_MS = 10 * 60_000

export const REVIEW_CEILING_MINUTES = 20

export const REVIEW_CEILING_MS = REVIEW_CEILING_MINUTES * 60_000

export const REVIEW_BEAT_MS = 60_000

export type SessionPulse = (lease: Lease, session: string) => void

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']

export const PREPARE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', ...PROXY_ENV_KEYS]

export const HEAD_MOVED = 'HEAD'

export const PREPARED_TREE_LINE = 'The worker prepared this tree before the session: its dependencies are in place, so run the harness there as it is. Read and run; leave the tree as the worker left it, because the worker compares it before and after the review and a moved HEAD or a changed or new file git does not ignore makes the verdict changes.'

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

function firstDiffLines(since: string, head: string | null, touchFindings: readonly string[]): string[] {
  return [
    `Read only the diff ${since}..${head} against the card, its witnesses, its touches and its runs (the tests the card's Runs: line names); do not walk the modules it touches.`,
    ...touchFindings.map(finding => `Report as a finding of this review: ${finding}`),
  ]
}

function depthLines(lease: Lease, plan: ReviewPlan): string[] {
  const depth = `Review depth ${plan.depth}: ${plan.why}.`
  if (plan.depth === 'diff' && plan.round === 'first')
    return [depth, ...firstDiffLines(plan.since, lease.head, plan.touchFindings), ONE_PASS]
  if (plan.depth === 'diff')
    return [depth, ...reReviewLines(plan.since, lease.head, plan.findings), ONE_PASS]
  const ladder = plan.prediction?.verdict === 'ladder'
    ? [`MORSE predicts the ladder by rule ${plan.prediction.rule} (${plan.prediction.why.join(', ')}): check that the card or the pull request names the reason this change takes the ladder (D-76), and make a missing reason a finding.`]
    : []
  return [depth, `Review the whole pull request and walk every module it touches.`, ...ladder, ONE_PASS]
}

const HANDS_OFF = 'Change nothing, commit nothing, push nothing, and post nothing to GitHub.'

function cardLines(card: string | null): string[] {
  if (card === null)
    return [`Review it against its card (the first line of the pull request description) and the repository's rules. ${HANDS_OFF}`]
  return [
    `Review it against its card, which the bus holds and which follows between the card markers, and the repository's rules; do not read the card from GitHub. ${HANDS_OFF}`,
    '<card>',
    card.trimEnd(),
    '</card>',
  ]
}

export function reviewPrompt(lease: Lease, plan: ReviewPlan, tree: string, verdictPath: string, card: string | null = null): string {
  return [
    `[review:${lease.taskKey}]`,
    `Act as the review role defined in .claude/agents/review.md. Pull request #${lease.pr} of card #${lease.cardId} is checked out at ${tree}, at its head ${lease.head}; read it there.`,
    PREPARED_TREE_LINE,
    ...cardLines(card),
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

export function prepareEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(PREPARE_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]))
}

function prepare(tree: string): void {
  execFileSync(PREPARE_TREE[0]!, PREPARE_TREE.slice(1), { cwd: tree, env: prepareEnv(process.env), timeout: PREPARE_MS, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function statusLines(porcelainZ: string): string[] {
  const fields = porcelainZ.split('\0').filter(field => field !== '')
  const lines: string[] = []
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at]!
    lines.push(field)
    if (field[0] === 'R' && fields[at + 1] !== undefined) {
      lines.push(`${field.slice(0, 3)}${fields[at + 1]}`)
      at += 1
    }
    else if (field[0] === 'C') {
      at += 1
    }
  }
  return lines
}

function state(tree: string): TreeState {
  const read = (args: string[]): string => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { head: read(['rev-parse', 'HEAD']).trim(), status: statusLines(read(['status', '--porcelain', '-z'])) }
}

export const GIT_TREE_TOOLS: TreeTools = { git, worktrees, prepare, state }

function pathOfStatus(line: string): string {
  return line.slice(3)
}

export function mutatedPaths(before: TreeState, after: TreeState): string[] {
  return [...(after.head === before.head ? [] : [HEAD_MOVED]), ...after.status.map(pathOfStatus)]
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

  holds(tree: string): boolean {
    return this.held.has(canonical(tree))
  }

  fetch(ref: string): void {
    this.tools.git(this.repo, ['fetch', '--quiet', 'origin', ref])
  }

  release(tree: string): string | null {
    this.held.delete(canonical(tree))
    return this.remove(tree) ?? this.prune()
  }

  clearLeftovers(): LeftoverTree[] {
    const inside = canonical(this.dir) + path.sep
    const leftovers = this.tools.worktrees(this.repo).filter(tree => canonical(tree).startsWith(inside) && !this.held.has(canonical(tree)))
    const cleared = leftovers.map(tree => ({ path: tree, left: this.remove(tree) }))
    this.tools.git(this.repo, ['worktree', 'prune'])
    return cleared
  }

  private prune(): string | null {
    try {
      this.tools.git(this.repo, ['worktree', 'prune'])
      return null
    }
    catch (error) {
      return failureOf(error)
    }
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

export function reviewSession(repo: string, dir: string, session: string, lease: Lease, plan: ReviewPlan, env: NodeJS.ProcessEnv = process.env, card: string | null = null): SpawnSessionParams & { tree: string, verdictPath: string } {
  const tree = path.join(dir, session)
  const verdictPath = path.join(dir, `${session}.verdict.json`)
  return {
    cwd: repo,
    addDirs: [dir],
    sessionId: session,
    prompt: reviewPrompt(lease, plan, tree, verdictPath, card),
    stdoutPath: path.join(dir, `${session}.out.jsonl`),
    stderrPath: path.join(dir, `${session}.err.log`),
    model: reviewModelOf(env),
    env: withoutCard(env),
    ceilingMs: REVIEW_CEILING_MS,
    tree,
    verdictPath,
  }
}

function sizeOf(file: string): number {
  return existsSync(file) ? statSync(file).size : 0
}

export function missedBeatLine(session: string, error: unknown): string {
  return `${PREFIX}the heartbeat of review session ${session} was not recorded, the review goes on: ${error instanceof Error ? error.message : String(error)}`
}

async function beatingWhileGrowing(run: Promise<number>, transcript: string, beat: () => void, beatMs: number, missed: (error: unknown) => void): Promise<number> {
  let seen = 0
  const ticker = setInterval(() => {
    try {
      const size = sizeOf(transcript)
      const grew = size > seen
      seen = size
      if (grew)
        beat()
    }
    catch (error) {
      missed(error)
    }
  }, beatMs)
  try {
    return await run
  }
  finally {
    clearInterval(ticker)
  }
}

export function claudeReviewer(trees: ReviewTrees, spawn: (params: SpawnSessionParams) => Promise<number> = spawnSession, pulse: SessionPulse = () => {}, beatMs = REVIEW_BEAT_MS): Reviewer {
  return async (lease, plan, card = null) => {
    const session = randomUUID()
    const { tree, verdictPath, ...params } = reviewSession(trees.repo, trees.dir, session, lease, plan, process.env, card)
    mkdirSync(trees.dir, { recursive: true })
    trees.fetch(`pull/${lease.pr}/head`)
    const held: HeldTree = { path: tree, release: () => trees.release(tree) }
    try {
      trees.add(tree, lease.head!)
      const before = trees.state(tree)
      if (before.status.length > 0)
        throw new Error(`the review tree ${tree} is not clean before the review: ${before.status.join('; ')}`)
      const code = await beatingWhileGrowing(spawn(params), params.stdoutPath, () => pulse(lease, session), beatMs, error => console.error(missedBeatLine(session, error)))
      if (code !== 0)
        throw new Error(`the review session ${session} exited ${code}`)
      const review = reviewOf(readFileSync(verdictPath, 'utf8'), session)
      const after = trees.state(tree)
      const mutated = mutatedPaths(before, after)
      if (mutated.length > 0 && !transcriptExplainsMutation(params.stdoutPath))
        throw new Error(`the review tree ${tree} changed outside the review session ${session}, whose transcript has no command that writes: ${mutated.slice(0, 5).join(', ')}${mutated.length > 5 ? `, and ${mutated.length - 5} more` : ''}; a node fault, not a changes verdict`)
      const model = existsSync(params.stdoutPath) ? sessionModelOf(readFileSync(params.stdoutPath, 'utf8')) : undefined
      const cache = cacheTokensOf(readResultFields(params.stdoutPath).usage)
      return { ...review, ...withoutPassOnMutation(review, mutated), model, cache, tree: { ...held, before, after, mutated }, input: { prompt: params.prompt } }
    }
    catch (error) {
      if (!trees.holds(tree))
        throw error
      throw new ReviewFailed(error instanceof Error ? error.message : String(error), held)
    }
  }
}

const WRITING_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const WRITING_PROGRAM = /(?:^|[\s;&|(])(?:rm|mv|cp|touch|mkdir|rmdir|tee|truncate|chmod|ln|patch|git\s+(?:checkout|reset|clean|restore|stash|apply|commit|add|rm|mv|switch|merge|rebase|cherry-pick|pull)|sed\s+-i|(?:pnpm|npm|yarn)\s+(?:i|install|add|remove)|(?:construct|miko|mikoshi-construct)\s+mutate|(?:pnpm|npm|yarn)\s+(?:run\s+)?[\w:-]*(?:render|fix|format)|(?:node|tsx|python3?)\s+-[ec]|perl\s+-[pi]?i)\b|\s--(?:fix|write)\b/
const REDIRECTION_TO_A_FILE = /(?:^|[^=!<>-])[&\d]?>{1,2}\|?\s*(?![>&]|\/dev\/null(?:$|[\s;&|)]))\S/

export function commandMayWrite(command: string): boolean {
  return WRITING_PROGRAM.test(command) || REDIRECTION_TO_A_FILE.test(command)
}

function toolUsesOf(transcript: string): Array<{ name?: unknown, input?: { command?: unknown } }> {
  return transcript.split('\n').flatMap((line) => {
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
      return Array.isArray(content) ? content.filter(item => item?.type === 'tool_use') : []
    }
    catch {
      return []
    }
  })
}

function transcriptExplainsMutation(stdoutPath: string): boolean {
  if (!existsSync(stdoutPath))
    return false
  return toolUsesOf(readFileSync(stdoutPath, 'utf8')).some(use =>
    WRITING_TOOLS.includes(String(use.name)) || (use.name === 'Bash' && commandMayWrite(String(use.input?.command ?? ''))))
}

function withoutPassOnMutation(review: Review, mutated: string[]): Pick<Review, 'verdict' | 'findings'> {
  if (mutated.length === 0)
    return review
  return { verdict: 'changes', findings: [...review.findings, `the review session changed its tree, so its verdict does not count as pass: ${mutated.join(', ')}`] }
}
