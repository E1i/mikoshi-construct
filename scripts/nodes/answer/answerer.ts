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
import type { CardConcept, Importers } from './concept-scope.js'
import type { AnswerRun } from './duties/index.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readShiftGate } from '../../../src/manifest.js'
import { roundGate } from '../../ci/prepush.js'
import { appendEvent, defaultBusPath, openBus } from '../../core/db.js'
import { TOUCHES_FOLLOWED } from '../../core/events.js'
import { assertHeld, StaleLease } from '../../core/lease.js'
import { busNameOf, machineGate, machineSessions } from '../../core/machine-sessions.js'
import { machineOverloadedLine, timeoutUnderLoadOutside } from '../../core/observations.js'
import { treeReportPath } from '../../core/places.js'
import { pushPolicyOf } from '../../core/push-policy.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { GhCiRuns } from '../../ports/ci-reading.js'
import { hasClientTranscript } from '../../ports/client/claude/adapter.js'
import { processGit } from '../../ports/git.js'
import { OsProcessTable } from '../../ports/process-table.js'
import { CARD_SIZE_VARIABLE, CARD_VARIABLE, cardSessionOverlay, cardSizeIn, clientInvocation, sessionEnv, streamReading } from '../../ports/session.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { isAlive } from '../../quality/lock.js'
import { busSessionPulse } from '../../supervisor/heartbeat.js'
import { projectRoot, realExitReadings, sessionGauges, UNKNOWN } from '../../window/eddies-measure.js'
import { answerFollowed, commitAndPush, CONCEPT_RULES, followedLine, freshBaseProblem, freshBaseTask, worktreeCoverage, worktreeImporters } from '../launch/tree-pr.js'
import { conceptWidening } from './concept-scope.js'
import { answerPrompt, asksAboutRedCi, diffAgainstBase, gateLine, git, handoffLines, localHead, mergePrompt, pendingPathsOf, remoteHead, spawnClient } from './duties/index.js'

export const PREFIX = '[bus:answer] '
export const ANSWER_BEAT_MS = 60_000

export interface AnswerRequest {
  lease: Lease
  source: AnswerSource
  widened: string | null
  card: CardSession
  fresh?: boolean
  outsideTouches?: (paths: readonly string[]) => string[]
  concept?: CardConcept | null
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
  widenedInConcept?: string[]
  noViolationFreePath?: boolean
}

export function tokensOf(usage: Usage | null): number | null {
  if (usage === null)
    return null
  const counts = [usage.input, usage.output, usage.cacheWrite, usage.cached].filter(value => typeof value === 'number')
  return counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0)
}

export type Answerer = (request: AnswerRequest) => Promise<Answered>

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
  contextWarn?: (size: string | null) => number | null
  diff?: (card: CardSession) => string | null
  ciLog?: (card: CardSession, head: string) => FailedJobLog | null
  held?: (lease: Lease) => boolean
  pending?: (card: CardSession) => string[]
  coverage?: (card: CardSession) => ReturnType<typeof worktreeCoverage>
  importers?: (card: CardSession) => Importers
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
  const pushed = commitAndPush((cwd, args) => processGit.read(cwd, args), card.worktree, card.branch, commitMessage)
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

export function unmergedQuestion(card: CardSession, gap: FreshBaseGap): string {
  return `merging a fresh origin/${MAIN_BRANCH} into ${card.branch} ${freshBaseProblem(gap)} and the answer session did not resolve it`
}

export const MERGE_STEP = '.merge'
const VIOLATION_STEP = '.violation'
export const KNOWN_VIOLATIONS = '.dependency-cruiser-known-violations.json'

function onlyAGrownViolationBaseline(outside: readonly string[]): boolean {
  return outside.length === 1 && outside[0] === KNOWN_VIOLATIONS
}

function grownBaselineLine(cardId: number): string {
  return `card #${cardId}: the answer grew ${KNOWN_VIOLATIONS}, its only change outside the touches; the bus dropped that change and sent the answer back to find a path without the new dependency violation (owner s591, Q269)`
}

function violationPrompt(lease: Lease, card: CardSession, ownerQuestion: string): string {
  return [
    `[answer:${lease.taskKey}]`,
    `Your answer added an entry to ${KNOWN_VIOLATIONS}: a new dependency violation, and that file is outside the touches of card #${lease.cardId}. The bus dropped that change in ${card.worktree} and pushed nothing.`,
    `Your part: find a path without the violation — move the code, invert the import, or reach the dependency through a module the policy allows — and leave ${KNOWN_VIOLATIONS} as it is.`,
    `Then repeat the window gate of D-194 in ${card.worktree} and end the session; the bus pushes. Only if no path without the violation exists, write that for the owner, one line naming the import that cannot be avoided, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
}

function measuredOf(stdoutPaths: readonly string[]): { tokens?: number | null } {
  const results = stdoutPaths.map(streamReading).filter(result => result.end !== 'missing')
  if (results.length === 0)
    return {}
  const counts = results.map(result => tokensOf(result.usage)).filter((count): count is number => count !== null)
  return { tokens: counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0) }
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
  const refused = streamReading(stdoutPath).denials?.find(denial => denialAimsAt(denial, file))
  return refused === undefined || refused.text === '' ? null : refused.text
}

export function windowGateRule(card: CardSession, gate: ShiftGate, ownerQuestion: string): string {
  return `Run the window gate of D-194 in ${card.worktree}, each as its own command: ${gateLine(gate)}. A session that leaves a clean tree and no unpushed commit runs none of them. A heavy step waits for its turn in the foreground, so give it a Bash timeout of 600000. End the session when they are green. A red pre-push run is fixed in this session; a broken one prints its finding and question, and that question goes to the owner as below. Do not commit and do not push: once the session ends the bus commits the tree and pushes it to ${card.branch}. A refused git command is not a question. If the card cannot go on without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`
}

export function answerHandoffPath(worktree: string): string {
  return path.join(path.dirname(treeReportPath(worktree)), 'answer-handoff.md')
}

export function roundGateOf(gate: ShiftGate, head: string | null): ShiftGate {
  return head === null ? gate : { ...gate, prepush: roundGate(gate.prepush, head) }
}

export function liveSessionIn(card: CardSession, cwds: () => ProcessCwds = () => new OsProcessTable().clientCwds()): string | null {
  const read = cwds()
  if (read.kind === 'unreadable')
    return `the sessions running in the tree ${card.worktree} cannot be read (${read.why}), so the card counts as held`
  const tree = existsSync(card.worktree) ? realpathSync(card.worktree) : card.worktree
  const inside = read.cwds.find(cwd => cwd === tree || cwd.startsWith(`${tree}${path.sep}`))
  return inside === undefined ? null : `a live session runs in ${inside}, inside the tree ${card.worktree}`
}

export function contextWarnOfEddies(size: string | null = null): number | null {
  const warn = realExitReadings({ [CARD_VARIABLE]: 'answer', ...(size === null ? {} : { [CARD_SIZE_VARIABLE]: size }) }, os.homedir(), projectRoot(process.env), defaultBusPath()).contextWarn
  return warn === UNKNOWN ? null : warn
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
    ciLog: (card, head) => new GhCiRuns().failureLogOn(head, card.worktree),
  }
}

function atContextWarn(tools: AnswererTools, session: string, size: string | null): boolean {
  const warn = tools.contextWarn?.(size) ?? null
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

function askedUnlessRetried(request: AnswerRequest, asked: string | null): string | null {
  if (asked === null || request.outsideTouches === undefined || !timeoutUnderLoadOutside(asked, request.outsideTouches))
    return asked
  console.log(`${PREFIX}${machineOverloadedLine(request.lease.cardId, asked)}`)
  return null
}

function sessionAnswerer(dir: string, tools: AnswererTools): Answerer {
  return async (request) => {
    const { card } = request
    const cardBody = tools.cardText(request.lease.cardId)
    const size = cardSizeIn(cardBody)
    const resumed = request.fresh !== true && tools.available(card) && !atContextWarn(tools, card.session, size)
    const session = resumed ? card.session : tools.newSession()
    const ownerQuestion = ownerQuestionPath(dir, session, request.lease.leaseGen)
    const gate = roundGateOf(readShiftGate(card.worktree), tools.localHead?.(card) ?? null)
    const timer = new RoundTimer(tools.now ?? Date.now, gate.prepush)
    const ciLog = asksAboutRedCi(request.source) && request.lease.head !== null ? tools.ciLog?.(card, request.lease.head) : undefined
    const handoff = answerHandoffPath(card.worktree)
    if (request.fresh !== true)
      rmSync(handoff, { force: true })
    const prompt = [answerPrompt(request, cardBody, windowGateRule(card, gate, ownerQuestion), resumed ? undefined : tools.diff?.(card), ciLog), ...handoffLines(handoff, request.fresh === true)].join('\n')
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
          env: { ...sessionEnv(process.env, request.lease.cardId, cardSessionOverlay(projectRoot(process.env), process.env, size)), ...invocation.env },
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
    const widenedInConcept = new Set<string>()
    let noViolationFreePath = false
    const scopeOfTheTree = (): { followed: string[], widened: string[], outside: string[] } => {
      const outside = request.outsideTouches?.(tools.pending?.(card) ?? []) ?? []
      if (outside.length === 0)
        return { followed: [], widened: [], outside: [] }
      const touched = answerFollowed(git, card.worktree, outside, request.lease.cardId, cardBody, (tools.coverage ?? (tree => worktreeCoverage(git, tree.worktree)))(card))
      const concept = request.concept
      const within = concept === undefined || concept === null
        ? { widened: [], outside: touched.outside }
        : conceptWidening(touched.outside, concept, CONCEPT_RULES, () => (tools.importers ?? (tree => worktreeImporters(git, tree.worktree)))(card))
      return { followed: touched.followed, widened: within.widened, outside: within.outside }
    }
    const followedOrRefused = (): { followed: string[], widened: string[] } => {
      const { followed, widened, outside } = scopeOfTheTree()
      if (outside.length > 0)
        throw new AnswerOutsideTouches(request.lease, outside)
      return { followed, widened }
    }
    const withoutTheNewViolation = async (): Promise<string | null> => {
      if (!onlyAGrownViolationBaseline(scopeOfTheTree().outside))
        return null
      git(card.worktree, ['checkout', 'HEAD', '--', KNOWN_VIOLATIONS])
      console.log(`${PREFIX}${grownBaselineLine(request.lease.cardId)}`)
      steps.push(VIOLATION_STEP)
      const code = await run(invocationOf('resume', violationPrompt(request.lease, card, ownerQuestion)), VIOLATION_STEP)
      const owner = ownerAfter(VIOLATION_STEP)
      noViolationFreePath = owner !== null
      if (owner !== null)
        return owner
      if (code !== 0)
        throw new Error(`the answer session ${session} exited ${code} looking for a path without the new dependency violation`)
      return null
    }
    const pushTree = (): FreshBaseGap | null => {
      const { followed, widened } = followedOrRefused()
      const gap = timer.pushing(() => freshBaseGapOf(() => tools.publish(card, answerCommitMessage(request.lease))))
      if (gap === null && followed.length > 0)
        tools.followed?.(request.lease, followed)
      if (gap === null)
        widened.forEach(file => widenedInConcept.add(file))
      return gap
    }
    const publish = async (): Promise<string | null> => {
      const noPath = await withoutTheNewViolation()
      if (noPath !== null)
        return noPath
      const gap = pushTree()
      if (gap === null)
        return null
      steps.push(MERGE_STEP)
      const merged = await run(invocationOf('resume', mergePrompt(request.lease, card, { problem: freshBaseProblem(gap), task: freshBaseTask(card.worktree, gap) }, ownerQuestion)), MERGE_STEP)
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
      const atLine = atContextWarn(tools, session, size)
      const owner = askedUnlessRetried(request, ownerAfter('')) ?? (kept || atLine ? null : await publish())
      const measured = measuredOf(steps.map(stdoutOf))
      return { session, resumed, atContextWarn: atLine, before, after: tools.remoteHead(card), owner, ...measured, input: { prompt, cardBody }, steps: timer.steps(), ...(widenedInConcept.size === 0 ? {} : { widenedInConcept: [...widenedInConcept] }), ...(noViolationFreePath ? { noViolationFreePath } : {}) }
    }
    finally {
      request.stepped?.(timer.steps())
    }
  }
}
