import type { GhRunner } from '../board/gh.js'
import type { TaskStartDeps } from '../ghosts/task-start.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import type { OpenPr } from './overlap.js'
import type { TaskLine } from './places.js'
import type { ShiftTask } from './task-file.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { runTaskStart } from '../ghosts/task-start.js'
import { CLAUDE_VARIABLE, runClaude } from './claude.js'
import { openPrWarnings, taskConflicts } from './overlap.js'
import { exitedWithoutReport, logPath, REPO, reportPath, SHIFT_JOURNAL } from './places.js'
import { renderPrompt } from './prompt.js'
import { parseTaskFile, TASK_FILE } from './task-file.js'

export const PREFIX = '[shift] '
export const USAGE = [
  'usage: pnpm shift <dir> [--check]',
  '',
  'Runs every NN.md in <dir> in order, each as a fresh headless claude session in its own tree cut by task:start.',
  'A task file starts with a header and a blank line, then the prompt:',
  '  card: #<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>',
  '  branch: <branch>',
  '  touches: <path>, <dir>/**',
  '',
  'Recommended layout: one directory per shift, e.g. ~/.construct/shift/2026-10-03-1500/.',
  `${CLAUDE_VARIABLE} is the claude command, without caffeinate, e.g.:`,
  `  ${CLAUDE_VARIABLE}='GH_TOKEN=$(gh auth token --user E1i) claude --permission-mode auto'`,
  'Keep the Mac awake for the whole runner, not only for each claude session, or it sleeps between tasks:',
  '  caffeinate -dis pnpm shift <dir>',
  '--check parses the tasks and checks touches against each other and the open pull requests, and starts nothing.',
  'Afterwards: pnpm shift:report <dir>.',
].join('\n')

export interface ShiftDeps {
  cwd: string
  claude: string | undefined
  header: string
  handoffDir: string
  git: TaskStartDeps['git']
  gh: GhRunner
  listDir: (dir: string) => string[]
  read: (file: string) => string
  exists: (target: string) => boolean
  append: (file: string, text: string) => void
  now: () => Date
  uuid: () => string
  run: (run: ClaudeRun) => Promise<ClaudeExit>
  out: (line: string) => void
  err: (line: string) => void
}

function refuse(deps: ShiftDeps, lines: string[]): number {
  for (const line of lines)
    deps.err(`${PREFIX}${line}`)
  return 1
}

function readTasks(deps: ShiftDeps, dir: string): { tasks: ShiftTask[], errors: string[] } {
  const files = deps.listDir(dir).filter(file => TASK_FILE.test(file)).sort((a, b) => Number(TASK_FILE.exec(a)![1]) - Number(TASK_FILE.exec(b)![1]) || a.localeCompare(b))
  const parsed = files.map(file => parseTaskFile(file, deps.read(path.join(dir, file))))
  return {
    tasks: parsed.flatMap(entry => entry.kind === 'task' ? [entry.task] : []),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

function openPrs(gh: GhRunner): OpenPr[] | string {
  try {
    const listed = JSON.parse(gh(['pr', 'list', '-R', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,files'])) as { number: number, headRefName: string, files: { path: string }[] | null }[]
    return listed.map(pr => ({ number: pr.number, headRefName: pr.headRefName, files: (pr.files ?? []).map(file => file.path) }))
  }
  catch (error) {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
  }
}

function warnOpenPrs(deps: ShiftDeps, tasks: ShiftTask[]): void {
  const prs = openPrs(deps.gh)
  if (typeof prs === 'string') {
    deps.err(`${PREFIX}warning: open pull requests not read (${prs}); touches checked only between tasks`)
    return
  }
  for (const line of openPrWarnings(tasks, prs))
    deps.err(`${PREFIX}warning: ${line}`)
}

async function runTask(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string): Promise<TaskLine> {
  const session = deps.uuid()
  const started = deps.now().toISOString()
  const base = { event: 'task' as const, file: task.file, number: task.number, task: task.id, card: task.card, branch: task.branch, session, started }
  const start = runTaskStart([task.branch, '--card', task.card.line], { cwd: deps.cwd, git: deps.git, exists: deps.exists, append: deps.append, now: deps.now, session, handoffDir: deps.handoffDir })
  if (start.exitCode !== 0 || start.worktree === undefined)
    return { ...base, worktree: null, ended: deps.now().toISOString(), exit: null, signal: null, refused: start.stderr.join(' ') }
  const worktree = start.worktree
  const prompt = renderPrompt(deps.header, task, { worktree, report: reportPath(dir, task.number) })
  const exit = await deps.run({ command: claude, cwd: worktree, sessionId: session, prompt, log: logPath(dir, task.number) })
  const ended = deps.now().toISOString()
  if (exit.kind === 'unspawnable')
    return { ...base, worktree, ended, exit: null, signal: null, error: exit.error }
  return { ...base, worktree, ended, exit: exit.code, signal: exit.signal, report: deps.exists(reportPath(dir, task.number)) }
}

function outcome(line: TaskLine): string {
  if (line.refused !== undefined)
    return `not started: ${line.refused}`
  if (line.error !== undefined)
    return `not spawned: ${line.error}`
  if (line.signal !== null)
    return `signal ${line.signal}`
  return exitedWithoutReport(line) ? `exit ${line.exit}, no report` : `exit ${line.exit}`
}

function succeeded(line: TaskLine): boolean {
  return line.exit === 0 && !exitedWithoutReport(line)
}

export async function runShift(argv: string[], deps: ShiftDeps): Promise<number> {
  if (argv.includes('--help')) {
    deps.out(USAGE)
    return 0
  }
  const check = argv.includes('--check')
  const rest = argv.filter(arg => arg !== '--check')
  if (rest.length !== 1 || rest[0]!.startsWith('-'))
    return refuse(deps, [USAGE.split('\n')[0]!])
  const dir = path.resolve(deps.cwd, rest[0]!)
  const journal = path.join(dir, SHIFT_JOURNAL)
  if (deps.exists(journal))
    return refuse(deps, [`${journal} exists: this shift already ran; start a new one in a new directory`])
  const { tasks, errors } = readTasks(deps, dir)
  if (errors.length > 0)
    return refuse(deps, errors)
  if (tasks.length === 0)
    return refuse(deps, [`no NN.md task file in ${dir}`])
  const conflicts = taskConflicts(tasks)
  if (conflicts.length > 0)
    return refuse(deps, ['tasks of one shift declare overlapping touches; nothing started', ...conflicts])
  warnOpenPrs(deps, tasks)
  if (check) {
    deps.out(`${PREFIX}check passed: ${tasks.map(task => task.file).join(', ')}`)
    return 0
  }
  const claude = deps.claude?.trim() ?? ''
  if (claude === '')
    return refuse(deps, [`${CLAUDE_VARIABLE} is not set; it names the claude command (see --help)`])
  deps.append(journal, `${JSON.stringify({ event: 'start', at: deps.now().toISOString(), tasks: tasks.map(task => task.file) })}\n`)
  let clean = true
  for (const task of tasks) {
    deps.out(`${PREFIX}${task.file} ${task.id} on ${task.branch}: starting`)
    const line = await runTask(deps, dir, task, claude)
    deps.append(journal, `${JSON.stringify(line)}\n`)
    deps.out(`${PREFIX}${task.file} ${task.id}: ${outcome(line)}`)
    clean &&= succeeded(line)
  }
  deps.out(`${PREFIX}shift over; pnpm shift:report ${dir}`)
  return clean ? 0 : 1
}

function realDeps(): ShiftDeps {
  return {
    cwd: process.cwd(),
    claude: process.env[CLAUDE_VARIABLE],
    header: readFileSync(path.join(import.meta.dirname, 'header.md'), 'utf8'),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    gh: execGh,
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    uuid: randomUUID,
    run: runClaude,
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runShift(process.argv.slice(2), realDeps())
