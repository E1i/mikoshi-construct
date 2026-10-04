import type { SignalStyle } from '../../src/ui/signal.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cardTerms, parseCard } from '../../src/card/grammar.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { ENTRY_RESULT, entryLine } from './entry.js'

export const PREFIX = '[task:start] '
export const USAGE = 'usage: pnpm task:start <branch> --card "<card>"'
const CARD_FLAG = '--card'
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
  style?: SignalStyle
}

export interface TaskStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  worktree?: string
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

function cardArgs(argv: string[]): { branch: string, card: string } | null {
  const at = argv.indexOf(CARD_FLAG)
  const card = argv[at + 1]
  if (at === -1 || card === undefined)
    return null
  const positional = argv.filter((_, index) => index !== at && index !== at + 1)
  return positional.length === 1 ? { branch: positional[0]!, card } : null
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
  const journal = path.join(deps.handoffDir, 'ghosts.jsonl')
  const line = { event: 'path', task: id, path: card.contour, started: at, ...(deps.session === undefined ? {} : { session: deps.session }), worktree, branch, card, ts: at }
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
