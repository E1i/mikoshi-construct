import type { FreshBaseGap } from '../shift/tree-pr.js'
import type { AnswerSource, CardSession } from './answer-source.js'
import type { Lease } from './lease.js'
import type { AnswerInput } from './prompt-store.js'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { projectRoot, realExitReadings, sessionGauges, UNKNOWN } from '../miko/eddies-measure.js'
import { readResultFields } from '../ports/result.js'
import { HEADLESS_FLAGS, sessionArgv, sessionEnv } from '../ports/session.js'
import { commitAndPush, freshBaseProblem, freshBaseTask } from '../shift/tree-pr.js'
import { defaultBusPath } from './db.js'
import { busSessionPulse } from './heartbeat.js'
import { busCardBodies } from './parking-reads.js'
import { MAIN_BRANCH } from './snapshot.js'

export const PREFIX = '[bus:answer] '
const SESSION_ID_FLAG = '--session-id'
const RESUME_FLAG = '--resume'
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
export const ANSWER_BEAT_MS = 60_000
export const DIFF_PROMPT_LIMIT = 100_000

export interface AnswerRequest {
  lease: Lease
  source: AnswerSource
  widened: string | null
  card: CardSession
  fresh?: boolean
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
}

const USAGE_TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

export function tokensOf(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object')
    return null
  const counts = USAGE_TOKEN_FIELDS.map(field => (usage as Record<string, unknown>)[field]).filter(value => typeof value === 'number')
  return counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0)
}

export type Answerer = (request: AnswerRequest) => Promise<Answered>

export interface AnswerRun {
  cwd: string
  argv: string[]
  stdoutPath: string
  stderrPath: string
  env: NodeJS.ProcessEnv
}

export type CardText = (cardId: number) => string | null

export interface AnswererTools {
  cardText: CardText
  available: (card: CardSession) => boolean
  remoteHead: (card: CardSession) => string | null
  spawn: (run: AnswerRun) => Promise<number>
  newSession: () => string
  publish: (card: CardSession, commitMessage: string) => void
  pulse?: AnswerPulse
  context?: (session: string) => number | null
  contextWarn?: () => number | null
  diff?: (card: CardSession) => string | null
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

export function answerCommitMessage(lease: Lease): string {
  return `answer for #${lease.cardId}${lease.pr === null ? '' : ` on PR #${lease.pr}`}\n\nCommitted by the bus from the card's worktree after its answer session ended.`
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
    `Do it yourself: ${freshBaseTask(card.worktree, gap)}.`,
    `Then repeat the window gate of D-194 in ${card.worktree} and end the session; the bus merges again and pushes. If the merge cannot be settled without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
}

export function unmergedQuestion(card: CardSession, gap: FreshBaseGap): string {
  return `merging a fresh origin/${MAIN_BRANCH} into ${card.branch} ${freshBaseProblem(gap)} and the answer session did not resolve it`
}

export const MERGE_STEP = '.merge'

function measuredOf(stdoutPaths: readonly string[]): { tokens?: number | null } {
  const results = stdoutPaths.map(readResultFields).filter(result => result.resultLine === 'present')
  if (results.length === 0)
    return {}
  const counts = results.map(result => tokensOf(result.usage)).filter((count): count is number => count !== null)
  return { tokens: counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0) }
}

export function resumeArgv(sessionId: string, prompt: string, addDirs: string[] = []): string[] {
  return [...addDirs.flatMap(dir => ['--add-dir', dir]), ...HEADLESS_FLAGS.filter(flag => flag !== SESSION_ID_FLAG), RESUME_FLAG, sessionId, prompt]
}

export function projectDirOf(worktree: string): string {
  return worktree.replace(/[^a-z0-9]/gi, '-')
}

function sourceLines(source: AnswerSource): string[] {
  if (source.kind === 'changes') {
    return [
      source.findings.length === 0 ? 'The review asked for changes and recorded no findings on the bus; read the review on the pull request.' : 'The review asked for changes. Its findings:',
      ...source.findings.map(finding => `- ${finding}`),
      'Address every finding.',
    ]
  }
  if (source.kind === 'ci') {
    return [
      source.failedChecks.length === 0 ? 'CI is red on this head and the bus recorded no failed check by name; read the checks on the pull request.' : `CI is red on this head. The failed checks: ${source.failedChecks.join(', ')}.`,
      'Read their logs (gh pr checks, gh run view --log-failed) and fix every one.',
    ]
  }
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

function resultEntryOf(stdoutPath: string): Record<string, unknown> | null {
  if (!existsSync(stdoutPath))
    return null
  let found: Record<string, unknown> | null = null
  for (const line of readFileSync(stdoutPath, 'utf8').split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'result')
        found = parsed as Record<string, unknown>
    }
    catch {}
  }
  return found
}

function inputAimsAt(input: Record<string, unknown>, file: string): boolean {
  return input.file_path === file || (typeof input.command === 'string' && input.command.includes(file))
}

function nonEmpty(text: unknown): string | null {
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
}

export function refusedOwnerQuestionIn(stdoutPath: string, file: string): string | null {
  const result = resultEntryOf(stdoutPath)
  const denials = Array.isArray(result?.permission_denials) ? result.permission_denials as unknown[] : []
  const inputs = denials.map(denial => (denial !== null && typeof denial === 'object' ? (denial as Record<string, unknown>).tool_input : null)).filter((input): input is Record<string, unknown> => input !== null && typeof input === 'object')
  const refused = inputs.find(input => inputAimsAt(input, file))
  if (refused === undefined)
    return null
  return nonEmpty(refused.content) ?? nonEmpty(result?.result)
}

function cardLines(cardId: number, cardText: string | null): string[] {
  if (cardText === null)
    return [`Card #${cardId} has no admitted body in the bus; read the card from the pull request.`]
  return [`The card as the bus holds it now, witnesses admitted after the verdict included:`, cardText.trim()]
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

export function answerPrompt(request: AnswerRequest, ownerQuestion: string, cardText: string | null, diff?: string | null): string {
  const { lease, source, widened, card } = request
  return [
    `[answer:${lease.taskKey}]`,
    `Card #${lease.cardId}${lease.pr === null ? '' : `, pull request #${lease.pr} at ${lease.head}`}, in its tree ${card.worktree} on ${card.branch}.`,
    ...cardLines(lease.cardId, cardText),
    ...sourceLines(source),
    ...diffLines(card, diff),
    ...(widened === null ? [] : [`The touches are widened: ${widened}.`]),
    `The card's latest events, oldest first:`,
    ...source.events.map(event => JSON.stringify(event)),
    `Run the window gate of D-194 in ${card.worktree}, each as its own command: the card's witnesses, pnpm typecheck, pnpm lint and the pre-push tests, pnpm exec node --import tsx scripts/ci/prepush.ts, which runs the tests the CI selector picks for this tree less the sandbox list; the full quality is CI. End the session when they are green. A red pre-push run is fixed in this session; a broken one prints its finding and question, and that question goes to the owner as below. Do not commit and do not push: once the session ends the bus commits the tree and pushes it to ${card.branch}. A refused git command is not a question. If the card cannot go on without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
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

function contextWarnOfEddies(): number | null {
  const warn = realExitReadings({}, os.homedir(), projectRoot(process.env), defaultBusPath()).contextWarn
  return warn === UNKNOWN ? null : warn
}

function spawnClaude(run: AnswerRun): Promise<number> {
  const outFd = openSync(run.stdoutPath, 'w')
  const errFd = openSync(run.stderrPath, 'w')
  let closed = false
  const closeOnce = (): void => {
    if (!closed) {
      closed = true
      closeSync(outFd)
      closeSync(errFd)
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('claude', run.argv, { cwd: run.cwd, env: run.env, stdio: ['ignore', outFd, errFd] })
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

export class CardTreeGone extends Error {
  constructor(card: CardSession) {
    super(`the card tree ${card.worktree} is gone`)
  }
}

export function realAnswererTools(busPath: string = defaultBusPath()): AnswererTools {
  return {
    pulse: busSessionPulse(busPath, () => new Date()),
    cardText: busCardBodies(busPath),
    available: card => existsSync(path.join(CLAUDE_PROJECTS, projectDirOf(card.worktree), `${card.session}.jsonl`)),
    remoteHead,
    spawn: spawnClaude,
    newSession: randomUUID,
    publish: publishTree,
    context: session => sessionGauges(os.homedir(), projectRoot(process.env), session).context ?? null,
    contextWarn: contextWarnOfEddies,
    diff: diffAgainstBase,
  }
}

function atContextWarn(tools: AnswererTools, session: string): boolean {
  const warn = tools.contextWarn?.() ?? null
  const context = warn === null ? null : tools.context?.(session) ?? null
  return warn !== null && context !== null && context >= warn
}

export function claudeAnswerer(dir: string, tools: AnswererTools): Answerer {
  return async (request) => {
    const { card } = request
    if (!existsSync(card.worktree))
      throw new CardTreeGone(card)
    const resumed = request.fresh !== true && tools.available(card) && !atContextWarn(tools, card.session)
    const session = resumed ? card.session : tools.newSession()
    const ownerQuestion = ownerQuestionPath(dir, session, request.lease.leaseGen)
    const cardBody = tools.cardText(request.lease.cardId)
    const prompt = answerPrompt(request, ownerQuestion, cardBody, resumed ? undefined : tools.diff?.(card))
    mkdirSync(dir, { recursive: true })
    rmSync(ownerQuestion, { force: true })
    const before = tools.remoteHead(card)
    const stdoutOf = (step: string): string => path.join(dir, `${session}.${request.lease.leaseGen}${step}.out.jsonl`)
    const beat = (): void => {
      try {
        tools.pulse?.(request.lease, session)
      }
      catch (error) {
        console.error(missedAnswerBeatLine(session, error))
      }
    }
    const run = (argv: string[], step: string): Promise<number> => beatingWhileRunning(() => tools.spawn({
      cwd: card.worktree,
      argv,
      stdoutPath: stdoutOf(step),
      stderrPath: path.join(dir, `${session}.${request.lease.leaseGen}${step}.err.log`),
      env: sessionEnv(process.env, request.lease.cardId),
    }), beat, ANSWER_BEAT_MS)
    const code = await run(resumed ? resumeArgv(session, prompt, [dir]) : sessionArgv(session, prompt, [dir]), '')
    if (code !== 0)
      throw new Error(`the answer session ${session} exited ${code}`)
    const steps = ['']
    const ownerAfter = (step: string): string | null => ownerQuestionIn(ownerQuestion) ?? refusedOwnerQuestionIn(stdoutOf(step), ownerQuestion)
    const pushTree = (): FreshBaseGap | null => freshBaseGapOf(() => tools.publish(card, answerCommitMessage(request.lease)))
    const publish = async (): Promise<string | null> => {
      const gap = pushTree()
      if (gap === null)
        return null
      steps.push(MERGE_STEP)
      const merged = await run(resumeArgv(session, mergePrompt(request.lease, card, gap, ownerQuestion), [dir]), MERGE_STEP)
      const owner = ownerAfter(MERGE_STEP)
      if (owner !== null)
        return owner
      const left = merged === 0 ? pushTree() : gap
      return left === null ? null : unmergedQuestion(card, left)
    }
    const owner = ownerAfter('') ?? await publish()
    const measured = measuredOf(steps.map(stdoutOf))
    return { session, resumed, atContextWarn: atContextWarn(tools, session), before, after: tools.remoteHead(card), owner, ...measured, input: { prompt, cardBody } }
  }
}
