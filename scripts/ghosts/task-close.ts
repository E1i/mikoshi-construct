import type { SignalStyle } from '../../src/ui/signal.js'
import type { Card } from './card.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { claudeProjectsDir, projectKey } from '../../src/commands/cost/claude-code.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { ENTRY_EVENT, entryOf } from './entry.js'

export const PREFIX = '[task:close] '
export const USAGE = 'usage: pnpm task:close <id> (--pr <N> | --report <path>) --verification <word>'
const FLAGS = ['--pr', '--report', '--verification'] as const
const PR_NUMBER = /^[1-9]\d*$/
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const OUTCOME_OF_KIND: Record<Card['kind'], typeof FLAGS[number]> = { implement: '--pr', probe: '--report' }

type Flag = typeof FLAGS[number]

interface StartLine {
  event: 'path'
  task: string
  path: string
  worktree?: unknown
  session?: unknown
  card: Card
}

export interface TaskSession {
  id: string
  project?: string
}

export interface TaskCloseDeps {
  cwd: string
  read: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
  handoffDir: string
  exists: (file: string) => boolean
  session: string | undefined
  projectsDir: string
  style?: SignalStyle
}

export interface TaskCloseResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

function refuse(message: string): TaskCloseResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function readArgs(argv: string[]): { id: string, flags: Map<Flag, string> } | string {
  const flags = new Map<Flag, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (!(FLAGS as readonly string[]).includes(arg))
      return `unknown flag ${arg}`
    const value = argv[++index]
    if (value === undefined || value.startsWith('--'))
      return `${arg} needs a value`
    if (flags.has(arg as Flag))
      return `${arg} given twice`
    flags.set(arg as Flag, value)
  }
  return positional.length === 1 ? { id: positional[0]!, flags } : 'one task id is needed'
}

function journalLines(journal: string): Record<string, unknown>[] {
  return journal.split('\n').flatMap((text) => {
    try {
      const entry: unknown = JSON.parse(text)
      return typeof entry === 'object' && entry !== null ? [entry as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

function hasCard(line: Record<string, unknown>): line is Record<string, unknown> & { card: Card } {
  return typeof line.card === 'object' && line.card !== null
}

function startLineOf(lines: Record<string, unknown>[], id: string): StartLine | undefined {
  return lines.filter((line): line is Record<string, unknown> & StartLine => line.event === 'path' && line.task === id && hasCard(line)).at(-1)
}

function launchStartOf(lines: Record<string, unknown>[], id: string): StartLine | undefined {
  const entry = lines.filter(line => line.event === ENTRY_EVENT && line.task === id).filter(hasCard).at(-1)
  if (entry === undefined)
    return undefined
  const session = lines.filter(line => line.event === 'task' && line.task === id).at(-1)?.session
  return { event: 'path', task: id, path: entry.card.contour, session, card: entry.card }
}

function sessionDirs(deps: TaskCloseDeps, start: StartLine): string[] {
  return [...new Set([deps.cwd, ...(typeof start.worktree === 'string' ? [start.worktree] : [])])]
}

function taskSessions(deps: TaskCloseDeps, start: StartLine): TaskSession[] {
  const ids = [...new Set([start.session, deps.session].filter((id): id is string => typeof id === 'string' && id !== ''))]
  const keys = sessionDirs(deps, start).map(projectKey)
  return ids.map((id) => {
    const project = keys.find(key => deps.exists(path.join(deps.projectsDir, key, `${id}.jsonl`)))
    return project === undefined ? { id } : { id, project }
  })
}

function unplacedLine(deps: TaskCloseDeps, start: StartLine, sessions: TaskSession[]): string[] {
  const unplaced = sessions.filter(session => session.project === undefined).map(session => session.id)
  if (sessions.length === 0)
    return [`${PREFIX}#${start.task} sessions not recorded on the start line or in ${SESSION_VARIABLE}`]
  if (unplaced.length === 0)
    return []
  return [`${PREFIX}#${start.task} session ${unplaced.join(', ')} project not recorded: no session file under ${sessionDirs(deps, start).map(projectKey).join(' or ')} in ${deps.projectsDir}`]
}

export function runTaskClose(argv: string[], deps: TaskCloseDeps): TaskCloseResult {
  const args = readArgs(argv)
  if (typeof args === 'string')
    return refuse(`${args}; ${USAGE}`)
  const { id, flags } = args
  const verification = flags.get('--verification')
  if (verification === undefined)
    return refuse(`--verification is required: one of ${VERIFICATION_WORDS.join(', ')}; nothing written`)
  if (!(VERIFICATION_WORDS as readonly string[]).includes(verification))
    return refuse(`verification '${verification}' is not one of ${VERIFICATION_WORDS.join(', ')}; nothing written`)
  const journal = path.join(deps.handoffDir, 'ghosts.jsonl')
  const journalText = deps.read(journal) ?? ''
  const lines = journalLines(journalText)
  const start = startLineOf(lines, id) ?? launchStartOf(lines, id)
  if (start === undefined)
    return refuse(`${journal} has no task:start line with a card for #${id} and no ghosts:launch entry line with one; start the task with pnpm task:start <branch> --card "<card>"; nothing written`)
  const outcome = OUTCOME_OF_KIND[start.card.kind]
  const other = outcome === '--pr' ? '--report' : '--pr'
  if (flags.has(other) || !flags.has(outcome))
    return refuse(`#${id} is kind ${start.card.kind}, which closes with ${outcome} only; nothing written`)
  const value = flags.get(outcome)!
  if (outcome === '--pr' && !PR_NUMBER.test(value))
    return refuse(`--pr '${value}' is not a pull request number; nothing written`)
  const report = path.resolve(deps.cwd, value)
  const closing = outcome === '--pr' ? { pr: Number(value) } : { report }
  const at = deps.now().toISOString()
  const sessions = taskSessions(deps, start)
  const line = { event: 'path', task: id, path: start.path, ...closing, verification, ended: at, sessions, ts: at }
  try {
    deps.append(journal, `${JSON.stringify(line)}\n`)
  }
  catch (error) {
    return refuse(`the closing line could not be written to ${journal}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  const entry = entryOf(journalText, id)
  const closed = `closed ${verification} · ${outcome === '--pr' ? `PR #${value}` : `report ${report}`} · line written to ${journal}`
  const card = renderSignal(`task:close #${id} ${start.card.name}`, {
    CONTRACT: entry?.CONTRACT ?? `contract not recorded in ${journal}: no entry line for #${id}`,
    EXPECT: entry?.EXPECT ?? `expect not recorded in ${journal}: no entry line for #${id}`,
    ACTION: `task:close #${id} ${outcome} ${value} --verification ${verification}`,
    RESULT: closed,
  }, deps.style ?? PLAIN_STYLE)
  return { stdout: [...card, ...unplacedLine(deps, start, sessions)], stderr: [], exitCode: 0 }
}

function realDeps(): TaskCloseDeps {
  return {
    cwd: process.cwd(),
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    exists: existsSync,
    session: process.env[SESSION_VARIABLE] === '' ? undefined : process.env[SESSION_VARIABLE],
    projectsDir: claudeProjectsDir(),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runTaskClose(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
