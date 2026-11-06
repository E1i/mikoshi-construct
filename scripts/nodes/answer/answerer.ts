import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { ShiftGate } from '../../../src/manifest.js'
import type { BusEvent } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { MachineGate } from '../../core/machine-sessions.js'
import type { FailedJobLog } from '../../ports/ci-reading.js'
import type { Denial, Invocation, ProcessCwds, SessionTool, Usage } from '../../ports/client/contract.js'
import type { AnswerInput } from '../../ports/prompt-store.js'
import type { FreshBaseGap } from '../launch/tree-pr.js'
import type { AnswerSource, CardSession } from './answer-source.js'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readShiftGate } from '../../../src/manifest.js'
import { roundGate } from '../../ci/prepush.js'
import { appendEvent, defaultBusPath, openBus } from '../../core/db.js'
import { TOUCHES_FOLLOWED } from '../../core/events.js'
import { assertHeld, StaleLease } from '../../core/lease.js'
import { busNameOf, machineGate, machineSessions } from '../../core/machine-sessions.js'
import { treeReportPath } from '../../core/places.js'
import { pushPolicyOf } from '../../core/push-policy.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { ciLogForPrompt, GhCiRuns } from '../../ports/ci-reading.js'
import { hasClientTranscript } from '../../ports/client/claude/adapter.js'
import { CARD_VARIABLE, clientInvocation, sessionEnv, streamReading } from '../../ports/session.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { claudeProcessCwds } from '../../ports/worktree.js'
import { isAlive } from '../../quality/lock.js'
import { busSessionPulse } from '../../supervisor/heartbeat.js'
import { projectRoot, realExitReadings, sessionGauges, UNKNOWN } from '../../window/eddies-measure.js'
import { answerFollowed, commitAndPush, followedLine, freshBaseProblem, freshBaseTask, worktreeCoverage } from '../launch/tree-pr.js'

export const PREFIX = '[bus:answer] '
export const ANSWER_BEAT_MS = 60_000
export const DIFF_PROMPT_LIMIT = 100_000

export interface AnswerRequest {
  lease: Lease
  source: AnswerSource
  widened: string | null
  card: CardSession
  fresh?: boolean
  outsideTouches?: (paths: readonly string[]) => string[]
  stepped?: (steps: StepSeconds) => void
}

export interface Answered {
  session: string
  resumed: boolean
  atContextWarn?: boolean
  before: string | null
  after: string | null
  owner: string | null
  tokens?: number | null
  input?: AnswerInput
  steps?: StepSeconds
}

export function tokensOf(usage: Usage | null): number | null {
  if (usage === null)
    return null
  const counts = [usage.input, usage.output, usage.cacheWrite, usage.cached].filter(value => typeof value === 'number')
  return counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0)
}

export type Answerer = (request: AnswerRequest) => Promise<Answered>

export interface AnswerRun {
  cwd: string
  command: string
  argv: string[]
  stdoutPath: string
  stderrPath: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  onLine?: (line: string) => void
}

export type CardText = (cardId: number) => string | null

export interface AnswererTools {
  cardText: CardText
  cardTools?: (cardId: number, cardBody: string | null) => readonly SessionTool[]
  available: (card: CardSession) => boolean
  remoteHead: (card: CardSession) => string | null
  spawn: (run: AnswerRun) => Promise<number>
  newSession: () => string
  publish: (card: CardSession, commitMessage: string) => void
  pushPolicy?: (card: CardSession) => PushPolicy
  pulse?: AnswerPulse
  context?: (session: string) => number | null
  contextWarn?: () => number | null
  diff?: (card: CardSession) => string | null
  ciLog?: (card: CardSession, head: string) => FailedJobLog | null
  held?: (lease: Lease) => boolean
  pending?: (card: CardSession) => string[]
  coverage?: (card: CardSession) => ReturnType<typeof worktreeCoverage>
  followed?: (lease: Lease, paths: readonly string[]) => void
  localHead?: (card: CardSession) => string | null
  now?: () => number
  machine?: MachineGate
}

export type AnswerPulse = (lease: Lease, session: string) => void

export function missedAnswerBeatLine(session: string, error: unknown): string {
  return `${PREFIX}the heartbeat of answer session ${session} was not recorded, the answer goes on: ${error instanceof Error ? error.message : String(error)}`
}

async function beatingWhileRunning(run: () => Promise<number>, beat: () => void, beatMs: number): Promise<number> {
  beat()
  const ticker = setInterval(beat, beatMs)
  try {
    return await run()
  }
  finally {
    clearInterval(ticker)
  }
}

export class AnswerWithdrawn extends Error {
  constructor(lease: Lease, session: string) {
    super(`the answer task ${lease.taskKey} was superseded or withdrawn while its session ${session} ran; the session was stopped`)
  }
}

export function answerCommitMessage(lease: Lease): string {
  return `answer for #${lease.cardId}${lease.pr === null ? '' : ` on PR #${lease.pr}`}\n\nCommitted by the bus from the card's worktree after its answer session ended.`
}

export class AnswerOutsideTouches extends Error {
  constructor(lease: Lease, outside: readonly string[]) {
    super(`the answer for card #${lease.cardId} left changes to ${outside.join(', ')}, outside the touches and creates the card was admitted with and outside the tests, generated twins and changeset that follow them; the bus refused the answer commit and pushed nothing`)
  }
}

export function followedEvent(lease: Lease, paths: readonly string[], ts: string): BusEvent {
  return { ts, type: TOUCHES_FOLLOWED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${TOUCHES_FOLLOWED}:${lease.taskKey}:${lease.leaseGen}:${[...paths].sort().join(',')}`, payload: { paths: [...paths], reason: followedLine(paths) }, legacy: false }
}

function busTouchesFollowed(busPath: string): (lease: Lease, paths: readonly string[]) => void {
  return (lease, paths) => {
    const db = openBus(busPath)
    try {
      assertHeld(db, lease)
      appendEvent(db, followedEvent(lease, paths, new Date().toISOString()))
    }
    finally {
      db.close()
    }
  }
}

export class FreshBaseConflict extends Error {
  constructor(readonly gap: FreshBaseGap) {
    super(`merging a fresh origin/${MAIN_BRANCH} ${freshBaseProblem(gap)}`)
  }
}

function publishTree(card: CardSession, commitMessage: string): void {
  const pushed = commitAndPush((cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), card.worktree, card.branch, commitMessage)
  if (pushed.kind === 'conflict')
    throw new FreshBaseConflict(pushed)
}

function pushPolicyOfTree(card: CardSession): PushPolicy {
  return pushPolicyOf(git, card.worktree)
}

function freshBaseGapOf(publish: () => void): FreshBaseGap | null {
  try {
    publish()
    return null
  }
  catch (error) {
    if (error instanceof FreshBaseConflict)
      return error.gap
    throw error
  }
}

export function mergePrompt(lease: Lease, card: CardSession, gap: FreshBaseGap, ownerQuestion: string): string {
  return [
    `[answer:${lease.taskKey}]`,
    `The bus merges a fresh origin/${MAIN_BRANCH} into ${card.branch} before it pushes, and that merge ${freshBaseProblem(gap)}; nothing was pushed.`,
    `Your part: ${freshBaseTask(card.worktree, gap)}.`,
    `Then repeat the window gate of D-194 in ${card.worktree} and end the session; the bus merges again and pushes. If the merge cannot be settled without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
}

export function unmergedQuestion(card: CardSession, gap: FreshBaseGap): string {
  return `merging a fresh origin/${MAIN_BRANCH} into ${card.branch} ${freshBaseProblem(gap)} and the answer session did not resolve it`
}

export const MERGE_STEP = '.merge'

function measuredOf(stdoutPaths: readonly string[]): { tokens?: number | null } {
  const results = stdoutPaths.map(streamReading).filter(result => result.end !== 'missing')
  if (results.length === 0)
    return {}
  const counts = results.map(result => tokensOf(result.usage)).filter((count): count is number => count !== null)
  return { tokens: counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0) }
}

function ciLogLines(ciLog: FailedJobLog | null | undefined): string[] {
  if (ciLog === undefined)
    return ['Read their logs (gh pr checks, gh run view --log-failed) and fix every one.']
  if (ciLog === null)
    return ['The bus could not read the failed-job log; fix every failed check from what the tree shows.']
  return ['The failures and the tail of the failed-job log the bus read:', ciLogForPrompt(ciLog), 'Fix every failure it shows.']
}

function redCiLines(failedChecks: string[], ciLog: FailedJobLog | null | undefined): string[] {
  return [
    failedChecks.length === 0 ? 'CI is red on this head and the bus recorded no failed check by name.' : `CI is red on this head. The failed checks: ${failedChecks.join(', ')}.`,
    ...ciLogLines(ciLog),
  ]
}

function asksAboutRedCi(source: AnswerSource): boolean {
  return source.kind === 'ci' || (source.kind === 'changes' && source.failedChecks !== undefined)
}

function sourceLines(source: AnswerSource, ciLog?: FailedJobLog | null): string[] {
  if (source.kind === 'changes') {
    return [
      source.findings.length === 0 ? 'The review asked for changes and recorded no findings on the bus; read the review on the pull request.' : 'The review asked for changes. Its findings:',
      ...source.findings.map(finding => `- ${finding}`),
      'Address every finding.',
      ...(source.failedChecks === undefined ? [] : redCiLines(source.failedChecks, ciLog)),
    ]
  }
  if (source.kind === 'ci')
    return redCiLines(source.failedChecks, ciLog)
  return [`The card stopped with a question for the agent: ${source.detail}`, 'Answer it as the Operator role would and continue the card.']
}

export function ownerQuestionPath(dir: string, session: string, leaseGen: number): string {
  return path.join(dir, `${session}.${leaseGen}.owner.txt`)
}

function ownerQuestionIn(file: string): string | null {
  if (!existsSync(file))
    return null
  const reason = readFileSync(file, 'utf8').trim()
  return reason === '' ? null : reason
}

function denialAimsAt(denial: Denial, file: string): boolean {
  return denial.path === file || denial.command?.includes(file) === true
}

export function refusedOwnerQuestionIn(stdoutPath: string, file: string): string | null {
  const refused = streamReading(stdoutPath).denials.find(denial => denialAimsAt(denial, file))
  return refused === undefined || refused.text === '' ? null : refused.text
}

function cardLines(cardId: number, cardText: string | null): string[] {
  if (cardText === null)
    return [`Card #${cardId} has no admitted body in the bus; read the card from the pull request.`]
  return [`The card as the bus holds it now, witnesses admitted after the verdict included:`, cardText.trim()]
}

function decisionLines(decisions: readonly string[]): string[] {
  return decisions.length === 0 ? [] : ['Owner decisions in force for this card. They are the owner\'s answer: follow them, and do not ask the owner again what they settle.', ...decisions]
}

function diffLines(card: CardSession, diff: string | null | undefined): string[] {
  if (diff === undefined)
    return []
  if (diff === null)
    return [`The diff of the tree against ${MAIN_BRANCH} could not be read; read it with git diff in ${card.worktree}.`]
  if (diff.length > DIFF_PROMPT_LIMIT)
    return [`The diff of the tree against ${MAIN_BRANCH}, cut at ${DIFF_PROMPT_LIMIT} characters; read the rest with git diff in ${card.worktree}:`, diff.slice(0, DIFF_PROMPT_LIMIT)]
  return [`The diff of the tree against ${MAIN_BRANCH}:`, diff]
}

function gateLine(gate: ShiftGate): string {
  return gate.prepush.length === 0 ? `the card's witnesses` : `the card's witnesses and the pre-push checks this repository declares, ${gate.prepush.join(', ')}`
}

export function answerPrompt(request: AnswerRequest, ownerQuestion: string, cardText: string | null, gate: ShiftGate, diff?: string | null, ciLog?: FailedJobLog | null): string {
  const { lease, source, widened, card } = request
  return [
    `[answer:${lease.taskKey}]`,
    `Card #${lease.cardId}${lease.pr === null ? '' : `, pull request #${lease.pr} at ${lease.head}`}, in its tree ${card.worktree} on ${card.branch}.`,
    ...cardLines(lease.cardId, cardText),
    ...decisionLines(source.decisions),
    ...sourceLines(source, ciLog),
    ...diffLines(card, diff),
    ...(widened === null ? [] : [`The touches are widened: ${widened}.`]),
    `The card's latest events, oldest first:`,
    ...source.events.map(event => JSON.stringify(event)),
    `Run the window gate of D-194 in ${card.worktree}, each as its own command: ${gateLine(gate)}. A session that leaves a clean tree and no unpushed commit runs none of them. A heavy step waits for its turn in the foreground, so give it a Bash timeout of 600000. End the session when they are green. A red pre-push run is fixed in this session; a broken one prints its finding and question, and that question goes to the owner as below. Do not commit and do not push: once the session ends the bus commits the tree and pushes it to ${card.branch}. A refused git command is not a question. If the card cannot go on without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
}

export function answerHandoffPath(worktree: string): string {
  return path.join(path.dirname(treeReportPath(worktree)), 'answer-handoff.md')
}

function handoffLines(handoff: string, fresh: boolean): string[] {
  const stop = `On the context warn (the Eddies warn on the session's context): finish the step you are in, write what is done and what is not to ${handoff}, leave the tree as it is and end the session; the bus pushes nothing and continues in a fresh session from that handoff and the tree.`
  const left = fresh && existsSync(handoff) ? readFileSync(handoff, 'utf8').trim() : ''
  return left === '' ? [stop] : ['The session before this one stopped at the context warn and left this handoff; continue from it:', left, stop]
}

function localHead(card: CardSession): string | null {
  try {
    return git(card.worktree, ['rev-parse', 'HEAD']).trim() || null
  }
  catch {
    return null
  }
}

export function roundGateOf(gate: ShiftGate, head: string | null): ShiftGate {
  return head === null ? gate : { ...gate, prepush: roundGate(gate.prepush, head) }
}

function remoteHead(card: CardSession): string | null {
  try {
    const line = execFileSync('git', ['-C', card.worktree, 'ls-remote', 'origin', `refs/heads/${card.branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return line.split(/\s/)[0] || null
  }
  catch {
    return null
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function diffAgainstBase(card: CardSession): string | null {
  try {
    const base = git(card.worktree, ['merge-base', `origin/${MAIN_BRANCH}`, 'HEAD']).trim()
    return git(card.worktree, ['diff', base])
  }
  catch {
    return null
  }
}

export type TreeMerge = { kind: 'none' } | { kind: 'mid-merge', files: string[] } | { kind: 'unreadable', why: string }

export function treeMergeOf(card: CardSession): TreeMerge {
  try {
    const mergeHead = path.resolve(card.worktree, git(card.worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim())
    const unmerged = git(card.worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
    return existsSync(mergeHead) || unmerged.length > 0 ? { kind: 'mid-merge', files: unmerged } : { kind: 'none' }
  }
  catch (error) {
    return { kind: 'unreadable', why: error instanceof Error ? error.message.trim() : String(error) }
  }
}

interface PendingPath {
  file: string
  untracked: boolean
}

const UNTRACKED = '??'

function porcelainEntries(output: string): PendingPath[] {
  const entries = output.split('\0').filter(each => each !== '')
  const pending: PendingPath[] = []
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]!
    pending.push({ file: entry.slice(3), untracked: entry.startsWith(UNTRACKED) })
    if (entry.startsWith('R') || entry.startsWith('C'))
      at += 1
  }
  return pending
}

function committedOnTheBranch(card: CardSession): string[] {
  const base = git(card.worktree, ['merge-base', `origin/${MAIN_BRANCH}`, 'HEAD']).trim()
  return git(card.worktree, ['diff', '--name-only', '-z', base, 'HEAD']).split('\0').filter(file => file !== '')
}

function uncommitted(card: CardSession): string[] {
  const changed = porcelainEntries(git(card.worktree, ['status', '--porcelain', '-z', '--untracked-files=all']))
  if (treeMergeOf(card).kind !== 'mid-merge')
    return changed.map(each => each.file)
  const differFromTheMergedBranch = new Set(git(card.worktree, ['diff', '--name-only', '-z', 'MERGE_HEAD']).split('\0'))
  return changed.filter(each => each.untracked || differFromTheMergedBranch.has(each.file)).map(each => each.file)
}

export function pendingPathsOf(card: CardSession): string[] {
  return [...new Set([...committedOnTheBranch(card), ...uncommitted(card)])]
}

export function liveSessionIn(card: CardSession, cwds: () => ProcessCwds = claudeProcessCwds): string | null {
  const read = cwds()
  if (read.kind === 'unreadable')
    return `the sessions running in the tree ${card.worktree} cannot be read (${read.why}), so the card counts as held`
  const tree = existsSync(card.worktree) ? realpathSync(card.worktree) : card.worktree
  const inside = read.cwds.find(cwd => cwd === tree || cwd.startsWith(`${tree}${path.sep}`))
  return inside === undefined ? null : `a live session runs in ${inside}, inside the tree ${card.worktree}`
}

export function treeDirtyOf(card: CardSession): boolean {
  try {
    return git(card.worktree, ['status', '--porcelain']).trim() !== ''
  }
  catch {
    return false
  }
}

export function contextWarnOfEddies(): number | null {
  const warn = realExitReadings({ [CARD_VARIABLE]: 'answer' }, os.homedir(), projectRoot(process.env), defaultBusPath()).contextWarn
  return warn === UNKNOWN ? null : warn
}

function spawnClient(run: AnswerRun): Promise<number> {
  const outFd = openSync(run.stdoutPath, 'w')
  const errFd = openSync(run.stderrPath, 'w')
  let closed = false
  let partial = ''
  const closeOnce = (): void => {
    if (!closed) {
      closed = true
      if (partial !== '')
        run.onLine?.(partial)
      closeSync(outFd)
      closeSync(errFd)
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(run.command, run.argv, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', errFd], signal: run.signal })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      writeSync(outFd, chunk)
      const lines = `${partial}${chunk}`.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines)
        run.onLine?.(line)
    })
    child.on('error', (error) => {
      closeOnce()
      reject(error)
    })
    child.on('close', (code) => {
      closeOnce()
      resolve(code ?? 1)
    })
  })
}

export interface StepSeconds {
  lease?: number
  tree?: number
  spawn: number | null
  first_turn: number | null
  gate: number | null
  push: number | null
}

const MS_PER_TENTH = 100

export function secondsOf(ms: number): number {
  return Math.round(ms / MS_PER_TENTH) / 10
}

interface StreamBlock { type?: unknown, id?: unknown, name?: unknown, input?: { command?: unknown }, tool_use_id?: unknown }

function blocksOf(line: string): { type: unknown, blocks: StreamBlock[] } | null {
  try {
    const parsed = JSON.parse(line) as { type?: unknown, message?: { content?: unknown } } | null
    if (parsed === null || typeof parsed !== 'object')
      return null
    const content = parsed.message?.content
    return { type: parsed.type, blocks: Array.isArray(content) ? content.filter((block): block is StreamBlock => block !== null && typeof block === 'object') : [] }
  }
  catch {
    return null
  }
}

const PNPM_IN_A_TREE = /^pnpm (?:--dir \S+ )?(?:run )?/

function inAnyTree(command: string): string {
  return command.trim().replace(PNPM_IN_A_TREE, 'pnpm ')
}

export class RoundTimer {
  private spawned: number | null = null
  private firstLine: number | null = null
  private firstTurn: number | null = null
  private gateMs: number | null = null
  private pushMs: number | null = null
  private readonly running = new Map<string, number>()

  constructor(private readonly now: () => number, private readonly gate: readonly string[]) {}

  spawning(): void {
    this.spawned ??= this.now()
  }

  line(text: string): void {
    const at = this.now()
    const read = blocksOf(text)
    if (read === null)
      return
    this.firstLine ??= at
    if (read.type === 'assistant') {
      this.firstTurn ??= at
      for (const block of read.blocks.filter(each => each.type === 'tool_use' && typeof each.id === 'string' && this.runsTheGate(each.input?.command)))
        this.running.set(block.id as string, at)
    }
    for (const block of read.blocks.filter(each => each.type === 'tool_result' && typeof each.tool_use_id === 'string')) {
      const started = this.running.get(block.tool_use_id as string)
      if (started !== undefined) {
        this.running.delete(block.tool_use_id as string)
        this.gateMs = (this.gateMs ?? 0) + at - started
      }
    }
  }

  pushing<T>(push: () => T): T {
    const started = this.now()
    try {
      return push()
    }
    finally {
      this.pushMs = (this.pushMs ?? 0) + this.now() - started
    }
  }

  steps(): StepSeconds {
    const between = (from: number | null, to: number | null): number | null => from === null || to === null ? null : secondsOf(to - from)
    return {
      spawn: between(this.spawned, this.firstLine),
      first_turn: between(this.firstLine, this.firstTurn),
      gate: this.gateMs === null ? null : secondsOf(this.gateMs),
      push: this.pushMs === null ? null : secondsOf(this.pushMs),
    }
  }

  private runsTheGate(command: unknown): boolean {
    return typeof command === 'string' && this.gate.some(each => inAnyTree(command).startsWith(inAnyTree(each)))
  }
}

export class CardTreeGone extends Error {
  constructor(card: CardSession) {
    super(`the card tree ${card.worktree} is gone`)
  }
}

function busLeaseHeld(busPath: string): (lease: Lease) => boolean {
  return (lease) => {
    const db = openBus(busPath)
    try {
      assertHeld(db, lease)
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

export function realAnswererTools(busPath: string = defaultBusPath()): AnswererTools {
  return {
    machine: machineGate(busNameOf(busPath), 'answer', { machine: machineSessions(isAlive) }),
    held: busLeaseHeld(busPath),
    pulse: busSessionPulse(busPath, () => new Date()),
    cardText: busCardBodies(busPath),
    available: card => hasClientTranscript(process.env, card.worktree, card.session),
    remoteHead,
    localHead,
    spawn: spawnClient,
    newSession: randomUUID,
    publish: publishTree,
    pushPolicy: pushPolicyOfTree,
    pending: pendingPathsOf,
    coverage: card => worktreeCoverage(git, card.worktree),
    followed: busTouchesFollowed(busPath),
    context: session => sessionGauges(os.homedir(), projectRoot(process.env), session).context ?? null,
    contextWarn: contextWarnOfEddies,
    diff: diffAgainstBase,
    ciLog: (card, head) => new GhCiRuns().failedJobLog(head, card.worktree),
  }
}

function atContextWarn(tools: AnswererTools, session: string): boolean {
  const warn = tools.contextWarn?.() ?? null
  const context = warn === null ? null : tools.context?.(session) ?? null
  return warn !== null && context !== null && context >= warn
}

export function claudeAnswerer(dir: string, tools: AnswererTools): Answerer {
  const answer = sessionAnswerer(dir, tools)
  return async (request) => {
    const { card, lease } = request
    if (!existsSync(card.worktree))
      throw new CardTreeGone(card)
    if (tools.machine === undefined)
      return answer(request)
    if (!await tools.machine.start(lease.cardId, () => tools.held?.(lease) !== false))
      throw new AnswerWithdrawn(lease, card.session)
    try {
      return await answer(request)
    }
    finally {
      tools.machine.release(lease.cardId)
    }
  }
}

function sessionAnswerer(dir: string, tools: AnswererTools): Answerer {
  return async (request) => {
    const { card } = request
    const resumed = request.fresh !== true && tools.available(card) && !atContextWarn(tools, card.session)
    const session = resumed ? card.session : tools.newSession()
    const ownerQuestion = ownerQuestionPath(dir, session, request.lease.leaseGen)
    const cardBody = tools.cardText(request.lease.cardId)
    const gate = roundGateOf(readShiftGate(card.worktree), tools.localHead?.(card) ?? null)
    const timer = new RoundTimer(tools.now ?? Date.now, gate.prepush)
    const ciLog = asksAboutRedCi(request.source) && request.lease.head !== null ? tools.ciLog?.(card, request.lease.head) : undefined
    const handoff = answerHandoffPath(card.worktree)
    if (request.fresh !== true)
      rmSync(handoff, { force: true })
    const prompt = [answerPrompt(request, ownerQuestion, cardBody, gate, resumed ? undefined : tools.diff?.(card), ciLog), ...handoffLines(handoff, request.fresh === true)].join('\n')
    const invocationOf = (kind: 'start' | 'resume', text: string): Invocation => clientInvocation({ kind, role: 'answer', session, cwd: card.worktree, prompt: text, addDirs: [dir], pick: { model: null }, policy: { profile: 'sandboxed', gateCommands: gate.prepush, writePaths: [ownerQuestion], mcpOff: true, tools: tools.cardTools?.(request.lease.cardId, cardBody) } })
    mkdirSync(dir, { recursive: true })
    rmSync(ownerQuestion, { force: true })
    const before = tools.remoteHead(card)
    const stdoutOf = (step: string): string => path.join(dir, `${session}.${request.lease.leaseGen}${step}.out.jsonl`)
    const withdrawn = new AbortController()
    const beat = (): void => {
      try {
        if (tools.held?.(request.lease) === false) {
          withdrawn.abort()
          return
        }
        tools.pulse?.(request.lease, session)
      }
      catch (error) {
        console.error(missedAnswerBeatLine(session, error))
      }
    }
    const spawnUnlessWithdrawn = async (invocation: Invocation, step: string): Promise<number> => {
      if (withdrawn.signal.aborted)
        return 1
      timer.spawning()
      try {
        return await tools.spawn({
          cwd: card.worktree,
          command: invocation.command,
          argv: invocation.args,
          stdoutPath: stdoutOf(step),
          stderrPath: path.join(dir, `${session}.${request.lease.leaseGen}${step}.err.log`),
          env: { ...sessionEnv(process.env, request.lease.cardId), ...invocation.env },
          signal: withdrawn.signal,
          onLine: line => timer.line(line),
        })
      }
      catch (error) {
        if (withdrawn.signal.aborted)
          return 1
        throw error
      }
    }
    const run = async (invocation: Invocation, step: string): Promise<number> => {
      const code = await beatingWhileRunning(async () => spawnUnlessWithdrawn(invocation, step), beat, ANSWER_BEAT_MS)
      if (withdrawn.signal.aborted)
        throw new AnswerWithdrawn(request.lease, session)
      return code
    }
    const steps = ['']
    const ownerAfter = (step: string): string | null => ownerQuestionIn(ownerQuestion) ?? refusedOwnerQuestionIn(stdoutOf(step), ownerQuestion)
    const followedOrRefused = (): string[] => {
      const outside = request.outsideTouches?.(tools.pending?.(card) ?? []) ?? []
      if (outside.length === 0)
        return []
      const touched = answerFollowed(git, card.worktree, outside, request.lease.cardId, cardBody, (tools.coverage ?? (tree => worktreeCoverage(git, tree.worktree)))(card))
      if (touched.outside.length > 0)
        throw new AnswerOutsideTouches(request.lease, touched.outside)
      return touched.followed
    }
    const pushTree = (): FreshBaseGap | null => {
      const followed = followedOrRefused()
      const gap = timer.pushing(() => freshBaseGapOf(() => tools.publish(card, answerCommitMessage(request.lease))))
      if (gap === null && followed.length > 0)
        tools.followed?.(request.lease, followed)
      return gap
    }
    const publish = async (): Promise<string | null> => {
      const gap = pushTree()
      if (gap === null)
        return null
      steps.push(MERGE_STEP)
      const merged = await run(invocationOf('resume', mergePrompt(request.lease, card, gap, ownerQuestion)), MERGE_STEP)
      const owner = ownerAfter(MERGE_STEP)
      if (owner !== null)
        return owner
      const left = merged === 0 ? pushTree() : gap
      return left === null ? null : unmergedQuestion(card, left)
    }
    try {
      const code = await run(invocationOf(resumed ? 'resume' : 'start', prompt), '')
      if (code !== 0)
        throw new Error(`the answer session ${session} exited ${code}`)
      const kept = tools.pushPolicy?.(card) === 'none'
      const atLine = atContextWarn(tools, session)
      const owner = ownerAfter('') ?? (kept || atLine ? null : await publish())
      const measured = measuredOf(steps.map(stdoutOf))
      return { session, resumed, atContextWarn: atLine, before, after: tools.remoteHead(card), owner, ...measured, input: { prompt, cardBody }, steps: timer.steps() }
    }
    finally {
      request.stepped?.(timer.steps())
    }
  }
}
