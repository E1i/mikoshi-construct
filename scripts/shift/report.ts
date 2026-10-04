import type { SignalStyle } from '../../src/ui/signal.js'
import type { BudgetLine } from '../board/eddies.js'
import type { GhRunner, PrList } from '../board/gh.js'
import type { TaskLine } from './places.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedTasks } from '../../src/card/closed.js'
import { cardHead, cardTerms } from '../../src/card/grammar.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { readBudgetLines } from '../board/eddies.js'
import { execGh, listPrs, lookupPr } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { EXIT_REASON_TEXT, MAX_RESTARTS } from './continuation.js'
import { exitedWithoutReport, GHOST_JOURNAL, REPO, reportPath, SHIFT_JOURNAL, succeeded } from './places.js'

export const PREFIX = '[shift:report] '
export const USAGE = 'usage: pnpm shift:report <dir>'
const RESULT_LINE = /^result:(.*)$/m

export interface ReportDeps {
  cwd: string
  handoffDir: string
  gh: GhRunner
  read: (file: string) => string | null
  budget: (worktree: string) => BudgetLine[]
  out: (line: string) => void
  err: (line: string) => void
  style?: SignalStyle
}

function taskLines(text: string): TaskLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Partial<TaskLine> | null
      return entry?.event === 'task' ? [entry as TaskLine] : []
    }
    catch {
      return []
    }
  })
}

function exitCell(line: TaskLine): string {
  if (line.refused !== undefined)
    return 'not started'
  if (line.error !== undefined)
    return 'not spawned'
  if (line.signal !== null)
    return line.signal
  return exitedWithoutReport(line) ? `${line.exit}, no report` : String(line.exit)
}

export function durationCell(started: string, ended: string): string {
  const seconds = Math.round((Date.parse(ended) - Date.parse(started)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0)
    return '?'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}h ${pad(minutes)}m` : `${minutes}m ${pad(seconds % 60)}s`
}

function taskCell(line: TaskLine): string {
  return `${line.file} ${line.card === undefined ? line.task : cardHead(line.card)}`
}

function prCell(list: PrList, line: TaskLine): string {
  const pr = lookupPr(list, line.branch)
  if (pr.kind === 'found')
    return `PR #${pr.pr.number}`
  if (pr.kind !== 'none')
    return '?'
  return line.card?.kind === 'probe' ? '—' : 'no PR'
}

function closedCell(closed: Map<string, string>, line: TaskLine): string {
  if (line.refused !== undefined)
    return 'closed —'
  const verification = closed.get(line.task)
  return verification === undefined ? 'not closed' : `closed ${verification}`
}

function sessionsOf(line: TaskLine): string[] {
  return [line.session, ...(line.continuations ?? [])]
}

function restartsCell(line: TaskLine): string {
  if (line.worktree === null || line.error !== undefined)
    return 'restarts —'
  if (line.continuations === undefined || line.lastExit === undefined)
    return 'restarts not recorded in shift.jsonl, last exit not recorded in shift.jsonl'
  return `restarts ${line.continuations.length}/${MAX_RESTARTS}, last exit ${EXIT_REASON_TEXT[line.lastExit]}`
}

function eddiesCell(deps: ReportDeps, line: TaskLine): string {
  if (line.worktree === null)
    return '—'
  const sessions = sessionsOf(line)
  const stop = deps.budget(line.worktree).find(entry => entry.event === 'budget-stop' && sessions.includes(entry.session))
  return stop === undefined ? '—' : `${stop.level} ${Math.round(stop.spent)}/${stop.limit}`
}

function reportCell(deps: ReportDeps, dir: string, line: TaskLine): string {
  if (line.refused !== undefined)
    return line.refused
  if (line.error !== undefined)
    return line.error
  const text = deps.read(reportPath(dir, line.number))
  if (text === null)
    return 'no report'
  return RESULT_LINE.exec(text)?.[1]?.trim() || 'report has no result: line'
}

export function runReport(argv: string[], deps: ReportDeps): number {
  if (argv.length !== 1 || argv[0]!.startsWith('-')) {
    deps.err(`${PREFIX}${USAGE}`)
    return 1
  }
  const dir = path.resolve(deps.cwd, argv[0]!)
  const journal = deps.read(path.join(dir, SHIFT_JOURNAL))
  if (journal === null) {
    deps.err(`${PREFIX}${path.join(dir, SHIFT_JOURNAL)} not found: this shift has not run`)
    return 1
  }
  const lines = taskLines(journal)
  const prs = listPrs(deps.gh, REPO)
  const closed = closedTasks(deps.read(path.join(deps.handoffDir, GHOST_JOURNAL)))
  for (const line of lines) {
    const block = renderSignal(taskCell(line), {
      CONTRACT: line.card === undefined ? 'card not recorded in shift.jsonl · law not recorded in shift.jsonl' : `${cardTerms(line.card)} · touches not recorded in shift.jsonl · law not recorded in shift.jsonl`,
      EXPECT: 'expect not recorded in shift.jsonl',
      ACTION: `claude session ${sessionsOf(line).join(', then ')} on ${line.branch}, ${durationCell(line.started, line.ended)}`,
      RESULT: `exit ${exitCell(line)} · ${prCell(prs, line)} · ${closedCell(closed, line)} · ${restartsCell(line)} · eddies stop ${eddiesCell(deps, line)} · report: ${reportCell(deps, dir, line)}`,
    }, deps.style ?? PLAIN_STYLE, succeeded(line) ? undefined : 'red')
    for (const row of block)
      deps.out(row)
  }
  return 0
}

function realDeps(): ReportDeps {
  return {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    gh: execGh,
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    budget: worktree => readBudgetLines(worktree),
    out: line => console.log(line),
    err: line => console.error(line),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runReport(process.argv.slice(2), realDeps())
