import type { GhRunner } from '../board/gh.js'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { ANSWER_FLAG } from './answer.js'
import { REVIEW_MISSING_EVENT } from './current.js'
import { PR_REVIEW_EVENT } from './merge.js'
import { GHOST_JOURNAL, REPO, SHIFT_JOURNAL } from './places.js'

export const PREFIX = '[shift:bg] '
export const USAGE = 'usage: pnpm shift:bg <dir> [shift arguments]'
export const BG_LOG = 'shift-bg.log'

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

const ANSWERABLE_STOPS: readonly unknown[] = ['question', 'merge']
const STATELESS_EVENTS: readonly unknown[] = ['intake', 'intake-move', 'answer-brief', 'note', REVIEW_MISSING_EVENT]

interface JournalLine {
  event?: unknown
  task?: unknown
  at?: unknown
  shift?: unknown
  verdict?: unknown
  pr?: unknown
  commit?: unknown
}

function cardLines(journal: string, task: string): JournalLine[] {
  return journal.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as JournalLine | null
      return entry?.task === task ? [entry] : []
    }
    catch {
      return []
    }
  })
}

function describeLine(line: JournalLine): string {
  if (line.event === 'stop')
    return `event:stop at ${String(line.at)}`
  if (line.event === PR_REVIEW_EVENT)
    return `event:${PR_REVIEW_EVENT} ${String(line.verdict)} at ${String(line.commit)} on PR #${String(line.pr)}`
  return `event:${String(line.event)}`
}

function ofShift(line: JournalLine, dir: string): boolean {
  return typeof line.shift === 'string' && path.resolve(line.shift) === path.resolve(dir)
}

function openHead(gh: GhRunner, pr: number): string {
  let view: { state?: unknown, headRefOid?: unknown } | null
  try {
    view = JSON.parse(gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'state,headRefOid'])) as typeof view
  }
  catch (error) {
    return `not read (${(error instanceof Error ? error.message : String(error)).split('\n')[0]!})`
  }
  if (view?.state !== 'OPEN' || typeof view.headRefOid !== 'string')
    return `not open (${String(view?.state)})`
  return view.headRefOid
}

function reviewRefusal(task: string, review: JournalLine, gh: GhRunner): string | null {
  const nothing = `so ${ANSWER_FLAG} has nothing to answer`
  if (review.verdict !== 'changes' || typeof review.pr !== 'number')
    return `the last journal line of #${task} is ${describeLine(review)}, not a changes verdict, ${nothing}`
  const head = openHead(gh, review.pr)
  if (head !== review.commit)
    return `the last journal line of #${task} is ${describeLine(review)}, not the head of the open PR #${review.pr}, which is ${head}, ${nothing}`
  return null
}

export function answerRefusal(journalFile: string, task: string | undefined, dir: string, gh: GhRunner = execGh): string | null {
  if (task === undefined)
    return `${ANSWER_FLAG} names no card`
  const journal = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : ''
  const lines = cardLines(journal, task)
  const last = lines.filter(line => !STATELESS_EVENTS.includes(line.event)).at(-1)
  if (last === undefined)
    return `#${task} has no journal line in ${journalFile}, so it has no stop to answer`
  if (last.event === PR_REVIEW_EVENT) {
    const shiftLine = lines.filter(line => line.shift !== undefined).at(-1)
    if (shiftLine === undefined || !ofShift(shiftLine, dir))
      return `the last journal line of #${task} that names a shift is ${shiftLine === undefined ? 'none' : `${describeLine(shiftLine)} of the shift ${String(shiftLine.shift)}`}, not of ${dir}, so ${ANSWER_FLAG} has nothing to answer here`
    return reviewRefusal(task, last, gh)
  }
  if (last.event !== 'stop' || !ANSWERABLE_STOPS.includes(last.at))
    return `the last journal line of #${task} is ${describeLine(last)}, not a stop at question or merge nor a changes review at the open head, so ${ANSWER_FLAG} has nothing to answer`
  if (!ofShift(last, dir))
    return `the last journal line of #${task} is ${describeLine(last)} of the shift ${String(last.shift)}, not of ${dir}, so ${ANSWER_FLAG} has nothing to answer here`
  return null
}

export function launchArgv(shiftArgs: string[]): string[] {
  return ['nohup', 'pnpm', 'shift', ...shiftArgs]
}

export function runBg(argv: string[], env: NodeJS.ProcessEnv = process.env, gh: GhRunner = execGh): BgResult {
  const dir = argv[0]
  if (dir === undefined || dir.startsWith('-'))
    return { stdout: [], stderr: [USAGE], exitCode: 2 }
  const answerAt = argv.indexOf(ANSWER_FLAG)
  if (answerAt !== -1) {
    const journal = path.join(env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
    const refusal = answerRefusal(journal, argv[answerAt + 1]?.replace(/^#/, ''), dir, gh)
    if (refusal !== null)
      return { stdout: [], stderr: [`${PREFIX}${refusal}; nothing started`], exitCode: 1 }
  }
  else if (existsSync(path.join(dir, SHIFT_JOURNAL))) {
    return { stdout: [], stderr: [`${PREFIX}${path.join(dir, SHIFT_JOURNAL)} exists — that shift already ran; pnpm shift refuses it`], exitCode: 1 }
  }
  mkdirSync(dir, { recursive: true })
  const log = path.resolve(dir, BG_LOG)
  const [command, ...args] = launchArgv(argv)
  const fd = openSync(log, 'a')
  try {
    const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.on('error', () => {})
    child.unref()
    if (child.pid === undefined)
      return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
    return { stdout: [String(child.pid), `${PREFIX}pnpm shift ${argv.join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
  }
  finally {
    closeSync(fd)
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runBg(process.argv.slice(2))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
