import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { StepExpect } from './expect-sample.js'
import type { Expect } from './expect.js'
import type { JournalEntry } from './journal.js'
import type { MatrixLookup } from './matrix.js'
import type { Sketch } from './sketch.js'
import type { Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { LEDGER_FILE } from '../../src/commands/cost/ledger.js'
import { renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { writeAgreedText } from './agreed.js'
import { checkApproval } from './approval.js'
import { tiedArgsSha256 } from './args-chain.js'
import { ENTRY_RESULT, entryEvent } from './entry.js'
import { launchStepExpects } from './expect-sample.js'
import { briefEffort, formatExpect, formatStepBreakdown, parseExpect } from './expect.js'
import { runInstall } from './install.js'
import { appendJournalEvent, appendJournalLine } from './journal.js'
import { carryLedgerLines, countLedgerLines, readLadderOutcome } from './ledger.js'
import { lookupMatrixRow } from './matrix.js'
import { readResultFields } from './result.js'
import { spawnSession } from './session.js'
import { describeSketch, parseSketch } from './sketch.js'
import { freeRow, ghostRowState, installFailedOutcome, installUnspawnableOutcome, sessionOutcome, sessionUnspawnableOutcome, writeGhostRow, writingRow } from './status.js'
import { readTasksFile } from './tasks.js'

interface PreparedTask extends Task {
  approvedText: string
  approvedSha256: string
  sketch: Sketch
  expected: Expect | null
  stepsExpected: StepExpect[]
  sessionId: string
  reportPath: string
  stderrPath: string
}

interface TaskContext {
  repo: string
  statusPath: string
  journalPath: string
  baseSha: string
  out: string
  matrixPath: string | undefined
}

interface TaskOutcome {
  id: string
  line: string
  ok: boolean
}

function timestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

function sketchRefusals(repo: string, taskId: string, baseSha: string, sketch: Sketch): string[] {
  if (sketch.kind === 'none')
    return []
  if (!branchExists(repo, sketch.branch))
    return [`task ${taskId}: sketch branch ${sketch.branch} does not exist in ${repo}`]
  const tip = git(repo, ['rev-parse', `refs/heads/${sketch.branch}`])
  if (tip !== sketch.sha)
    return [`task ${taskId}: sketch branch ${sketch.branch} is at ${tip}, not the approved ${sketch.sha}`]
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', baseSha, sketch.sha], { stdio: 'pipe' })
  }
  catch {
    return [`task ${taskId}: sketch ${sketch.sha.slice(0, 7)} does not contain origin/main ${baseSha.slice(0, 7)}; rebase ${sketch.branch} onto origin/main and re-approve the brief`]
  }
  return []
}

function parseArgs(argv: string[]): { tasksFile: string } {
  const index = argv.indexOf('--tasks')
  if (index === -1 || index === argv.length - 1)
    throw new Error('usage: launch.ts --tasks <file>')
  return { tasksFile: argv[index + 1] }
}

function readLine(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    let answered = false
    rl.on('line', (line) => {
      if (!answered) {
        answered = true
        rl.close()
        resolve(line)
      }
    })
    rl.on('close', () => {
      if (!answered)
        resolve(undefined)
    })
  })
}

function tasksFileRefusals(out: string, matrixPath: string | undefined, tasks: Task[]): string[] {
  const refusals: string[] = []
  if (!path.isAbsolute(out))
    refusals.push(`tasks file field out: expected an absolute path, got '${out}'`)
  try {
    for (const task of tasks)
      lookupMatrixRow(matrixPath, task.id)
  }
  catch (error) {
    refusals.push(`matrix ${matrixPath}: ${errorMessage(error)}`)
  }
  return refusals
}

async function prepareAndPreflight(repo: string, statusPath: string, out: string, matrixPath: string | undefined, tasks: Task[]): Promise<{ baseSha: string, prepared: PreparedTask[], refusals: string[] }> {
  const refusals = tasksFileRefusals(out, matrixPath, tasks)

  git(repo, ['fetch', 'origin', 'main'])
  const baseSha = git(repo, ['rev-parse', 'origin/main'])

  const statusText = existsSync(statusPath) ? await readFile(statusPath, 'utf8') : undefined
  const prepared: PreparedTask[] = []

  for (const task of tasks) {
    const approval = checkApproval(task.brief)
    if (!approval.ok) {
      refusals.push(`task ${task.id}: ${approval.reason}`)
      continue
    }

    let sketch: Sketch
    try {
      sketch = parseSketch(approval.text)
    }
    catch (error) {
      refusals.push(`task ${task.id}: ${task.brief}: ${errorMessage(error)}`)
      continue
    }
    refusals.push(...sketchRefusals(repo, task.id, baseSha, sketch))

    let expected: Expect | null
    try {
      expected = parseExpect(approval.text)
    }
    catch (error) {
      refusals.push(`task ${task.id}: ${task.brief}: ${errorMessage(error)}`)
      continue
    }

    if (existsSync(task.worktree))
      refusals.push(`task ${task.id}: worktree already exists at ${task.worktree}`)

    if (branchExists(repo, task.branch))
      refusals.push(`task ${task.id}: branch ${task.branch} already exists`)

    if (statusText !== undefined) {
      const state = ghostRowState(statusText, task.id)
      if (state === 'writing' || state === 'reviewing')
        refusals.push(`task ${task.id}: status.md row ghost-${task.id} is busy (state ${state})`)
    }

    const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
    if (existsSync(reportPath))
      refusals.push(`task ${task.id}: report file ${reportPath} already exists`)

    prepared.push({
      ...task,
      approvedText: approval.text,
      approvedSha256: approval.sha256,
      sketch,
      expected,
      stepsExpected: launchStepExpects(repo, briefEffort(approval.text)),
      sessionId: randomUUID(),
      reportPath,
      stderrPath: path.join(out, `ghost-${task.id}.stderr`),
    })
  }

  return { baseSha, prepared, refusals }
}

const ACCEPTANCE_LINE = /^Acceptance:/m

function signalOf(task: PreparedTask, baseSha: string): Signal {
  const approved = task.approvedSha256.slice(0, 7)
  const law = ACCEPTANCE_LINE.test(task.approvedText) ? 'law brief Acceptance:' : 'law not recorded in the brief'
  return {
    CONTRACT: `ladder · brief ${path.basename(task.brief)} approved ${approved} · ${law}`,
    EXPECT: task.expected === null ? `expect not recorded in the brief${formatStepBreakdown(task.stepsExpected)}` : formatExpect(task.expected, task.stepsExpected),
    ACTION: `${task.id}: /implement ${task.brief} (approved ${approved}) -> ${task.worktree} on ${task.branch} @ ${baseSha.slice(0, 7)} ${describeSketch(task.sketch)}, report ${task.reportPath}, session ${task.sessionId}`,
    RESULT: ENTRY_RESULT,
  }
}

function describeTask(task: PreparedTask, baseSha: string, style: SignalStyle): string[] {
  return renderSignal(`ghosts:launch ${task.id}`, signalOf(task, baseSha), style)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sketchSha(task: PreparedTask): string | null {
  return task.sketch.kind === 'branch' ? task.sketch.sha : null
}

function addWorktree(ctx: TaskContext, task: PreparedTask): void {
  if (task.sketch.kind === 'none') {
    execFileSync('git', ['-C', ctx.repo, 'worktree', 'add', '-b', task.branch, task.worktree, ctx.baseSha], { stdio: 'pipe' })
    return
  }
  execFileSync('git', ['-C', ctx.repo, 'worktree', 'add', '-b', task.branch, task.worktree, task.sketch.sha], { stdio: 'pipe' })
  execFileSync('git', ['-C', task.worktree, 'reset', '--soft', ctx.baseSha], { stdio: 'pipe' })
}

function noSessionJournalEntry(task: PreparedTask, baseSha: string, matrixRow: MatrixLookup | null, install: number | null): JournalEntry {
  return {
    task: task.id,
    baseSha,
    sketch: sketchSha(task),
    session: null,
    install,
    exit: null,
    ladder: 'no ladder run',
    run: null,
    iterations: null,
    class: matrixRow?.class ?? null,
    contour: matrixRow?.contour ?? null,
    resultLine: 'missing',
    total_cost_usd: null,
    num_turns: null,
    duration_ms: null,
    usage: null,
    agreedSha256: task.approvedSha256,
    argsSha256: null,
    expected: task.expected,
    actual: null,
  }
}

async function closeOut(ctx: TaskContext, task: PreparedTask, start: string, outcome: string, journalEntry: JournalEntry): Promise<void> {
  const headSha = git(task.worktree, ['rev-parse', 'HEAD'])
  const end = timestamp()
  await writeGhostRow(ctx.statusPath, task.id, freeRow({ id: task.id, worktree: task.worktree, headSha, start, end, outcome }))
  await appendJournalLine(ctx.journalPath, journalEntry)
}

async function launchTask(ctx: TaskContext, task: PreparedTask): Promise<TaskOutcome> {
  const start = timestamp()

  addWorktree(ctx, task)
  writeAgreedText(task.worktree, task.approvedText)

  await writeGhostRow(ctx.statusPath, task.id, writingRow({
    id: task.id,
    worktree: task.worktree,
    baseSha: ctx.baseSha,
    start,
    briefFileName: path.basename(task.brief),
    sessionId: task.sessionId,
  }))

  const runsPath = path.join(task.worktree, '.construct', 'runs.jsonl')
  const linesBefore = countLedgerLines(runsPath)
  const installLogPath = path.join(ctx.out, `ghost-${task.id}.install.log`)
  const matrixRow = lookupMatrixRow(ctx.matrixPath, task.id)

  let installCode: number
  try {
    installCode = await runInstall(task.worktree, installLogPath)
  }
  catch (error) {
    const message = errorMessage(error)
    await closeOut(ctx, task, start, installUnspawnableOutcome(message, installLogPath), noSessionJournalEntry(task, ctx.baseSha, matrixRow, null))
    return { id: task.id, line: `install failed: ${message}`, ok: false }
  }

  if (installCode !== 0) {
    await closeOut(ctx, task, start, installFailedOutcome(installCode, installLogPath), noSessionJournalEntry(task, ctx.baseSha, matrixRow, installCode))
    return { id: task.id, line: `install failed: exit ${installCode}`, ok: false }
  }

  let code: number
  try {
    code = await spawnSession({
      cwd: task.worktree,
      sessionId: task.sessionId,
      prompt: task.approvedText,
      stdoutPath: task.reportPath,
      stderrPath: task.stderrPath,
    })
  }
  catch (error) {
    const message = errorMessage(error)
    await closeOut(ctx, task, start, sessionUnspawnableOutcome(message), noSessionJournalEntry(task, ctx.baseSha, matrixRow, installCode))
    return { id: task.id, line: `session failed: ${message}`, ok: false }
  }

  const ladder = readLadderOutcome(runsPath, linesBefore)
  const carryFailure = carryIntoMainLedger(runsPath, ctx.repo)
  const resultFields = readResultFields(task.reportPath)
  const outcome = sessionOutcome(code, ladder.status, task.reportPath, task.sessionId)
  await closeOut(ctx, task, start, outcome, {
    task: task.id,
    baseSha: ctx.baseSha,
    sketch: sketchSha(task),
    session: task.sessionId,
    install: installCode,
    exit: code,
    ladder: ladder.status,
    run: ladder.run,
    iterations: ladder.iterations,
    class: matrixRow?.class ?? null,
    contour: matrixRow?.contour ?? null,
    resultLine: resultFields.resultLine,
    total_cost_usd: resultFields.total_cost_usd,
    num_turns: resultFields.num_turns,
    duration_ms: resultFields.duration_ms,
    usage: resultFields.usage,
    agreedSha256: task.approvedSha256,
    argsSha256: tiedArgsSha256(task.worktree, task.approvedSha256, ladder.argsSha256),
    expected: task.expected,
    actual: ladder.actual,
  })

  const line = `${ladder.status === 'no ladder run' ? 'no ladder run' : `ladder ${ladder.status}`}${carryFailure}`
  const ok = code === 0 && ladder.status === 'done'
  return { id: task.id, line, ok }
}

function carryIntoMainLedger(runsPath: string, repo: string): string {
  const mainLedger = path.join(repo, LEDGER_FILE)
  try {
    carryLedgerLines(runsPath, mainLedger)
    return ''
  }
  catch (error) {
    return `; ledger lines not carried into ${mainLedger}: ${errorMessage(error)}`
  }
}

async function main(): Promise<void> {
  const { tasksFile } = parseArgs(process.argv.slice(2))
  const { repo, status, out, tasks, matrix } = readTasksFile(tasksFile)

  const { baseSha, prepared, refusals } = await prepareAndPreflight(repo, status, out, matrix, tasks)

  if (refusals.length > 0) {
    for (const refusal of refusals)
      console.error(refusal)
    process.exitCode = 1
    return
  }

  console.log(`DECISION: open ${prepared.length} sessions`)
  const style = terminalStyle(process.stdout.isTTY, process.env.NO_COLOR)
  for (const task of prepared) {
    for (const line of describeTask(task, baseSha, style))
      console.log(line)
  }

  const answer = await readLine()
  if (answer !== 'yes') {
    process.exitCode = 1
    return
  }

  const journalPath = path.join(out, 'ghosts.jsonl')
  const ctx: TaskContext = { repo, statusPath: status, journalPath, baseSha, out, matrixPath: matrix }
  for (const task of prepared)
    await appendJournalEvent(journalPath, entryEvent(task.id, signalOf(task, baseSha), new Date().toISOString()))
  const results = await Promise.all(prepared.map(task => launchTask(ctx, task)))

  let allOk = true
  for (const result of results) {
    console.log(`${result.id}: ${result.line}`)
    if (!result.ok)
      allOk = false
  }

  process.exitCode = allOk ? 0 : 1
}

await main()
