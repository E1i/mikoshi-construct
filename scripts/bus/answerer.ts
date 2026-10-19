import type { AnswerSource, CardSession } from './answer-source.js'
import type { Lease } from './lease.js'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readResultFields } from '../ghosts/result.js'
import { HEADLESS_FLAGS, sessionArgv, sessionEnv } from '../ghosts/session.js'
import { commitAndPush } from '../shift/tree-pr.js'
import { parkedCardFile } from './card-archive.js'
import { heartbeatEnv } from './heartbeat.js'

export const PREFIX = '[bus:answer] '
const SESSION_ID_FLAG = '--session-id'
const RESUME_FLAG = '--resume'
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

export interface AnswerRequest {
  lease: Lease
  source: AnswerSource
  widened: string | null
  card: CardSession
}

export interface Answered {
  session: string
  resumed: boolean
  before: string | null
  after: string | null
  owner: string | null
  tokens?: number | null
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

export function parkedCardText(parking: string): CardText {
  return (cardId) => {
    const file = parkedCardFile(parking, cardId)
    return file === undefined ? null : readFileSync(file, 'utf8')
  }
}

export interface AnswererTools {
  cardText: CardText
  available: (card: CardSession) => boolean
  remoteHead: (card: CardSession) => string | null
  spawn: (run: AnswerRun) => Promise<number>
  newSession: () => string
  publish: (card: CardSession, commitMessage: string) => void
}

export function answerCommitMessage(lease: Lease): string {
  return `answer for #${lease.cardId}${lease.pr === null ? '' : ` on PR #${lease.pr}`}\n\nCommitted by the bus from the card's worktree after its answer session ended.`
}

function publishTree(card: CardSession, commitMessage: string): void {
  commitAndPush((cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), card.worktree, card.branch, commitMessage)
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

function cardLines(cardId: number, cardText: string | null): string[] {
  if (cardText === null)
    return [`Card #${cardId} has no file in parking; read the card from the pull request.`]
  return [`The card as it stands in parking now, witnesses admitted after the verdict included:`, cardText.trim()]
}

export function answerPrompt(request: AnswerRequest, ownerQuestion: string, cardText: string | null): string {
  const { lease, source, widened, card } = request
  return [
    `[answer:${lease.taskKey}]`,
    `Card #${lease.cardId}${lease.pr === null ? '' : `, pull request #${lease.pr} at ${lease.head}`}, in its tree ${card.worktree} on ${card.branch}.`,
    ...cardLines(lease.cardId, cardText),
    ...sourceLines(source),
    ...(widened === null ? [] : [`The touches are widened: ${widened}.`]),
    `The card's latest events, oldest first:`,
    ...source.events.map(event => JSON.stringify(event)),
    `Run the window gate of D-194 in ${card.worktree}, each as its own command: the card's witnesses, the tests pnpm gate:window prints for the tree, pnpm typecheck and pnpm lint; the full quality is CI. End the session when they are green. Do not commit and do not push: once the session ends the bus commits the tree and pushes it to ${card.branch}. A refused git command is not a question. If the card cannot go on without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
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

export function realAnswererTools(parking: string): AnswererTools {
  return {
    cardText: parkedCardText(parking),
    available: card => existsSync(path.join(CLAUDE_PROJECTS, projectDirOf(card.worktree), `${card.session}.jsonl`)),
    remoteHead,
    spawn: spawnClaude,
    newSession: randomUUID,
    publish: publishTree,
  }
}

export function claudeAnswerer(dir: string, tools: AnswererTools): Answerer {
  return async (request) => {
    const { card } = request
    if (!existsSync(card.worktree))
      throw new CardTreeGone(card)
    const resumed = tools.available(card)
    const session = resumed ? card.session : tools.newSession()
    const ownerQuestion = ownerQuestionPath(dir, session, request.lease.leaseGen)
    const prompt = answerPrompt(request, ownerQuestion, tools.cardText(request.lease.cardId))
    mkdirSync(dir, { recursive: true })
    rmSync(ownerQuestion, { force: true })
    const before = tools.remoteHead(card)
    const stdoutPath = path.join(dir, `${session}.${request.lease.leaseGen}.out.jsonl`)
    const code = await tools.spawn({
      cwd: card.worktree,
      argv: resumed ? resumeArgv(session, prompt, [dir]) : sessionArgv(session, prompt, [dir]),
      stdoutPath,
      stderrPath: path.join(dir, `${session}.${request.lease.leaseGen}.err.log`),
      env: { ...sessionEnv(process.env, request.lease.cardId), ...heartbeatEnv(request.lease) },
    })
    if (code !== 0)
      throw new Error(`the answer session ${session} exited ${code}`)
    const owner = ownerQuestionIn(ownerQuestion)
    if (owner === null)
      tools.publish(card, answerCommitMessage(request.lease))
    const result = readResultFields(stdoutPath)
    const measured = result.resultLine === 'present' ? { tokens: tokensOf(result.usage) } : {}
    return { session, resumed, before, after: tools.remoteHead(card), owner, ...measured }
  }
}
