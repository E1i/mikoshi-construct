import type { ShiftTask } from '../../src/card/task-file.js'
import type { SignalStyle } from '../../src/ui/signal.js'
import type { GhRunner } from '../board/gh.js'
import type { TaskStartDeps } from '../ghosts/task-start.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import type { ExitReason, SessionEvidence } from './continuation.js'
import type { MergeResult } from './merge.js'
import type { OpenPr } from './overlap.js'
import type { Choice } from './parking.js'
import type { TaskLine } from './places.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedTasks } from '../../src/card/closed.js'
import { cardTerms } from '../../src/card/grammar.js'
import { parseParkingFile, SHIFT_WHO } from '../../src/card/parking.js'
import { parseTaskFile, TASK_FILE } from '../../src/card/task-file.js'
import { cheapClass, claudeProjectsDir } from '../../src/commands/cost/index.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { cheapExpect } from '../ghosts/cheap-expect.js'
import { pnpmInstall, runTaskStart } from '../ghosts/task-start.js'
import { CLAUDE_VARIABLE, runClaude } from './claude.js'
import { continues, eddiesEvidence, exitReason, MAX_RESTARTS, QUESTION_LINE } from './continuation.js'
import { PREFIX as MERGE_PREFIX, OWNER_MERGES_ON_MAIN, runMerge } from './merge.js'
import { openPrWarnings, taskConflicts } from './overlap.js'
import { choose, isClosed, leftLine, leftSummary, QUEUE_FILE, queueText } from './parking.js'
import { eddiesJournalPath, exitedWithoutReport, GHOST_JOURNAL, logPath, REPO, reportPath, SHIFT_JOURNAL, succeeded } from './places.js'
import { continuationBody, renderPrompt } from './prompt.js'

export const PREFIX = '[shift] '
const REPORT_PR_LINE = /^PR #(\d+)\s*$/m
export const USAGE = [
  'usage: pnpm shift <dir> [--parking <parking>] [--check] [--queue]',
  '',
  'Runs every NN.md in <dir> in order, each as a fresh headless claude session in its own tree cut by task:start.',
  `With --parking, the tasks come from <parking>/<id>.md instead: the same header plus who: and an optional priority: p0.`,
  `The shift takes every card with who: ${SHIFT_WHO} whose depends are closed in the journal and which is not closed itself,`,
  'p0 first, then by id, and leaves a card whose touches overlap one already taken; <dir> keeps the journal and the reports.',
  `It prints the cards it takes and one line counting the cards it leaves by reason; the full list goes to <dir>/${QUEUE_FILE}, and --queue prints it without the closed cards.`,
  'A task file starts with a header and a blank line, then the prompt:',
  '  card: #<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>',
  '  branch: <branch>',
  '  touches: <path>, <dir>/**',
  '  continue: auto | stop   (optional, default stop)',
  `With continue: auto, a session that leaves on an Eddies warn while its task is open is followed by a new session in the same tree that reads the handoff and goes on, at most ${MAX_RESTARTS} times.`,
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
  projectsDir: string
  git: TaskStartDeps['git']
  install: TaskStartDeps['install']
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
  style?: SignalStyle
}

function refuse(deps: ShiftDeps, lines: string[]): number {
  for (const line of lines)
    deps.err(`${PREFIX}${line}`)
  return 1
}

function taskFiles(deps: ShiftDeps, dir: string): string[] {
  return deps.listDir(dir).filter(file => TASK_FILE.test(file)).sort((a, b) => Number(TASK_FILE.exec(a)![1]) - Number(TASK_FILE.exec(b)![1]) || a.localeCompare(b))
}

function readTasks(deps: ShiftDeps, dir: string): { tasks: ShiftTask[], errors: string[] } {
  const parsed = taskFiles(deps, dir).map(file => parseTaskFile(file, deps.read(path.join(dir, file))))
  return {
    tasks: parsed.flatMap(entry => entry.kind === 'task' ? [entry.task] : []),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

function readParking(deps: ShiftDeps, parking: string): { choice: Choice, errors: string[] } {
  const parsed = taskFiles(deps, parking).map(file => parseParkingFile(file, deps.read(path.join(parking, file))))
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  const closed = new Set(closedTasks(deps.exists(journal) ? deps.read(journal) : null).keys())
  return {
    choice: choose(parsed.flatMap(entry => entry.kind === 'parked' ? [entry.parked] : []), closed),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

function choiceLines(choice: Choice, queue: boolean): string[] {
  const taken = choice.chosen.length === 0 ? 'none' : choice.chosen.map(task => `#${task.id}`).join(', ')
  const listed = queue ? choice.left.filter(card => !isClosed(card)).map(card => `${PREFIX}parking: ${leftLine(card)}`) : []
  return [`${PREFIX}parking: takes ${taken}`, `${PREFIX}parking: ${leftSummary(choice.left)}`, ...listed]
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

function sessionEvidence(deps: ShiftDeps, dir: string, task: ShiftTask, worktree: string, session: string, exit: number | null): SessionEvidence {
  const readIfThere = (file: string): string => deps.exists(file) ? deps.read(file) : ''
  return {
    exit,
    closed: closedTasks(readIfThere(path.join(deps.handoffDir, GHOST_JOURNAL))).has(task.id),
    question: QUESTION_LINE.test(readIfThere(reportPath(dir, task.number))),
    ...eddiesEvidence(readIfThere(eddiesJournalPath(worktree)), session),
  }
}

type ShiftTaskLine = TaskLine & { merge?: string[] }

function mergeAfterSession(deps: ShiftDeps, number: string): string[] {
  let result: MergeResult
  try {
    result = runMerge([number], {
      gh: deps.gh,
      ownerMergesText: () => {
        deps.git(deps.cwd, ['fetch', 'origin', 'main'])
        return deps.git(deps.cwd, ['show', OWNER_MERGES_ON_MAIN])
      },
    })
  }
  catch (error) {
    return [`${MERGE_PREFIX}PR #${number} not merged: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]!}`]
  }
  return [...result.stdout, ...result.stderr]
}

function mergeFromReport(deps: ShiftDeps, task: ShiftTask, report: string): string[] | undefined {
  if (task.card.kind === 'probe')
    return undefined
  const pr = REPORT_PR_LINE.exec(deps.read(report))
  if (pr === null)
    return undefined
  const lines = mergeAfterSession(deps, pr[1]!)
  deps.append(report, `\n${lines.join('\n')}\n`)
  for (const line of lines)
    deps.out(line)
  return lines
}

async function runTask(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string): Promise<ShiftTaskLine> {
  const session = deps.uuid()
  const started = deps.now().toISOString()
  const base = { event: 'task' as const, file: task.file, number: task.number, task: task.id, card: task.card, branch: task.branch, session, started }
  const start = runTaskStart([task.branch, '--card', task.card.line], { cwd: deps.cwd, git: deps.git, install: deps.install, exists: deps.exists, append: deps.append, now: deps.now, session, handoffDir: deps.handoffDir })
  if (start.exitCode !== 0 || start.worktree === undefined)
    return { ...base, worktree: null, ended: deps.now().toISOString(), exit: null, signal: null, refused: start.stderr.join(' ') }
  const worktree = start.worktree
  const places = { worktree, report: reportPath(dir, task.number) }
  const continuations: string[] = []
  let current = session
  let exit = await deps.run({ command: claude, cwd: worktree, sessionId: session, prompt: renderPrompt(deps.header, task, places), log: logPath(dir, task.number) })
  let lastExit: ExitReason = 'ended'
  while (exit.kind === 'exited') {
    lastExit = exitReason(sessionEvidence(deps, dir, task, worktree, current, exit.signal === null ? exit.code : null))
    if (!continues(task.continue, lastExit, continuations.length))
      break
    current = deps.uuid()
    continuations.push(current)
    deps.out(`${PREFIX}${task.file} ${task.id}: eddies warn, restart ${continuations.length}/${MAX_RESTARTS} in ${worktree}`)
    const prompt = renderPrompt(deps.header, { ...task, body: continuationBody(task, places) }, places)
    exit = await deps.run({ command: claude, cwd: worktree, sessionId: current, prompt, log: logPath(dir, task.number, continuations.length) })
  }
  const ended = deps.now().toISOString()
  if (exit.kind === 'unspawnable')
    return { ...base, worktree, ended, exit: null, signal: null, continuations, error: exit.error }
  const report = deps.exists(places.report)
  const merge = report ? mergeFromReport(deps, task, places.report) : undefined
  return { ...base, worktree, ended, exit: exit.code, signal: exit.signal, report, continuations, lastExit, ...(merge === undefined ? {} : { merge }) }
}

function startBlock(task: ShiftTask, expected: string, style: SignalStyle): string[] {
  return renderSignal(`shift ${task.file} #${task.id} ${task.card.name}`, {
    CONTRACT: `${cardTerms(task.card)} · touches ${task.touches.join(', ')} · law not recorded in the task file`,
    EXPECT: expected,
    ACTION: `task:start ${task.branch} #${task.id}, then a headless claude session in its tree`,
    RESULT: `— running; the outcome line ${PREFIX}${task.file} ${task.id}: … follows`,
  }, style)
}

function outcome(line: TaskLine): string {
  if (line.refused !== undefined)
    return `not started: ${line.refused}`
  if (line.error !== undefined)
    return `not spawned: ${line.error}`
  if (line.signal !== null)
    return `signal ${line.signal}`
  const exit = exitedWithoutReport(line) ? `exit ${line.exit}, no report` : `exit ${line.exit}`
  const restarts = line.continuations?.length ?? 0
  return restarts === 0 ? exit : `${exit}, ${restarts} ${restarts === 1 ? 'restart' : 'restarts'}`
}

export async function runShift(argv: string[], deps: ShiftDeps): Promise<number> {
  if (argv.includes('--help')) {
    deps.out(USAGE)
    return 0
  }
  const check = argv.includes('--check')
  const queue = argv.includes('--queue')
  const parkingAt = argv.indexOf('--parking')
  const parkingArg = parkingAt === -1 ? undefined : argv[parkingAt + 1]
  const rest = argv.filter((arg, index) => arg !== '--check' && arg !== '--queue' && (parkingAt === -1 || (index !== parkingAt && index !== parkingAt + 1)))
  if (rest.length !== 1 || rest[0]!.startsWith('-') || (parkingAt !== -1 && (parkingArg === undefined || parkingArg.startsWith('-'))))
    return refuse(deps, [USAGE.split('\n')[0]!])
  const dir = path.resolve(deps.cwd, rest[0]!)
  const journal = path.join(dir, SHIFT_JOURNAL)
  if (deps.exists(journal))
    return refuse(deps, [`${journal} exists: this shift already ran; start a new one in a new directory`])
  const parking = parkingArg === undefined ? undefined : path.resolve(deps.cwd, parkingArg)
  const read = parking === undefined ? { ...readTasks(deps, dir), choice: undefined } : readParking(deps, parking)
  const { errors } = read
  if (errors.length > 0)
    return refuse(deps, errors)
  if (read.choice !== undefined) {
    for (const line of choiceLines(read.choice, queue))
      deps.out(line)
  }
  const tasks = read.choice?.chosen ?? ('tasks' in read ? read.tasks : [])
  if (tasks.length === 0)
    return refuse(deps, [parking === undefined ? `no NN.md task file in ${dir}` : `no card in ${parking} is for the shift now`])
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
  const parked = read.choice === undefined ? {} : { parking, left: read.choice.left }
  if (read.choice !== undefined)
    deps.append(path.join(dir, QUEUE_FILE), queueText(read.choice.left))
  deps.append(journal, `${JSON.stringify({ event: 'start', at: deps.now().toISOString(), tasks: tasks.map(task => task.file), ...parked })}\n`)
  let clean = true
  for (const task of tasks) {
    for (const line of startBlock(task, cheapExpect(path.dirname(dir), path.join(deps.handoffDir, GHOST_JOURNAL), cheapClass(task.card), deps.projectsDir), deps.style ?? PLAIN_STYLE))
      deps.out(line)
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
    projectsDir: claudeProjectsDir(),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    install: pnpmInstall,
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
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runShift(process.argv.slice(2), realDeps())
