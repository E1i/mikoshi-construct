import type { PrList, PrLookup } from './gh.js'
import type { Attempt } from './handoff.js'
import path from 'node:path'
import { lookupPr } from './gh.js'

export type Category = 'running' | 'waiting' | 'blocked' | 'merged' | 'idle'

export const OPEN_CATEGORIES: readonly Category[] = ['running', 'waiting', 'blocked']
export const MERGED_SHOWN = 5

const RUNNING_STATES = ['writing', 'reviewing', 'reading']
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

export interface Stage {
  name: string
  text: string
}

export interface AttemptView {
  attempt: Attempt
  pr: PrLookup
  stages: Stage[]
  facts: Stage[]
  category: Category
  startedAt: Date | undefined
  mergedAt: Date | undefined
}

export interface TaskView {
  name: string
  attempts: AttemptView[]
  live: AttemptView
}

export interface Summary {
  counts: Record<'running' | 'waiting' | 'blocked', number>
  longest: { minutes: number, task: string } | undefined
}

export function isUnknown(text: string): boolean {
  return text.startsWith('UNKNOWN')
}

function done(at: Date | string, detail: string): string {
  return `done ${new Date(at).toISOString()} (${detail})`
}

function unknown(missing: string): string {
  return `UNKNOWN (missing: ${missing})`
}

function localStamp(text: string | undefined): Date | undefined {
  return text !== undefined && LOCAL_STAMP.test(text) ? new Date(text.replace(' ', 'T')) : undefined
}

function isRunningRow(attempt: Attempt): boolean {
  return attempt.row !== undefined && RUNNING_STATES.includes(attempt.row.state)
}

function changesRequested(attempt: Attempt): boolean {
  return attempt.reviewEvent?.verdict === 'changes'
}

function briefStage(attempt: Attempt): string {
  if (attempt.brief === undefined)
    return unknown('brief.written; no tasks file names a brief')
  if (attempt.briefWrittenAt === undefined)
    return unknown('brief.written; file absent')
  return done(attempt.briefWrittenAt, `file mtime, ${path.basename(attempt.brief)}`)
}

function approvedStage(attempt: Attempt): string {
  if (attempt.approval === undefined)
    return unknown('brief.approved')
  return done(attempt.approval.at, `file mtime; text ${attempt.approval.sha8 ?? '?'}…`)
}

function ghostStage(attempt: Attempt): string {
  if (attempt.taskEvent !== undefined)
    return done(attempt.taskEvent.ts, `ladder ${attempt.taskEvent.ladder}, exit ${attempt.taskEvent.exit}`)
  if (isRunningRow(attempt))
    return `— (not finished; status.md ${attempt.row!.state})`
  return unknown('task')
}

function reviewStage(attempt: Attempt): string {
  if (attempt.reviewEvent !== undefined)
    return done(attempt.reviewEvent.ts, `verdict ${attempt.reviewEvent.verdict}`)
  if (attempt.taskEvent === undefined && isRunningRow(attempt))
    return '— (not reached; the ghost is running)'
  return unknown('review.started')
}

function mergedAtOf(attempt: Attempt, pr: PrLookup): Date | undefined {
  if (attempt.mergeEvent !== undefined)
    return new Date(attempt.mergeEvent.ts)
  if (pr.kind === 'found' && pr.pr.mergedAt !== null)
    return new Date(pr.pr.mergedAt)
  return undefined
}

function mergedStage(attempt: Attempt, pr: PrLookup): string {
  if (attempt.mergeEvent !== undefined)
    return done(attempt.mergeEvent.ts, `journal, by ${attempt.mergeEvent.by}, ${attempt.mergeEvent.commit.slice(0, 7)}`)
  if (pr.kind === 'found' && pr.pr.mergedAt !== null)
    return done(pr.pr.mergedAt, `gh PR #${pr.pr.number}, ${pr.pr.mergeCommit?.oid.slice(0, 7) ?? '?'}`)
  if (changesRequested(attempt))
    return '— (not merged; last review verdict changes)'
  if (pr.kind === 'none')
    return `— (no PR for ${attempt.branch})`
  if (pr.kind === 'found')
    return `— (PR #${pr.pr.number} ${pr.pr.state})`
  return unknown(`merge; ${pr.missing}`)
}

function readyStage(attempt: Attempt, merged: boolean): string {
  if (!merged && changesRequested(attempt))
    return '— (last review verdict changes)'
  return unknown('ready; no record type exists for it')
}

function prFact(attempt: Attempt, pr: PrLookup): string {
  if (pr.kind === 'found')
    return `#${pr.pr.number} ${pr.pr.state}`
  if (pr.kind === 'none')
    return `— (no PR for ${attempt.branch})`
  return unknown(pr.missing)
}

function statusFact(attempt: Attempt): string {
  if (attempt.row === undefined)
    return unknown(`status.md row ghost-${attempt.id}`)
  return `${attempt.row.state}, start ${attempt.row.start}, updated ${attempt.row.updated}`
}

function ledgerFact(attempt: Attempt): string {
  if (attempt.ledger === 'unreadable')
    return unknown('ledger line; runs.jsonl unreadable')
  if (attempt.ledger === null)
    return unknown(`ledger line${attempt.worktree === undefined ? '; no worktree recorded' : ` in ${attempt.worktree}`}`)
  return `${attempt.ledger.status} ${attempt.ledger.run}`
}

function categoryOf(attempt: Attempt, merged: boolean): Category {
  if (merged)
    return 'merged'
  if (isRunningRow(attempt))
    return 'running'
  const task = attempt.taskEvent
  if (task !== undefined && (task.exit !== 0 || task.ladder !== 'done' || changesRequested(attempt)))
    return 'blocked'
  if (task === undefined && changesRequested(attempt))
    return 'blocked'
  return task === undefined ? 'idle' : 'waiting'
}

function viewAttempt(attempt: Attempt, prs: PrList): AttemptView {
  const pr = lookupPr(prs, attempt.branch)
  const mergedAt = mergedAtOf(attempt, pr)
  const merged = mergedAt !== undefined
  return {
    attempt,
    pr,
    stages: [
      { name: 'brief', text: briefStage(attempt) },
      { name: 'approved', text: approvedStage(attempt) },
      { name: 'ghost', text: ghostStage(attempt) },
      { name: 'review', text: reviewStage(attempt) },
      { name: 'ready', text: readyStage(attempt, merged) },
      { name: 'merged', text: mergedStage(attempt, pr) },
    ],
    facts: [
      { name: 'pr', text: prFact(attempt, pr) },
      { name: 'status.md', text: statusFact(attempt) },
      { name: 'ledger', text: ledgerFact(attempt) },
    ],
    category: categoryOf(attempt, merged),
    startedAt: localStamp(attempt.row?.start),
    mergedAt,
  }
}

function orderKey(view: AttemptView): number {
  return (view.startedAt ?? view.attempt.tasksFileMtime)?.getTime() ?? Number.NEGATIVE_INFINITY
}

export function deriveTasks(attempts: Attempt[], prs: PrList): TaskView[] {
  const groups = new Map<string, AttemptView[]>()
  for (const attempt of attempts) {
    const key = attempt.brief ?? `attempt:${attempt.id}`
    groups.set(key, [...(groups.get(key) ?? []), viewAttempt(attempt, prs)])
  }
  return [...groups].map(([key, views]) => {
    const ordered = views.sort((a, b) => orderKey(a) - orderKey(b))
    return { name: key.startsWith('attempt:') ? key.slice('attempt:'.length) : path.basename(key), attempts: ordered, live: ordered.at(-1)! }
  }).sort((a, b) => orderKey(a.live) - orderKey(b.live))
}

export function summarize(tasks: TaskView[], now: Date): Summary {
  const counts = { running: 0, waiting: 0, blocked: 0 }
  let longest: Summary['longest']
  for (const task of tasks) {
    const { category, startedAt } = task.live
    if (category !== 'running' && category !== 'waiting' && category !== 'blocked')
      continue
    counts[category] += 1
    if (startedAt === undefined)
      continue
    const minutes = Math.round((now.getTime() - startedAt.getTime()) / 60_000)
    if (longest === undefined || minutes > longest.minutes)
      longest = { minutes, task: task.name }
  }
  return { counts, longest }
}

export function selectShown(tasks: TaskView[], all: boolean): TaskView[] {
  if (all)
    return tasks
  const open = tasks.filter(task => OPEN_CATEGORIES.includes(task.live.category))
  const merged = tasks
    .filter(task => task.live.category === 'merged')
    .sort((a, b) => b.live.mergedAt!.getTime() - a.live.mergedAt!.getTime())
    .slice(0, MERGED_SHOWN)
  return [...open, ...merged].map(task => ({ ...task, attempts: [task.live] }))
}
