import type { Card } from '../../src/card/grammar.js'
import type { SignalStyle } from '../../src/ui/signal.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cardLine, cardTerms, parseCard } from '../../src/card/grammar.js'
import { INTAKE_EVENT } from '../../src/commands/intake/confirm.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { ENTRY_RESULT, entryLine } from './entry.js'

export const PREFIX = '[task:start] '
export const USAGE = 'usage: pnpm task:start <branch> --card "<card>"'
const CARD_FLAG = '--card'
const WITHOUT_INTAKE_FLAG = '--without-intake'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SAFE_BRANCH = /^[^\s-]\S*$/
const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']

export interface TaskStartDeps {
  cwd: string
  git: (cwd: string, args: string[]) => string
  install: (cwd: string, args: string[]) => void
  exists: (target: string) => boolean
  append: (file: string, text: string) => void
  now: () => Date
  session: string | undefined
  handoffDir: string
  readJournal?: TaskStartJournalReader
  style?: SignalStyle
}

export type TaskStartJournalReader = (file: string) => string | null

export function readJournalFile(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export interface TaskStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  worktree?: string
}

type Admission
  = | { kind: 'admitted', by: 'intake', confirmation: string, ts: string }
    | { kind: 'admitted', by: 'waiver', reason: string }
    | { kind: 'refused', reason: string }

interface IntakeLine {
  card: string
  confirmation: string
  ts: string
}

function intakeLines(journal: string | null, task: string): IntakeLine[] {
  return (journal ?? '').split('\n').flatMap((text) => {
    try {
      const entry = JSON.parse(text) as Record<string, unknown> | null
      return entry?.event === INTAKE_EVENT && entry.task === task && typeof entry.card === 'string'
        ? [{ card: entry.card, confirmation: String(entry.confirmation), ts: String(entry.ts) }]
        : []
    }
    catch {
      return []
    }
  })
}

function sameCard(recorded: string, card: Card): boolean {
  const parsed = parseCard(recorded)
  return parsed.kind === 'card' && cardLine(parsed.card) === cardLine(card)
}

function admission(card: Card, journal: string | null, waiver: string | undefined): Admission {
  if (waiver !== undefined)
    return { kind: 'admitted', by: 'waiver', reason: waiver }
  const recorded = intakeLines(journal, String(card.id))
  const confirmed = recorded.filter(line => sameCard(line.card, card)).at(-1)
  if (confirmed !== undefined)
    return { kind: 'admitted', by: 'intake', confirmation: confirmed.confirmation, ts: confirmed.ts }
  const how = `slice and confirm it with construct intake, or pass ${WITHOUT_INTAKE_FLAG} "<reason>" to record an exception`
  return recorded.length === 0
    ? { kind: 'refused', reason: `card #${card.id} has no intake line in the journal: it was not sliced and confirmed; ${how}` }
    : { kind: 'refused', reason: `card #${card.id} differs from the card its intake line confirmed (${recorded.at(-1)!.card}); ${how}` }
}

function admissionRecord(admitted: Exclude<Admission, { kind: 'refused' }>): Record<string, string> {
  return admitted.by === 'intake'
    ? { by: 'intake', confirmation: admitted.confirmation, intake: admitted.ts }
    : { by: 'waiver', flag: WITHOUT_INTAKE_FLAG, reason: admitted.reason }
}

function refuse(message: string): TaskStartResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function branchExists(deps: TaskStartDeps, repo: string, branch: string): boolean {
  try {
    deps.git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  }
  catch {
    return false
  }
}

function removeTree(deps: TaskStartDeps, repo: string, worktree: string, branch: string): string {
  try {
    deps.git(repo, ['worktree', 'remove', '--force', worktree])
    deps.git(repo, ['branch', '-D', branch])
    return `the tree and branch ${branch} were removed`
  }
  catch (error) {
    return `removing the tree failed (${firstLine(error)}); remove ${worktree} and branch ${branch} by hand`
  }
}

function flagValue(argv: string[], flag: string): { at: number, value: string | undefined } {
  const at = argv.indexOf(flag)
  return { at, value: at === -1 ? undefined : argv[at + 1] }
}

function cardArgs(argv: string[]): { branch: string, card: string, waiver: string | undefined } | null {
  const card = flagValue(argv, CARD_FLAG)
  const waiver = flagValue(argv, WITHOUT_INTAKE_FLAG)
  if (card.value === undefined || (waiver.at !== -1 && (waiver.value === undefined || waiver.value.trim() === '')))
    return null
  const taken = new Set([card.at, card.at + 1, ...(waiver.at === -1 ? [] : [waiver.at, waiver.at + 1])])
  const positional = argv.filter((_, index) => !taken.has(index))
  return positional.length === 1 ? { branch: positional[0]!, card: card.value, waiver: waiver.value?.trim() } : null
}

export function runTaskStart(argv: string[], deps: TaskStartDeps): TaskStartResult {
  if (!argv.includes(CARD_FLAG))
    return refuse(`a task starts from its card now: ${USAGE}; the id is the card's #<id>`)
  const args = cardArgs(argv)
  if (args === null)
    return refuse(USAGE)
  const { branch } = args
  const parsed = parseCard(args.card)
  if (parsed.kind === 'refused')
    return refuse(`card refused: ${parsed.reason}; nothing written`)
  const { card } = parsed
  const id = String(card.id)
  if (!SAFE_BRANCH.test(branch))
    return refuse(`branch '${branch}' must not be empty, hold whitespace or start with '-'`)
  const journal = path.join(deps.handoffDir, 'ghosts.jsonl')
  const admitted = deps.readJournal === undefined && args.waiver === undefined ? undefined : admission(card, deps.readJournal?.(journal) ?? null, args.waiver)
  if (admitted?.kind === 'refused')
    return refuse(`${admitted.reason}; nothing written`)
  let repo: string
  try {
    repo = deps.git(deps.cwd, ['rev-parse', '--show-toplevel']).trim()
  }
  catch (error) {
    return refuse(`not inside a git repository: ${firstLine(error)}`)
  }
  const worktree = path.join(path.dirname(repo), `mc-${id}`)
  if (deps.exists(worktree))
    return refuse(`${worktree} already exists; nothing written`)
  if (branchExists(deps, repo, branch))
    return refuse(`branch ${branch} already exists; nothing written`)
  try {
    deps.git(repo, ['fetch', 'origin', 'main'])
    deps.git(repo, ['worktree', 'add', '-b', branch, worktree, 'origin/main'])
  }
  catch (error) {
    return refuse(`could not cut ${worktree}: ${firstLine(error)}; nothing written`)
  }
  try {
    deps.install(worktree, INSTALL_ARGS)
  }
  catch (error) {
    return refuse(`pnpm ${INSTALL_ARGS.join(' ')} failed in ${worktree}: ${firstLine(error)}; ${removeTree(deps, repo, worktree, branch)}; nothing written`)
  }
  const at = deps.now().toISOString()
  const line = { event: 'path', task: id, path: card.contour, started: at, ...(deps.session === undefined ? {} : { session: deps.session }), worktree, branch, card, ...(admitted === undefined ? {} : { admission: admissionRecord(admitted) }), ts: at }
  const written = `start line written to ${journal}`
  const signal = {
    CONTRACT: `${cardTerms(card)} · touches not recorded on the card · law not recorded on the card`,
    EXPECT: `expect not recorded on the start line: its session is the window's ${SESSION_VARIABLE}, shared by every task the window runs, so no session is this task's alone`,
    ACTION: `task:start ${branch} #${id}: cut ${worktree} from origin/main; ${written}${deps.session === undefined ? `; ${SESSION_VARIABLE} is not set, the board will show WINDOW UNKNOWN (no session)` : ''}`,
    RESULT: ENTRY_RESULT,
  }
  try {
    deps.append(journal, `${JSON.stringify(line)}\n${entryLine(id, signal, at)}`)
  }
  catch (error) {
    return refuse(`${worktree} was cut on ${branch} but the start line could not be written to ${journal}: ${firstLine(error)}`)
  }
  const stdout = renderSignal(`task:start #${id} ${card.name}`, signal, deps.style ?? PLAIN_STYLE)
  return { stdout, stderr: [], exitCode: 0, worktree }
}

export function pnpmInstall(cwd: string, args: string[]): void {
  execFileSync('pnpm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function realDeps(): TaskStartDeps {
  return {
    cwd: process.cwd(),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    install: pnpmInstall,
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    session: process.env[SESSION_VARIABLE] === '' ? undefined : process.env[SESSION_VARIABLE],
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    readJournal: readJournalFile,
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runTaskStart(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
