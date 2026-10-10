import type { AnswerSource, CardSession } from './answer-source.js'
import type { Lease } from './lease.js'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { HEADLESS_FLAGS, sessionArgv, sessionEnv } from '../ghosts/session.js'

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
}

export type Answerer = (request: AnswerRequest) => Promise<Answered>

export interface AnswerRun {
  cwd: string
  argv: string[]
  stdoutPath: string
  stderrPath: string
  env: NodeJS.ProcessEnv
}

export interface AnswererTools {
  available: (card: CardSession) => boolean
  remoteHead: (card: CardSession) => string | null
  spawn: (run: AnswerRun) => Promise<number>
  newSession: () => string
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

export function answerPrompt(request: AnswerRequest, ownerQuestion: string): string {
  const { lease, source, widened, card } = request
  return [
    `[answer:${lease.taskKey}]`,
    `Card #${lease.cardId}${lease.pr === null ? '' : `, pull request #${lease.pr} at ${lease.head}`}, in its tree ${card.worktree} on ${card.branch}.`,
    ...sourceLines(source),
    ...(widened === null ? [] : [`The touches are widened: ${widened}.`]),
    `The card's latest events, oldest first:`,
    ...source.events.map(event => JSON.stringify(event)),
    `Run pnpm run quality, commit and push to ${card.branch}. If the card cannot go on without the owner, push nothing and write the question for the owner, one line, to ${ownerQuestion}.`,
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

export const REAL_TOOLS: AnswererTools = {
  available: card => existsSync(path.join(CLAUDE_PROJECTS, projectDirOf(card.worktree), `${card.session}.jsonl`)),
  remoteHead,
  spawn: spawnClaude,
  newSession: randomUUID,
}

export function claudeAnswerer(dir: string, tools: AnswererTools = REAL_TOOLS): Answerer {
  return async (request) => {
    const { card } = request
    if (!existsSync(card.worktree))
      throw new CardTreeGone(card)
    const resumed = tools.available(card)
    const session = resumed ? card.session : tools.newSession()
    const ownerQuestion = ownerQuestionPath(dir, session, request.lease.leaseGen)
    const prompt = answerPrompt(request, ownerQuestion)
    mkdirSync(dir, { recursive: true })
    rmSync(ownerQuestion, { force: true })
    const before = tools.remoteHead(card)
    const code = await tools.spawn({
      cwd: card.worktree,
      argv: resumed ? resumeArgv(session, prompt, [dir]) : sessionArgv(session, prompt, [dir]),
      stdoutPath: path.join(dir, `${session}.${request.lease.leaseGen}.out.jsonl`),
      stderrPath: path.join(dir, `${session}.${request.lease.leaseGen}.err.log`),
      env: sessionEnv(process.env, request.lease.cardId),
    })
    if (code !== 0)
      throw new Error(`the answer session ${session} exited ${code}`)
    return { session, resumed, before, after: tools.remoteHead(card), owner: ownerQuestionIn(ownerQuestion) }
  }
}
