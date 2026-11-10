import type { Lease } from '../../core/lease.js'
import type { MachineGate } from '../../core/machine-sessions.js'
import type { SessionReading } from '../../ports/client/contract.js'
import type { SessionInput } from '../../ports/prompt-store.js'
import type { SpawnSessionParams } from '../../ports/session.js'
import type { TreeOrigin } from '../../ports/worktree.js'
import type { VerdictWord } from './record-verdict.js'
import type { ReviewPlan } from './review-depth.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defaultBusPath, openBus } from '../../core/db.js'
import { RENEW_MS, renewLease, StaleLease } from '../../core/lease.js'
import { busNameOf, machineGate, machineSessions } from '../../core/machine-sessions.js'
import { processGit } from '../../ports/git.js'
import { prepareTree } from '../../ports/prepare-tree.js'
import { reviewModelOf, spawnSession, streamReading, withoutCard } from '../../ports/session.js'
import { FREE_TREE_CAPACITY, FREE_TREES, gitIn, parkTree, takeFreeTree } from '../../ports/worktree.js'
import { isAlive, joinReviewTree, leaveReviewTree, WORKER_LIMIT_VARIABLE } from '../../quality/lock.js'

export interface TreeState {
  head: string
  status: string[]
}

export interface HeldTree {
  path: string
  release: () => string | null
}

export interface ReviewedTree extends HeldTree {
  origin: TreeOrigin
  before: TreeState
  after: TreeState
  mutated: string[]
}

export interface Review {
  verdict: VerdictWord
  findings: string[]
  survivingMutations?: string[]
  advice?: string[]
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
  freeTrees?: number
}

export interface LeftoverTree {
  path: string
  left: string | null
}

export const PREFIX = '[bus:review] '

const VERDICTS = new Set<string>(['pass', 'changes'])

export const REVIEW_CEILING_MINUTES = 20

export const REVIEW_CEILING_MS = REVIEW_CEILING_MINUTES * 60_000

export const REVIEW_BEAT_MS = 60_000

export type SessionPulse = (lease: Lease, session: string) => void

export const HEAD_MOVED = 'HEAD'

export const PREPARED_TREE_LINE = 'The worker prepared this tree before the session: its dependencies are in place, so run the harness there as it is. Read and run; leave the tree as the worker left it, because the worker compares it before and after the review and a moved HEAD or a changed or new file git does not ignore makes the verdict changes.'

function optionalStrings(value: unknown, field: string, session: string): string[] | undefined {
  if (value !== undefined && !(Array.isArray(value) && value.every(finding => typeof finding === 'string')))
    throw new Error(`the review of session ${session} has a ${field} that is no list of strings`)
  return value as string[] | undefined
}

function verdictWithoutAdvice(verdict: VerdictWord, findings: readonly string[], advice: readonly string[] | undefined): VerdictWord {
  if (verdict !== 'changes' || advice === undefined || findings.length === 0)
    return verdict
  const marked = new Set(advice.map(entry => entry.trim()))
  return findings.every(finding => marked.has(finding.trim())) ? 'pass' : verdict
}

export function reviewOf(text: string, session: string): Review {
  const parsed = JSON.parse(text) as { verdict?: unknown, findings?: unknown, survivingMutations?: unknown, advice?: unknown }
  if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict))
    throw new Error(`the review of session ${session} names no verdict pass | changes`)
  if (!Array.isArray(parsed.findings) || !parsed.findings.every(finding => typeof finding === 'string'))
    throw new Error(`the review of session ${session} has no findings list of strings`)
  const findings = parsed.findings as string[]
  const marked = optionalStrings(parsed.survivingMutations, 'survivingMutations', session)
  const advice = optionalStrings(parsed.advice, 'advice', session)
  return {
    verdict: verdictWithoutAdvice(parsed.verdict as VerdictWord, findings, advice),
    findings,
    ...(marked === undefined ? {} : { survivingMutations: marked }),
    ...(advice === undefined ? {} : { advice }),
    session,
  }
}

const ONE_PASS = 'Walk every mutation over the changed lines and report every finding of this pass in one verdict, not in portions.'

const UNCHANGED_HEAD = 'The head is the one the earlier verdict read: the code has not changed since. Report no new finding against the code; check each earlier finding, and judge only what a changed card body or pull request description names.'

function reReviewLines(since: string, reviewed: string, head: string | null, findings: readonly string[]): string[] {
  return [
    ...(reviewed === head ? [UNCHANGED_HEAD] : []),
    `This is a re-review: check that each finding of the earlier verdict is closed, one still open stays a finding, and explore the diff ${since}..${head}.`,
    `${since} is the merge-base of main and the head, so that diff is the card's change alone; the earlier verdict read ${reviewed}, and a file that ${reviewed}..${head} shows only because the head merged main is not the card's change.`,
    `A new finding is allowed on the changed lines and on code the change affects: its callers, the modules that depend on it, its tests, and a regression outside the diff that the change causes. Do not re-read the whole pull request without a reason; a new finding on code the change neither touches nor affects, which the first pass already read, is not allowed.`,
    ...findings.map(finding => `Earlier finding: ${finding}`),
  ]
}

function firstDiffLines(since: string, head: string | null, touchFindings: readonly string[], touchNotes: readonly string[]): string[] {
  return [
    `Read only the diff ${since}..${head} against the card, its witnesses, its touches, its creates and its runs (the tests the card's Runs: line names); do not walk the modules it touches.`,
    ...touchFindings.map(finding => `Report as a finding of this review: ${finding}`),
    ...touchNotes.map(note => `Note in the report, not as a finding and no reason for changes; the pull request names it: ${note}`),
  ]
}

function depthLines(lease: Lease, plan: ReviewPlan): string[] {
  const depth = `Review depth ${plan.depth}: ${plan.why}.`
  if (plan.depth === 'diff' && plan.round === 'first')
    return [depth, ...firstDiffLines(plan.since, lease.head, plan.touchFindings, plan.touchNotes), ONE_PASS]
  if (plan.depth === 'diff')
    return [depth, ...reReviewLines(plan.since, plan.reviewed, lease.head, plan.findings), ONE_PASS]
  const ladder = plan.prediction?.verdict === 'ladder'
    ? [`MORSE predicts the ladder by rule ${plan.prediction.rule} (${plan.prediction.why.join(', ')}): cheap is the default path (D-224), so a card or pull request that names no D-76 reason is not a finding.`]
    : []
  return [depth, `Review the whole pull request and walk every module it touches.`, ...ladder, ONE_PASS]
}

const SURVIVING_MUTATIONS_LINE = 'survivingMutations is optional: list only the findings that are a surviving mutation with no behaviour defect. A finding outside it counts as a defect.'

export const ADVICE_LINE = 'Only a defect of code, tests or the contract makes the verdict changes. A finding only on the description of the pull request, the changeset or the prose of the card is advice: keep it in findings and repeat it exactly in advice; when every finding is advice the bus records the verdict as pass with the findings kept.'

export const REVIEW_BAR_LINE = 'A test or a generated file outside the touches is a note, not a finding, and no reason for changes; on a .claude, owner-merges, security or other R1 path it stays a finding, as does any other file outside the touches. A surviving mutation with no behaviour defect is a finding listed in survivingMutations: on a card of risk R3 or R4 the bus records that verdict as pass with the findings kept; on R1 and R2 it stays changes.'

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

function prBodyLines(prBody: string | null): string[] {
  if (prBody === null)
    return []
  return [
    'The pull request description, as GitHub held it when the review started, follows between the pull request markers; read it here, not from GitHub.',
    '<pull-request>',
    prBody.trimEnd(),
    '</pull-request>',
  ]
}

export function reviewPrompt(lease: Lease, plan: ReviewPlan, tree: string, verdictPath: string, card: string | null = null, prBody: string | null = null): string {
  return [
    `[review:${lease.taskKey}]`,
    `Act as the review role defined in .claude/agents/review.md. Pull request #${lease.pr} of card #${lease.cardId} is checked out at ${tree}, at its head ${lease.head}; read it there.`,
    PREPARED_TREE_LINE,
    ...cardLines(card),
    ...prBodyLines(prBody),
    ...depthLines(lease, plan),
    `Finish by writing ${verdictPath} as JSON: {"verdict": "pass" | "changes", "findings": ["one finding per string"], "survivingMutations": ["a finding string, repeated exactly"], "advice": ["a finding string, repeated exactly"]}.`,
    SURVIVING_MUTATIONS_LINE,
    REVIEW_BAR_LINE,
    ADVICE_LINE,
  ].join('\n')
}

function git(cwd: string, args: string[]): void {
  processGit.read(cwd, args)
}

function worktrees(repo: string): string[] {
  return processGit.read(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
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
  const read = (args: string[]): string => processGit.read(tree, args)
  return { head: read(['rev-parse', 'HEAD']).trim(), status: statusLines(read(['status', '--porcelain', '-z'])) }
}

export const GIT_TREE_TOOLS: TreeTools = { git, worktrees, prepare: prepareTree, state, freeTrees: FREE_TREE_CAPACITY }

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

  add(tree: string, head: string): TreeOrigin {
    const reused = this.reuses() && takeFreeTree(gitIn, this.repo, tree, taken => gitIn(taken, ['checkout', '-q', '-f', '--detach', head]))
    if (!reused)
      this.tools.git(this.repo, ['worktree', 'add', '--detach', tree, head])
    this.held.add(canonical(tree))
    this.tools.prepare(tree)
    return reused ? 'reused' : 'cut'
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
    if (this.parked(tree))
      return null
    return this.remove(tree) ?? this.prune()
  }

  clearLeftovers(): LeftoverTree[] {
    const inside = canonical(this.dir) + path.sep
    const free = canonical(path.join(this.dir, FREE_TREES)) + path.sep
    const leftovers = this.tools.worktrees(this.repo).filter(tree => canonical(tree).startsWith(inside) && !canonical(tree).startsWith(free) && !this.held.has(canonical(tree)))
    const cleared = leftovers.map(tree => ({ path: tree, left: this.remove(tree) }))
    this.tools.git(this.repo, ['worktree', 'prune'])
    return cleared
  }

  private reuses(): boolean {
    return (this.tools.freeTrees ?? 0) > 0
  }

  private parked(tree: string): boolean {
    if (!this.reuses())
      return false
    try {
      return parkTree(gitIn, this.repo, tree, this.tools.freeTrees!) !== null
    }
    catch {
      return false
    }
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

export function reviewSession(repo: string, dir: string, session: string, lease: Lease, plan: ReviewPlan, env: NodeJS.ProcessEnv = process.env, card: string | null = null, prBody: string | null = null): SpawnSessionParams & { tree: string, verdictPath: string } {
  const tree = path.join(dir, session)
  const verdictPath = path.join(dir, `${session}.verdict.json`)
  return {
    cwd: repo,
    addDirs: [dir],
    sessionId: session,
    prompt: reviewPrompt(lease, plan, tree, verdictPath, card, prBody),
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

export type PrBodyOf = (pr: number) => string | null

const NO_PR_BODY: PrBodyOf = () => null

export interface ReviewStart {
  gate: MachineGate
  keep: (lease: Lease) => boolean
  joinWorkers: (tree: string) => number
  leaveWorkers: (tree: string) => void
}

function renewedWhileHeld(busPath: string, now: () => number = Date.now): (lease: Lease) => boolean {
  const renewedAt = new Map<string, number>()
  return (lease) => {
    const at = now()
    const key = `${lease.taskKey}:${lease.leaseGen}`
    if (at - (renewedAt.get(key) ?? 0) < RENEW_MS)
      return true
    renewedAt.set(key, at)
    const db = openBus(busPath)
    try {
      renewLease(db, new Date(at).toISOString(), lease)
      return true
    }
    catch (error) {
      if (error instanceof StaleLease)
        return false
      throw error
    }
    finally {
      db.close()
    }
  }
}

export function realReviewStart(busPath: string = defaultBusPath()): ReviewStart {
  return { gate: machineGate(busNameOf(busPath), 'review', { machine: machineSessions(isAlive) }), keep: renewedWhileHeld(busPath), joinWorkers: joinReviewTree, leaveWorkers: leaveReviewTree }
}

export function claudeReviewer(trees: ReviewTrees, spawn: (params: SpawnSessionParams) => Promise<number> = spawnSession, pulse: SessionPulse = () => {}, beatMs = REVIEW_BEAT_MS, prBodyOf: PrBodyOf = NO_PR_BODY, start: ReviewStart = realReviewStart()): Reviewer {
  const review = reviewerOfTree(trees, spawn, pulse, beatMs, prBodyOf, start)
  return async (lease, plan, card = null) => {
    if (!await start.gate.start(lease.cardId, () => start.keep(lease)))
      throw new Error(`the review task ${lease.taskKey} was superseded or withdrawn while it waited for a session on this machine`)
    try {
      return await review(lease, plan, card)
    }
    finally {
      start.gate.release(lease.cardId)
    }
  }
}

function reviewerOfTree(trees: ReviewTrees, spawn: (params: SpawnSessionParams) => Promise<number>, pulse: SessionPulse, beatMs: number, prBodyOf: PrBodyOf, start: ReviewStart): Reviewer {
  return async (lease, plan, card = null) => {
    const session = randomUUID()
    const { tree, verdictPath, ...params } = reviewSession(trees.repo, trees.dir, session, lease, plan, process.env, card, lease.pr === null ? null : prBodyOf(lease.pr))
    mkdirSync(trees.dir, { recursive: true })
    trees.fetch(`pull/${lease.pr}/head`)
    const held: HeldTree = { path: tree, release: () => trees.release(tree) }
    const underTheBudget = async (): Promise<number> => {
      const workers = start.joinWorkers(tree)
      try {
        return await spawn({ ...params, env: { ...params.env, [WORKER_LIMIT_VARIABLE]: String(workers) } })
      }
      finally {
        start.leaveWorkers(tree)
      }
    }
    try {
      const origin = trees.add(tree, lease.head!)
      const before = trees.state(tree)
      if (before.status.length > 0)
        throw new Error(`the review tree ${tree} is not clean before the review: ${before.status.join('; ')}`)
      const code = await beatingWhileGrowing(underTheBudget(), params.stdoutPath, () => pulse(lease, session), beatMs, error => console.error(missedBeatLine(session, error)))
      if (code !== 0)
        throw new Error(`the review session ${session} exited ${code}`)
      const review = reviewOf(readFileSync(verdictPath, 'utf8'), session)
      const after = trees.state(tree)
      const mutated = mutatedPaths(before, after)
      const reading = streamReading(params.stdoutPath)
      if (mutated.length > 0 && !readingExplainsMutation(reading))
        throw new Error(`the review tree ${tree} changed outside the review session ${session}, whose transcript has no command that writes: ${mutated.slice(0, 5).join(', ')}${mutated.length > 5 ? `, and ${mutated.length - 5} more` : ''}; a node fault, not a changes verdict`)
      const model = reading.model ?? undefined
      const cache: CacheTokens = { cache_w: reading.usage?.cacheWrite ?? null, cache_r: reading.usage?.cached ?? null }
      return { ...review, ...withoutPassOnMutation(review, mutated), model, cache, tree: { ...held, origin, before, after, mutated }, input: { prompt: params.prompt } }
    }
    catch (error) {
      if (!trees.holds(tree))
        throw error
      throw new ReviewFailed(error instanceof Error ? error.message : String(error), held)
    }
  }
}

const WRITING_PROGRAM = /(?:^|[\s;&|(])(?:rm|mv|cp|touch|mkdir|rmdir|tee|truncate|chmod|ln|patch|git\s+(?:checkout|reset|clean|restore|stash|apply|commit|add|rm|mv|switch|merge|rebase|cherry-pick|pull)|sed\s+-i|(?:pnpm|npm|yarn)\s+(?:i|install|add|remove)|(?:construct|miko|mikoshi-construct)\s+mutate|(?:pnpm|npm|yarn)\s+(?:run\s+)?[\w:-]*(?:render|fix|format)|(?:node|tsx|python3?)\s+-[ec]|perl\s+-[pi]?i)\b|\s--(?:fix|write)\b/
const REDIRECTION_TO_A_FILE = /(?:^|[^=!<>-])[&\d]?>{1,2}\|?\s*(?![>&]|\/dev\/null(?:$|[\s;&|)]))\S/

export function commandMayWrite(command: string): boolean {
  return WRITING_PROGRAM.test(command) || REDIRECTION_TO_A_FILE.test(command)
}

function readingExplainsMutation(reading: SessionReading): boolean {
  return reading.toolUses.some(use => use.kind === 'write' || (use.kind === 'exec' && commandMayWrite(use.command ?? '')))
}

function withoutPassOnMutation(review: Review, mutated: string[]): Pick<Review, 'verdict' | 'findings'> {
  if (mutated.length === 0)
    return review
  return { verdict: 'changes', findings: [...review.findings, `the review session changed its tree, so its verdict does not count as pass: ${mutated.join(', ')}`] }
}
