import type { JournalEntry } from '../ghosts/journal.js'
import type { TasksFile } from '../ghosts/tasks.js'
import type { LedgerStage } from '../ghosts/watch-ledger.js'
import type { BudgetLine } from './eddies.js'
import type { ModelMismatch } from './roles.js'
import type { Window } from './window.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readContourSchema, violations } from '../contract/contours.js'
import { lookupMatrixRow } from '../ghosts/matrix.js'
import { ghostRowState } from '../ghosts/status.js'
import { readTasksFile } from '../ghosts/tasks.js'
import { readLedgerStage } from '../ghosts/watch-ledger.js'
import { readBudgetLines } from './eddies.js'
import { handLadderRows } from './policy.js'
import { readModelMismatches } from './roles.js'
import { callsBrowserWitness } from './verification.js'
import { readWindow } from './window.js'

export type TaskEvent = JournalEntry & { event: 'task', ts: string }

export interface Digest {
  path: string
  sha256: string
}

export interface ReviewEvent {
  event: 'review'
  task: string
  verdict: string
  ts: string
  head?: string
  brief?: Digest
  report?: Digest
  file?: Digest
}

export interface MergeEvent {
  event: 'merge'
  task: string
  by: string
  commit: string
  ts: string
}

export interface PathEvent {
  event: 'path'
  task: string
  path: string
  started?: string
  pr?: number
  sha?: string
  report?: string
  verification?: string
  session?: string
  worktree?: string
  branch?: string
  ts: string
}

export interface SupersededEvent {
  event: 'superseded'
  task: string
  by: string
  ts: string
}

export interface StatusRow {
  state: string
  start: string
  updated: string
}

export interface Approval {
  at: Date
  sha8: string | undefined
}

export interface Attempt {
  id: string
  brief: string | undefined
  briefWrittenAt: Date | undefined
  approval: Approval | undefined
  branch: string | undefined
  worktree: string | undefined
  tasksFileMtime: Date | undefined
  row: StatusRow | undefined
  handLadderUpdated: string | undefined
  ledger: LedgerStage | null | 'unreadable'
  browserWitness: boolean
  modelMismatches: ModelMismatch[]
  budgetLines: BudgetLine[]
  taskEvent: TaskEvent | undefined
  reviewEvent: ReviewEvent | undefined
  mergeEvent: MergeEvent | undefined
  pathEvent: PathEvent | undefined
  window: Window
  handoffFile: string | undefined
  supersededEvent: SupersededEvent | undefined
}

export interface Handoff {
  attempts: Attempt[]
  edges: string[] | undefined
  warnings: string[]
}

type JournalLine = TaskEvent | ReviewEvent | MergeEvent | PathEvent | SupersededEvent

interface Named {
  brief: string | undefined
  worktree: string | undefined
  branch: string | undefined
  tasksFileMtime: Date | undefined
}

const REVIEW_VERDICT_SCHEMA = 'contract/contours/review-verdict.schema.json'

function reviewLineFaults(line: unknown): string[] {
  if (line == null || typeof line !== 'object' || (line as ReviewEvent).event !== 'review' || !('file' in line))
    return []
  return violations(line, { $ref: '#/$defs/journalLine' }, '', readContourSchema('review-verdict'))
}

function readJournal(dir: string, warnings: string[]): JournalLine[] {
  const journalPath = path.join(dir, 'ghosts.jsonl')
  if (!existsSync(journalPath))
    return []
  return readFileSync(journalPath, 'utf8').split('\n').filter(line => line !== '').flatMap((line, index) => {
    let parsed: JournalLine
    try {
      parsed = JSON.parse(line) as JournalLine
    }
    catch {
      warnings.push(`ghosts.jsonl line ${index + 1} is not JSON; skipped`)
      return []
    }
    const faults = reviewLineFaults(parsed)
    if (faults.length > 0) {
      warnings.push(`ghosts.jsonl line ${index + 1} is a review line that does not hold ${REVIEW_VERDICT_SCHEMA} (${faults.join('; ')}); skipped`)
      return []
    }
    return [parsed]
  })
}

function readTasksFiles(dir: string, warnings: string[]): { file: string, mtime: Date, data: TasksFile }[] {
  return readdirSync(dir)
    .filter(file => /^tasks-.*\.json$/.test(file))
    .flatMap((file) => {
      const filePath = path.join(dir, file)
      try {
        return [{ file, mtime: statSync(filePath).mtime, data: readTasksFile(filePath) }]
      }
      catch (error) {
        warnings.push(`${file} skipped: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    })
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime())
}

function ghostRow(statusText: string | undefined, id: string): StatusRow | undefined {
  if (statusText === undefined)
    return undefined
  const state = ghostRowState(statusText, id)
  if (state === undefined)
    return undefined
  const cells = statusText.split('\n').find(line => line.startsWith(`| ghost-${id} |`))!.split('|').map(cell => cell.trim())
  return { state, start: cells[5] ?? '', updated: cells[7] ?? '' }
}

function approvalOf(brief: string): Approval | undefined {
  const approvedPath = brief.replace(/\.md$/, '.approved-sha256')
  if (approvedPath === brief || !existsSync(approvedPath))
    return undefined
  const sha8 = /sha256: ([0-9a-f]{8})/.exec(readFileSync(approvedPath, 'utf8'))?.[1]
  return { at: statSync(approvedPath).mtime, sha8 }
}

function browserWitnessOf(brief: string | undefined): boolean {
  return brief !== undefined && existsSync(brief) && callsBrowserWitness(readFileSync(brief, 'utf8'))
}

function ledgerOf(worktree: string | undefined): Attempt['ledger'] {
  if (worktree === undefined)
    return null
  try {
    return readLedgerStage(path.join(worktree, '.construct', 'runs.jsonl'))
  }
  catch {
    return 'unreadable'
  }
}

function edgesFrom(dir: string, files: { file: string, data: TasksFile }[], warnings: string[]): string[] | undefined {
  const withMatrix = files.filter(entry => entry.data.matrix !== undefined)
  if (withMatrix.length === 0)
    return undefined
  const edges: string[] = []
  for (const { file, data } of withMatrix) {
    const matrixPath = path.resolve(dir, data.matrix!)
    try {
      for (const task of data.tasks) {
        const contour = lookupMatrixRow(matrixPath, task.id)?.contour as { after?: unknown } | undefined
        const after = Array.isArray(contour?.after) ? contour.after : []
        for (const predecessor of after)
          edges.push(`${String(predecessor)} -> ${task.id}`)
      }
    }
    catch (error) {
      warnings.push(`${file}: matrix ${matrixPath} unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  return edges
}

function foldPath(journal: JournalLine[], id: string): PathEvent | undefined {
  const lines = journal.filter((line): line is PathEvent => line.event === 'path' && line.task === id)
  if (lines.length === 0)
    return undefined
  const folded: Record<string, unknown> = {}
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) {
      if (value !== undefined)
        folded[key] = value
    }
  }
  return folded as unknown as PathEvent
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function handoffFileOf(dir: string, id: string): string | undefined {
  const token = new RegExp(`(^|-)${escapeRegExp(id)}(-|$)`)
  return readdirSync(dir).find(file => file.startsWith('handoff-') && file.endsWith('.md') && token.test(file.slice('handoff-'.length, -'.md'.length)))
}

export function readHandoff(dir: string, repoRoot?: string): Handoff {
  const warnings: string[] = []
  const journal = readJournal(dir, warnings)
  const tasksFiles = readTasksFiles(dir, warnings)
  const statusPath = path.join(dir, 'status.md')
  const statusText = existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : undefined

  const named = new Map<string, Named>()
  const name = (id: string): Named => {
    if (!named.has(id))
      named.set(id, { brief: undefined, worktree: undefined, branch: undefined, tasksFileMtime: undefined })
    return named.get(id)!
  }
  for (const { mtime, data } of tasksFiles) {
    for (const task of data.tasks)
      Object.assign(name(task.id), { brief: path.resolve(dir, task.brief), worktree: path.resolve(dir, task.worktree), branch: task.branch, tasksFileMtime: mtime })
  }
  for (const line of journal) {
    if (typeof line.task === 'string')
      name(line.task)
  }
  for (const match of (statusText ?? '').matchAll(/^\| ghost-(\S+) \|/gm))
    name(match[1])
  const handLadders = handLadderRows(statusText)
  for (const id of handLadders.keys())
    name(id)

  const lastOf = <K extends JournalLine['event']>(id: string, event: K): Extract<JournalLine, { event: K }> | undefined =>
    journal.filter((line): line is Extract<JournalLine, { event: K }> => line.event === event && line.task === id).at(-1)

  const windowBudgetLines = readBudgetLines(repoRoot)
  const attempts = [...named].map(([id, facts]): Attempt => {
    const pathEvent = foldPath(journal, id)
    const worktree = facts.worktree ?? pathEvent?.worktree
    const session = pathEvent?.session
    return {
      id,
      brief: facts.brief,
      briefWrittenAt: facts.brief !== undefined && existsSync(facts.brief) ? statSync(facts.brief).mtime : undefined,
      approval: facts.brief === undefined ? undefined : approvalOf(facts.brief),
      branch: facts.branch ?? pathEvent?.branch,
      worktree,
      tasksFileMtime: facts.tasksFileMtime,
      row: ghostRow(statusText, id),
      handLadderUpdated: handLadders.get(id),
      ledger: ledgerOf(worktree),
      browserWitness: browserWitnessOf(facts.brief),
      modelMismatches: readModelMismatches(worktree),
      budgetLines: [...readBudgetLines(worktree), ...(session === undefined || worktree === repoRoot ? [] : windowBudgetLines.filter(line => line.session === session))],
      taskEvent: lastOf(id, 'task'),
      reviewEvent: lastOf(id, 'review'),
      mergeEvent: lastOf(id, 'merge'),
      pathEvent,
      window: readWindow([repoRoot, worktree], session),
      handoffFile: handoffFileOf(dir, id),
      supersededEvent: lastOf(id, 'superseded'),
    }
  })

  return { attempts, edges: edgesFrom(dir, tasksFiles, warnings), warnings }
}
