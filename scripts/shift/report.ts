import type { BudgetLine } from '../board/eddies.js'
import type { GhRunner, PrList } from '../board/gh.js'
import type { TaskLine } from './places.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readBudgetLines } from '../board/eddies.js'
import { execGh, listPrs, lookupPr } from '../board/gh.js'
import { REPO, reportPath, SHIFT_JOURNAL } from './places.js'

export const PREFIX = '[shift:report] '
export const USAGE = 'usage: pnpm shift:report <dir>'
const COLUMNS = ['task', 'exit', 'duration', 'PR', 'eddies stop', 'report'] as const
const RESULT_LINE = /^result:(.*)$/m

export interface ReportDeps {
  cwd: string
  gh: GhRunner
  read: (file: string) => string | null
  budget: (worktree: string) => BudgetLine[]
  out: (line: string) => void
  err: (line: string) => void
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
  return line.signal === null ? String(line.exit) : line.signal
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

function prCell(list: PrList, branch: string): string {
  const pr = lookupPr(list, branch)
  if (pr.kind === 'found')
    return `PR #${pr.pr.number}`
  return pr.kind === 'none' ? 'no PR' : '?'
}

function eddiesCell(deps: ReportDeps, line: TaskLine): string {
  if (line.worktree === null)
    return '—'
  const stop = deps.budget(line.worktree).find(entry => entry.event === 'budget-stop' && entry.session === line.session)
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

export function table(rows: string[][]): string[] {
  const widths = COLUMNS.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ').trimEnd())
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
  const rows = lines.map(line => [
    `${line.file} ${line.task}`,
    exitCell(line),
    durationCell(line.started, line.ended),
    prCell(prs, line.branch),
    eddiesCell(deps, line),
    reportCell(deps, dir, line),
  ])
  for (const row of table([[...COLUMNS], ...rows]))
    deps.out(row)
  return 0
}

function realDeps(): ReportDeps {
  return {
    cwd: process.cwd(),
    gh: execGh,
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    budget: worktree => readBudgetLines(worktree),
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runReport(process.argv.slice(2), realDeps())
