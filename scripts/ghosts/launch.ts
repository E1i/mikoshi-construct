import type { JournalEntry } from './journal.js'
import type { MatrixLookup } from './matrix.js'
import type { Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { checkApproval, sha256Hex } from './approval.js'
import { runInstall } from './install.js'
import { appendJournalLine } from './journal.js'
import { countLedgerLines, readLadderOutcome } from './ledger.js'
import { lookupMatrixRow } from './matrix.js'
import { readResultFields } from './result.js'
import { spawnSession } from './session.js'
import { freeRow, ghostRowState, installFailedOutcome, installUnspawnableOutcome, sessionOutcome, sessionUnspawnableOutcome, writeGhostRow, writingRow } from './status.js'
import { readTasksFile } from './tasks.js'

interface PreparedTask extends Task {
  approvedText: string
  approvedHashShort: string
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

async function prepareAndPreflight(repo: string, statusPath: string, out: string, tasks: Task[]): Promise<{ baseSha: string, prepared: PreparedTask[], refusals: string[] }> {
  const refusals: string[] = []

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
      approvedHashShort: sha256Hex(approval.text).slice(0, 7),
      sessionId: randomUUID(),
      reportPath,
      stderrPath: path.join(out, `ghost-${task.id}.stderr`),
    })
  }

  return { baseSha, prepared, refusals }
}

function describeTask(task: PreparedTask, baseSha: string): string {
  return `  ${task.id}: /implement ${task.brief} (approved ${task.approvedHashShort}) -> ${task.worktree} on ${task.branch} @ ${baseSha.slice(0, 7)}, report ${task.reportPath}, session ${task.sessionId}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noSessionJournalEntry(task: PreparedTask, baseSha: string, matrixRow: MatrixLookup | null, install: number | null): JournalEntry {
  return {
    task: task.id,
    baseSha,
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

  execFileSync('git', ['-C', ctx.repo, 'worktree', 'add', '-b', task.branch, task.worktree, ctx.baseSha], { stdio: 'pipe' })

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
  const resultFields = readResultFields(task.reportPath)
  const outcome = sessionOutcome(code, ladder.status, task.reportPath, task.sessionId)
  await closeOut(ctx, task, start, outcome, {
    task: task.id,
    baseSha: ctx.baseSha,
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
  })

  const line = ladder.status === 'no ladder run' ? 'no ladder run' : `ladder ${ladder.status}`
  const ok = code === 0 && ladder.status === 'done'
  return { id: task.id, line, ok }
}

async function main(): Promise<void> {
  const { tasksFile } = parseArgs(process.argv.slice(2))
  const { repo, status, out, tasks, matrix } = readTasksFile(tasksFile)

  const { baseSha, prepared, refusals } = await prepareAndPreflight(repo, status, out, tasks)

  if (refusals.length > 0) {
    for (const refusal of refusals)
      console.error(refusal)
    process.exitCode = 1
    return
  }

  console.log(`DECISION: open ${prepared.length} sessions`)
  for (const task of prepared)
    console.log(describeTask(task, baseSha))

  const answer = await readLine()
  if (answer !== 'yes') {
    process.exitCode = 1
    return
  }

  const journalPath = path.join(out, 'ghosts.jsonl')
  const ctx: TaskContext = { repo, statusPath: status, journalPath, baseSha, out, matrixPath: matrix }
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
