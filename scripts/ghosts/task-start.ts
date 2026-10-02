import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'

export const PREFIX = '[task:start] '
export const USAGE = 'usage: tsx scripts/ghosts/task-start.ts <task-id> <branch>'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SAFE_ID = /^[\w.-]+$/
const SAFE_BRANCH = /^[^\s-]\S*$/

export interface TaskStartDeps {
  cwd: string
  git: (cwd: string, args: string[]) => string
  exists: (target: string) => boolean
  append: (file: string, text: string) => void
  now: () => Date
  session: string | undefined
  handoffDir: string
}

export interface TaskStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
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

export function runTaskStart(argv: string[], deps: TaskStartDeps): TaskStartResult {
  const [id, branch, ...extra] = argv
  if (id === undefined || branch === undefined || extra.length > 0)
    return refuse(USAGE)
  if (!SAFE_ID.test(id))
    return refuse(`task id '${id}' must be letters, digits, '.', '_' or '-'`)
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
  const at = deps.now().toISOString()
  const journal = path.join(deps.handoffDir, 'ghosts.jsonl')
  const line = { event: 'path', task: id, path: 'cheap', started: at, ...(deps.session === undefined ? {} : { session: deps.session }), worktree, branch, ts: at }
  try {
    deps.append(journal, `${JSON.stringify(line)}\n`)
  }
  catch (error) {
    return refuse(`${worktree} was cut on ${branch} but the start line could not be written to ${journal}: ${firstLine(error)}`)
  }
  const stdout = [`${PREFIX}cut ${worktree} on ${branch} from origin/main; start line written to ${journal}`]
  if (deps.session === undefined)
    stdout.push(`${PREFIX}${SESSION_VARIABLE} is not set; the board will show WINDOW UNKNOWN (no session)`)
  return { stdout, stderr: [], exitCode: 0 }
}

function realDeps(): TaskStartDeps {
  return {
    cwd: process.cwd(),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    session: process.env[SESSION_VARIABLE] === '' ? undefined : process.env[SESSION_VARIABLE],
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
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
