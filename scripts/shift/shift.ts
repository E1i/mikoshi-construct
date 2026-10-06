import type { ShiftTask } from '../../src/card/task-file.js'
import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { GhRunner } from '../board/gh.js'
import type { TaskStartDeps, TaskStartJournalReader } from '../ghosts/task-start.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import type { ExitReason, SessionEvidence } from './continuation.js'
import type { MergeResult } from './merge.js'
import type { OpenPr } from './overlap.js'
import type { Choice, Stop } from './parking.js'
import type { TaskLine } from './places.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { closedTasks, mergedTasks } from '../../src/card/closed.js'
import { cardTerms } from '../../src/card/grammar.js'
import { parseParkingFile, SHIFT_WHO } from '../../src/card/parking.js'
import { parseTaskFile, TASK_FILE } from '../../src/card/task-file.js'
import { cheapClass, claudeProjectsDir } from '../../src/commands/cost/index.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { cheapExpect } from '../ghosts/cheap-expect.js'
import { PREFIX as CLOSE_PREFIX, runTaskClose } from '../ghosts/task-close.js'
import { MERGED_FILE, mergedDetails, mergedSummary, recordMerges } from '../ghosts/task-merged.js'
import { pnpmInstall, readJournalFile, runTaskStart } from '../ghosts/task-start.js'
import { CLAUDE_VARIABLE, runClaude } from './claude.js'
import { BOUNDARY_LINE, continues, eddiesEvidence, EXIT_REASON_TEXT, exitReason, MAX_RESTARTS, QUESTION_LINE } from './continuation.js'
import { PREFIX as MERGE_PREFIX, OWNER_MERGES_ON_MAIN, runMerge } from './merge.js'
import { openPrWarnings, taskConflicts } from './overlap.js'
import { choose, isClosed, LADDER_REASON, latestStops, leftLine, leftSummary, QUEUE_FILE, queueText, standingStops } from './parking.js'
import { eddiesJournalPath, exitedWithoutReport, GHOST_JOURNAL, logPath, REPO, reportPath, SHIFT_JOURNAL, succeeded } from './places.js'
import { continuationBody, renderPrompt } from './prompt.js'

export const PREFIX = '[shift] '
const REPORT_PR_LINE = /^PR #(\d+)\s*$/m
const REPORT_VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m
const REPORT_FILE_LINE = /(?:^Report:|report written to)\s+`?([^`\s]+?)`?[.,;]?\s*$/im
export const USAGE = [
  'usage: pnpm shift <dir> [--parking <parking>] [--check] [--queue]',
  '  [--manual]  (optional: no automation; every take and every continuation asks first)',
  '',
  'Runs every NN.md in <dir> in order, each as a fresh headless claude session in its own tree cut by task:start.',
  `With --parking, the tasks come from <parking>/<id>.md instead: the same header plus who: and an optional priority: p0.`,
  `The shift takes every card with who: ${SHIFT_WHO} whose depends are merged in the journal and which is not closed itself,`,
  'p0 first, then by id, and leaves a card whose touches overlap one already taken; <dir> keeps the journal and the reports.',
  `It prints the cards it takes and one line counting the cards it leaves by reason; the full list goes to <dir>/${QUEUE_FILE}, and --queue prints it without the closed cards.`,
  'A task file starts with a header and a blank line, then the prompt:',
  '  card: #<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>',
  '  branch: <branch>',
  '  touches: <path>, <dir>/**',
  '  continue: auto | stop   (optional, default stop)',
  `With continue: auto, a session that leaves on an Eddies warn, or exits 0 at a boundary its report names with a boundary: line, while its task is open is followed by a new session in the same tree that reads the handoff and goes on, at most ${MAX_RESTARTS} times.`,
  '',
  'Recommended layout: one directory per shift, e.g. ~/.construct/shift/2026-10-03-1500/.',
  `${CLAUDE_VARIABLE} is the claude command, without caffeinate, e.g.:`,
  `  ${CLAUDE_VARIABLE}='GH_TOKEN=$(gh auth token --user E1i) claude --permission-mode auto'`,
  'Keep the Mac awake for the whole runner, not only for each claude session, or it sleeps between tasks:',
  '  caffeinate -dis pnpm shift <dir>',
  `A real shift records merged pull requests as merge lines before it chooses and once after its last task, prints one merged line each time and the details to <dir>/${MERGED_FILE};`,
  'a pull request without a card, or closed without merge, is recorded as a merge-skip line and not looked up again.',
  '--check parses the tasks and checks touches against each other and the open pull requests, records no merge line, and starts nothing.',
  'The shift is an autopilot by default: it takes the next ready card, follows a session into a new one at a boundary the card allows, arms auto-merge where the merge rules allow it,',
  'and stops only at a gate the owner holds, writing one event:stop line to ghosts.jsonl (at: hash, merge, question, boundary or fault, and why).',
  'A ladder card is never taken: it is left, with a stop at hash. A card whose latest stop still stands (its tree exists) is left as waits <at>.',
  '--manual turns the automation off for this run only: nothing is taken and nothing is continued without a yes from the prompt; with no terminal every answer is no.',
  'Every real run writes one event:autopilot line (state on or off) to <dir>/shift.jsonl, right after its start line and before it takes its first card.',
  'Afterwards: pnpm shift:report <dir>.',
].join('\n')

export interface ShiftDeps {
  cwd: string
  claude: string | undefined
  header: string
  handoffDir: string
  readJournal: TaskStartJournalReader
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
  confirm?: (question: string) => Promise<boolean>
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
  const text = deps.exists(journal) ? deps.read(journal) : null
  const done = new Set(closedTasks(text).keys())
  return {
    choice: choose(parsed.flatMap(entry => entry.kind === 'parked' ? [entry.parked] : []), done, mergedTasks(text), standingStops(latestStops(text), deps.exists)),
    errors: parsed.flatMap(entry => entry.kind === 'refused' ? [entry.reason] : []),
  }
}

const MERGE_HINT = `${PREFIX}hint: depends are met by merge lines; run pnpm task:merged to record merged pull requests`

function sweepMerges(deps: ShiftDeps, journal: string, dir: string): void {
  try {
    const result = recordMerges({ gh: deps.gh, journal, readJournal: deps.readJournal, append: deps.append, now: deps.now })
    const summary = mergedSummary(result)
    if (summary === null)
      return
    deps.append(path.join(dir, MERGED_FILE), mergedDetails(result).map(line => `${line}\n`).join(''))
    deps.err(`${PREFIX}${summary}; details in ${path.join(dir, MERGED_FILE)}`)
  }
  catch (error) {
    deps.err(`${PREFIX}merged: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
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
  const report = readIfThere(reportPath(dir, task.number))
  return {
    exit,
    closed: closedTasks(readIfThere(path.join(deps.handoffDir, GHOST_JOURNAL))).has(task.id),
    question: QUESTION_LINE.test(report),
    boundary: BOUNDARY_LINE.test(report),
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

function notClosed(deps: ShiftDeps, task: ShiftTask, reason: string): string {
  return (deps.style ?? PLAIN_STYLE).paint('red', `${PREFIX}#${task.id} not closed: ${reason}`)
}

function closeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, text: string, outcome: ['--pr' | '--report', string]): string[] {
  const word = REPORT_VERIFICATION_LINE.exec(text)?.[1]
  if (word === undefined)
    return [notClosed(deps, task, `the report has no verification: <word> line, one of ${VERIFICATION_WORDS.join(', ')}; no closing line written`)]
  const closed = runTaskClose([task.id, ...outcome, '--verification', word], {
    cwd: session.worktree,
    read: file => deps.exists(file) ? deps.read(file) : null,
    append: deps.append,
    now: deps.now,
    handoffDir: deps.handoffDir,
    exists: deps.exists,
    session: session.id,
    projectsDir: deps.projectsDir,
    style: deps.style,
  })
  return closed.exitCode === 0 ? closed.stdout : closed.stderr.map(line => notClosed(deps, task, line.slice(CLOSE_PREFIX.length)))
}

function closeProbeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, text: string): void {
  const written = REPORT_FILE_LINE.exec(text)?.[1]
  const lines = written === undefined
    ? [notClosed(deps, task, 'the probe report has no Report: <path> line; no closing line written')]
    : closeFromReport(deps, task, session, text, ['--report', written])
  for (const line of lines)
    deps.out(line)
}

function mergeFromReport(deps: ShiftDeps, task: ShiftTask, session: { worktree: string, id: string }, report: string): { pr: string, lines: string[] } | undefined {
  const text = deps.read(report)
  if (task.card.kind === 'probe') {
    closeProbeFromReport(deps, task, session, text)
    return undefined
  }
  const pr = REPORT_PR_LINE.exec(text)
  if (pr === null)
    return undefined
  for (const line of closeFromReport(deps, task, session, text, ['--pr', pr[1]!]))
    deps.out(line)
  const lines = mergeAfterSession(deps, pr[1]!)
  deps.append(report, `\n${lines.join('\n')}\n`)
  for (const line of lines)
    deps.out(line)
  return { pr: pr[1]!, lines }
}

interface StopRecord {
  at: Stop['at']
  why: string
  worktree: string | null
  session: string | null
  pr?: number
}

const MERGE_ARMED = /auto-merge armed on PR #\d+/
const QUESTION_TEXT = /^question:[ \t]*(\S.*)$/m

async function confirmed(deps: ShiftDeps, question: string): Promise<boolean> {
  try {
    return deps.confirm === undefined ? false : await deps.confirm(question)
  }
  catch {
    return false
  }
}

async function takeAllowed(deps: ShiftDeps, task: ShiftTask, manual: boolean): Promise<boolean> {
  return !manual || await confirmed(deps, `take #${task.id} ${task.card.name} (${task.card.contour}/${task.card.decision})?`)
}

async function continueAllowed(deps: ShiftDeps, task: ShiftTask, reason: ExitReason, manual: boolean): Promise<boolean> {
  return !manual || await confirmed(deps, `continue #${task.id} in a new session (${EXIT_REASON_TEXT[reason]})?`)
}

function autopilotLine(deps: ShiftDeps, dir: string, manual: boolean): string {
  return `${JSON.stringify({ event: 'autopilot', state: manual ? 'off' : 'on', shift: dir, ts: deps.now().toISOString() })}\n`
}

function recordStop(deps: ShiftDeps, dir: string, task: string, stop: StopRecord): void {
  const line = { event: 'stop', task, at: stop.at, why: stop.why, worktree: stop.worktree, shift: dir, session: stop.session, ts: deps.now().toISOString(), ...(stop.pr === undefined ? {} : { pr: stop.pr }) }
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify(line)}\n`)
}

function boundaryWhy(task: ShiftTask, reason: ExitReason, restarts: number): string | null {
  if (reason !== 'boundary' && reason !== 'eddies-warn')
    return null
  return task.continue === 'stop' ? `${EXIT_REASON_TEXT[reason]}; the card says continue: stop` : `${EXIT_REASON_TEXT[reason]}; ${restarts} of ${MAX_RESTARTS} restarts used`
}

interface Finish {
  reason: ExitReason
  halted: string | null
  exit: Extract<ClaudeExit, { kind: 'exited' }>
  report: string | null
  merge: { pr: string, lines: string[] } | undefined
  closed: boolean
}

function stopAfter(task: ShiftTask, where: { worktree: string, session: string }, finish: Finish): StopRecord | null {
  const at = (kind: Stop['at'], why: string, pr?: number): StopRecord => ({ at: kind, why, ...where, ...(pr === undefined ? {} : { pr }) })
  const { reason, halted, exit, report, merge } = finish
  if (reason === 'owner-question')
    return at('question', QUESTION_TEXT.exec(report ?? '')?.[1]?.trim() || EXIT_REASON_TEXT[reason])
  if (merge?.lines.some(line => MERGE_ARMED.test(line)))
    return null
  if (halted !== null)
    return at('boundary', halted)
  if (reason === 'eddies-stop' || reason === 'guard-refusal')
    return at('fault', EXIT_REASON_TEXT[reason])
  if (exit.signal !== null || exit.code !== 0)
    return at('fault', exit.signal === null ? `exit ${exit.code}` : `signal ${exit.signal}`)
  if (merge !== undefined)
    return at('merge', merge.lines.map(line => line.replace(MERGE_PREFIX, '')).join('; '), Number(merge.pr))
  if (finish.closed)
    return null
  return at('fault', report === null ? 'exited 0 without a report' : task.card.kind === 'probe' ? 'the probe report closed no task' : 'the report names no pull request')
}

async function runTask(deps: ShiftDeps, dir: string, task: ShiftTask, claude: string, handed: Pick<Signal, 'CONTRACT' | 'EXPECT'>, manual: boolean): Promise<{ line: ShiftTaskLine, stop: StopRecord | null }> {
  const session = deps.uuid()
  const started = deps.now().toISOString()
  const base = { event: 'task' as const, file: task.file, number: task.number, task: task.id, card: task.card, branch: task.branch, session, started }
  const start = runTaskStart([task.branch, '--card', task.card.line], { cwd: deps.cwd, git: deps.git, install: deps.install, exists: deps.exists, append: deps.append, now: deps.now, session, handoffDir: deps.handoffDir, readJournal: deps.readJournal }, handed)
  if (start.exitCode !== 0 || start.worktree === undefined) {
    return { line: { ...base, worktree: null, ended: deps.now().toISOString(), exit: null, signal: null, refused: start.stderr.join(' ') }, stop: null }
  }
  const worktree = start.worktree
  const places = { worktree, report: reportPath(dir, task.number) }
  const continuations: string[] = []
  let current = session
  let exit = await deps.run({ command: claude, cwd: worktree, sessionId: session, prompt: renderPrompt(deps.header, task, places), log: logPath(dir, task.number) })
  let lastExit: ExitReason = 'ended'
  let halted: string | null = null
  while (exit.kind === 'exited') {
    lastExit = exitReason(sessionEvidence(deps, dir, task, worktree, current, exit.signal === null ? exit.code : null))
    halted = boundaryWhy(task, lastExit, continuations.length)
    if (!continues(task.continue, lastExit, continuations.length))
      break
    if (!(await continueAllowed(deps, task, lastExit, manual))) {
      halted = `${EXIT_REASON_TEXT[lastExit]}; continuing was not confirmed (--manual)`
      break
    }
    current = deps.uuid()
    continuations.push(current)
    deps.out(`${PREFIX}${task.file} ${task.id}: ${EXIT_REASON_TEXT[lastExit]}, restart ${continuations.length}/${MAX_RESTARTS} in ${worktree}`)
    const prompt = renderPrompt(deps.header, { ...task, body: continuationBody(task, places) }, places)
    exit = await deps.run({ command: claude, cwd: worktree, sessionId: current, prompt, log: logPath(dir, task.number, continuations.length) })
  }
  const ended = deps.now().toISOString()
  if (exit.kind === 'unspawnable')
    return { line: { ...base, worktree, ended, exit: null, signal: null, continuations, error: exit.error }, stop: { at: 'fault', why: `claude not spawned: ${exit.error}`, worktree, session: current } }
  const report = deps.exists(places.report)
  const merge = report ? mergeFromReport(deps, task, { worktree, id: current }, places.report) : undefined
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  const closed = deps.exists(journal) && closedTasks(deps.read(journal)).has(task.id)
  const line = { ...base, worktree, ended, exit: exit.code, signal: exit.signal, report, continuations, lastExit, ...(merge === undefined ? {} : { merge: merge.lines }) }
  return { line, stop: stopAfter(task, { worktree, session: current }, { reason: lastExit, halted, exit, report: report ? deps.read(places.report) : null, merge, closed }) }
}

function startContract(task: ShiftTask, expected: string): Pick<Signal, 'CONTRACT' | 'EXPECT'> {
  return {
    CONTRACT: `${cardTerms(task.card)} · touches ${task.touches.join(', ')} · law not recorded in the task file`,
    EXPECT: expected,
  }
}

function startBlock(task: ShiftTask, handed: Pick<Signal, 'CONTRACT' | 'EXPECT'>, style: SignalStyle): string[] {
  return renderSignal(`shift ${task.file} #${task.id} ${task.card.name}`, {
    ...handed,
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
  const manual = argv.includes('--manual')
  const parkingAt = argv.indexOf('--parking')
  const parkingArg = parkingAt === -1 ? undefined : argv[parkingAt + 1]
  const rest = argv.filter((arg, index) => arg !== '--check' && arg !== '--queue' && arg !== '--manual' && (parkingAt === -1 || (index !== parkingAt && index !== parkingAt + 1)))
  if (rest.length !== 1 || rest[0]!.startsWith('-') || (parkingAt !== -1 && (parkingArg === undefined || parkingArg.startsWith('-'))))
    return refuse(deps, [USAGE.split('\n')[0]!])
  const dir = path.resolve(deps.cwd, rest[0]!)
  const journal = path.join(dir, SHIFT_JOURNAL)
  if (deps.exists(journal))
    return refuse(deps, [`${journal} exists: this shift already ran; start a new one in a new directory`])
  const parking = parkingArg === undefined ? undefined : path.resolve(deps.cwd, parkingArg)
  const ghostJournal = path.join(deps.handoffDir, GHOST_JOURNAL)
  if (parking !== undefined && !check)
    sweepMerges(deps, ghostJournal, dir)
  const read = parking === undefined ? { ...readTasks(deps, dir), choice: undefined } : readParking(deps, parking)
  const { errors } = read
  if (errors.length > 0)
    return refuse(deps, errors)
  if (read.choice !== undefined && !check) {
    for (const card of read.choice.left.filter(left => left.reason === LADDER_REASON))
      recordStop(deps, dir, card.id, { at: 'hash', why: `a ladder card: the shift has no ladder route and the brief's hash is the owner's`, worktree: null, session: null })
  }
  if (read.choice !== undefined) {
    for (const line of choiceLines(read.choice, queue))
      deps.out(line)
    if (check && read.choice.left.some(card => card.reason.startsWith('depends ')))
      deps.out(MERGE_HINT)
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
  deps.append(journal, autopilotLine(deps, dir, manual))
  let clean = true
  for (const task of tasks) {
    const handed = startContract(task, cheapExpect(path.dirname(dir), path.join(deps.handoffDir, GHOST_JOURNAL), cheapClass(task.card), deps.projectsDir))
    if (!(await takeAllowed(deps, task, manual))) {
      deps.out(`${PREFIX}${task.file} ${task.id}: not taken, not confirmed (--manual)`)
      continue
    }
    for (const line of startBlock(task, handed, deps.style ?? PLAIN_STYLE))
      deps.out(line)
    const { line, stop } = await runTask(deps, dir, task, claude, handed, manual)
    deps.append(journal, `${JSON.stringify(line)}\n`)
    if (stop !== null)
      recordStop(deps, dir, task.id, stop)
    deps.out(`${PREFIX}${task.file} ${task.id}: ${outcome(line)}`)
    clean &&= succeeded(line)
  }
  if (parking !== undefined)
    sweepMerges(deps, ghostJournal, dir)
  deps.out(`${PREFIX}shift over; pnpm shift:report ${dir}`)
  return clean ? 0 : 1
}

async function askOnTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/i.test((await terminal.question(`${PREFIX}${question} [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

function realDeps(): ShiftDeps {
  return {
    cwd: process.cwd(),
    claude: process.env[CLAUDE_VARIABLE],
    header: readFileSync(path.join(import.meta.dirname, 'header.md'), 'utf8'),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    readJournal: readJournalFile,
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
    confirm: process.stdin.isTTY ? askOnTerminal : undefined,
    run: runClaude,
    out: line => console.log(line),
    err: line => console.error(line),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runShift(process.argv.slice(2), realDeps())
