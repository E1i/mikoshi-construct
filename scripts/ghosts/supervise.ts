import type { StepExpect } from './expect-sample.js'
import type { Expect } from './expect.js'
import type { JournalEntry, RangeDiffOutcome } from './journal.js'
import type { MatrixLookup } from './matrix.js'
import type { Sketch } from './sketch.js'
import type { StartedTree, Task } from './tasks.js'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { LEDGER_FILE } from '../../src/commands/cost/ledger.js'
import { writeAgreedText } from './agreed.js'
import { tiedArgsSha256 } from './args-chain.js'
import { runInstall } from './install.js'
import { appendJournalEvent, appendJournalLine } from './journal.js'
import { carryLedgerLines, countLedgerLines, readLadderOutcome } from './ledger.js'
import { lookupMatrixRow } from './matrix.js'
import { approvalCarryEvent, regeneratedCheckFailedOutcome, regeneratedCheckFailures } from './regenerated.js'
import { readResultFields } from './result.js'
import { spawnSession } from './session.js'
import { freeRow, installFailedOutcome, installUnspawnableOutcome, sessionOutcome, sessionUnspawnableOutcome, writeGhostRow, writingRow } from './status.js'

export interface PreparedTask extends Task, StartedTree {
  approvedText: string
  approvedSha256: string
  approvedSketch: string
  agreedSha256: string
  rangeDiff: RangeDiffOutcome | null
  regenerated: string[]
  sketch: Sketch
  expected: Expect | null
  stepsExpected: StepExpect[]
  sessionId: string
  reportPath: string
  stderrPath: string
}

export interface TaskContext {
  repo: string
  statusPath: string
  journalPath: string
  baseSha: string
  out: string
  matrixPath: string | undefined
}

export interface TaskOutcome {
  id: string
  line: string
  ok: boolean
}

function timestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

export const FALL_KINDS = ['base-red', 'ladder-not-done', 'review-hole', 'handoff-without-pr', 'hash-recounted'] as const
export type FallKind = typeof FALL_KINDS[number]

export function fallEvent(card: number, kind: FallKind): object {
  return { event: 'fall', card, kind, ts: new Date().toISOString() }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sketchSha(task: PreparedTask): string | null {
  return task.sketch.kind === 'branch' ? task.sketch.sha : null
}

function approvalFields(task: PreparedTask): Pick<JournalEntry, 'agreedSha256' | 'approvedSha256' | 'approvedSketch' | 'rangeDiff'> {
  return {
    agreedSha256: task.agreedSha256,
    approvedSha256: task.approvedSha256,
    approvedSketch: task.approvedSketch === 'none' ? null : task.approvedSketch,
    rangeDiff: task.rangeDiff,
  }
}

function prepareTree(ctx: TaskContext, task: PreparedTask): void {
  execFileSync('git', ['-C', task.worktree, 'reset', '--hard', task.sketch.kind === 'branch' ? task.sketch.sha : ctx.baseSha], { stdio: 'pipe' })
  if (task.rangeDiff !== 'regenerated')
    stageSketch(ctx, task)
}

function stageSketch(ctx: TaskContext, task: PreparedTask): void {
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
    ...approvalFields(task),
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

  prepareTree(ctx, task)
  writeAgreedText(task.worktree, task.approvedText)

  await writeGhostRow(ctx.statusPath, task.id, writingRow({
    id: task.id,
    worktree: task.worktree,
    baseSha: ctx.baseSha,
    start,
    briefFileName: path.basename(task.brief),
    supervisorPid: process.pid,
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

  if (task.rangeDiff === 'regenerated') {
    const failures = regeneratedCheckFailures(task.worktree, task.regenerated)
    if (failures.length > 0) {
      await closeOut(ctx, task, start, regeneratedCheckFailedOutcome(failures), noSessionJournalEntry(task, ctx.baseSha, matrixRow, installCode))
      return { id: task.id, line: 'regenerated check failed', ok: false }
    }
    stageSketch(ctx, task)
    await appendJournalEvent(ctx.journalPath, approvalCarryEvent(task.id, task.approvedSketch, sketchSha(task), task.regenerated, new Date()))
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
    ...approvalFields(task),
    argsSha256: tiedArgsSha256(task.worktree, task.agreedSha256, ladder.argsSha256),
    expected: task.expected,
    actual: ladder.actual,
  })

  if (ladder.status !== 'done')
    await appendJournalEvent(ctx.journalPath, fallEvent(task.card.id, 'ladder-not-done'))

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

export interface SupervisorPayload {
  ctx: TaskContext
  tasks: PreparedTask[]
}

export const SUPERVISE_PATH = fileURLToPath(import.meta.url)

export function resultPathOf(payloadPath: string): string {
  return `${payloadPath.replace(/\.json$/, '')}.result.json`
}

export function supervisorSpawnOptions(logFd: number): { detached: true, stdio: ['ignore', number, number] } {
  return { detached: true, stdio: ['ignore', logFd, logFd] }
}

export function spawnSupervisor(payloadPath: string, logPath: string): Promise<number> {
  const logFd = openSync(logPath, 'w')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, SUPERVISE_PATH, payloadPath], supervisorSpawnOptions(logFd))
    child.on('error', (error) => {
      closeSync(logFd)
      reject(error)
    })
    child.on('close', (code) => {
      closeSync(logFd)
      resolve(code ?? 1)
    })
  })
}

async function supervise(payloadPath: string): Promise<boolean> {
  const { ctx, tasks } = JSON.parse(readFileSync(payloadPath, 'utf8')) as SupervisorPayload
  const outcomes = await Promise.all(tasks.map(task => launchTask(ctx, task)))
  writeFileSync(resultPathOf(payloadPath), `${JSON.stringify(outcomes)}\n`)
  return outcomes.every(outcome => outcome.ok)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === SUPERVISE_PATH) {
  const [payloadPath] = process.argv.slice(2)
  if (payloadPath === undefined) {
    console.error('usage: supervise.ts <payload.json>')
    process.exitCode = 1
  }
  else {
    process.exitCode = await supervise(payloadPath) ? 0 : 1
  }
}
