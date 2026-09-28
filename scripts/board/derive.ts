import type { PrDetails, PrList, PrLookup, PullRequest } from './gh.js'
import type { Attempt, PathEvent } from './handoff.js'
import path from 'node:path'
import { lookupPr, lookupPrNumber, REQUIRED_CHECK } from './gh.js'

export type Category = 'running' | 'waiting' | 'blocked' | 'merged' | 'idle'

export const OPEN_CATEGORIES: readonly Category[] = ['running', 'waiting', 'blocked']
export const MERGED_SHOWN = 5

const CHEAP_PATH = 'cheap'
const RUNNING_STATES = ['writing', 'reviewing', 'reading']
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

export type StageBody
  = | { state: 'done', at: string, source: string }
    | { state: 'not', reason: string }
    | { state: 'unknown', missing: string }
    | { state: 'fact', value: string, source?: string }

export type Stage = { name: string } & StageBody

export type TaskPath = 'ladder' | 'cheap'

export type ChecksOf = (pr: PullRequest) => PrDetails | undefined

export interface AttemptView {
  attempt: Attempt
  path: TaskPath
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

export function stageText(body: StageBody): string {
  switch (body.state) {
    case 'done':
      return `done ${body.at} (${body.source})`
    case 'not':
      return `— (${body.reason})`
    case 'unknown':
      return `UNKNOWN (missing: ${body.missing})`
    case 'fact':
      return body.source === undefined ? body.value : `${body.value} (${body.source})`
  }
}

export function unknownEvent(missing: string): string {
  return missing.split(';')[0]!.split(' ')[0]!
}

function done(at: Date | string, source: string): StageBody {
  return { state: 'done', at: new Date(at).toISOString(), source }
}

function unknown(missing: string): StageBody {
  return { state: 'unknown', missing }
}

function not(reason: string): StageBody {
  return { state: 'not', reason }
}

function fact(value: string, source?: string): StageBody {
  return source === undefined ? { state: 'fact', value } : { state: 'fact', value, source }
}

function localStamp(text: string | undefined): Date | undefined {
  return text !== undefined && LOCAL_STAMP.test(text) ? new Date(text.replace(' ', 'T')) : undefined
}

export function isRunningRow(attempt: Attempt): boolean {
  return attempt.row !== undefined && RUNNING_STATES.includes(attempt.row.state)
}

export function changesRequested(attempt: Attempt): boolean {
  return attempt.reviewEvent?.verdict === 'changes'
}

function briefStage(attempt: Attempt): StageBody {
  if (attempt.brief === undefined)
    return unknown('brief.written; no tasks file names a brief')
  if (attempt.briefWrittenAt === undefined)
    return unknown('brief.written; file absent')
  return done(attempt.briefWrittenAt, `file mtime, ${path.basename(attempt.brief)}`)
}

function approvedStage(attempt: Attempt): StageBody {
  if (attempt.approval === undefined)
    return unknown('brief.approved')
  return done(attempt.approval.at, `file mtime; text ${attempt.approval.sha8 ?? '?'}…`)
}

function ghostStage(attempt: Attempt): StageBody {
  if (attempt.taskEvent !== undefined)
    return done(attempt.taskEvent.ts, `ladder ${attempt.taskEvent.ladder}, exit ${attempt.taskEvent.exit}`)
  if (isRunningRow(attempt))
    return not(`not finished; status.md ${attempt.row!.state}`)
  return unknown('task')
}

function reviewStage(attempt: Attempt): StageBody {
  if (attempt.reviewEvent !== undefined)
    return done(attempt.reviewEvent.ts, `verdict ${attempt.reviewEvent.verdict}`)
  if (attempt.taskEvent === undefined && isRunningRow(attempt))
    return not('not reached; the ghost is running')
  return unknown('review.started')
}

function mergedAtOf(attempt: Attempt, pr: PrLookup): Date | undefined {
  if (attempt.mergeEvent !== undefined)
    return new Date(attempt.mergeEvent.ts)
  if (pr.kind === 'found' && pr.pr.mergedAt !== null)
    return new Date(pr.pr.mergedAt)
  return undefined
}

function mergedStage(attempt: Attempt, pr: PrLookup): StageBody {
  if (attempt.mergeEvent !== undefined)
    return done(attempt.mergeEvent.ts, `journal, by ${attempt.mergeEvent.by}, ${attempt.mergeEvent.commit.slice(0, 7)}`)
  if (pr.kind === 'found' && pr.pr.mergedAt !== null)
    return done(pr.pr.mergedAt, `gh PR #${pr.pr.number}, ${pr.pr.mergeCommit?.oid.slice(0, 7) ?? '?'}`)
  if (changesRequested(attempt))
    return not('not merged; last review verdict changes')
  if (pr.kind === 'none')
    return not(`no PR for ${attempt.branch}`)
  if (pr.kind === 'found')
    return not(`PR #${pr.pr.number} ${pr.pr.state}`)
  return unknown(`merge; ${pr.missing}`)
}

function detailsOf(pr: PrLookup, checksOf: ChecksOf): PrDetails | undefined {
  return pr.kind === 'found' ? checksOf(pr.pr) : undefined
}

function isReady(details: PrDetails | undefined): boolean {
  return details?.ci.state === 'green'
}

function ciReadyStage(pr: PrLookup, details: PrDetails | undefined): StageBody {
  if (pr.kind === 'unknown')
    return unknown(`ready; ${pr.missing}`)
  if (pr.kind === 'none')
    return not('no PR')
  if (details === undefined)
    return unknown(`ready; the checks of PR #${pr.pr.number} were not read`)
  const { ci } = details
  switch (ci.state) {
    case 'green':
      return ci.greenAt === undefined ? fact(`CI ${REQUIRED_CHECK} green on ${ci.head}`, 'gh checks, no completedAt') : done(ci.greenAt, `CI ${REQUIRED_CHECK} green on ${ci.head}`)
    case 'unknown':
      return unknown('ready; checks; the gh query failed')
    case 'none':
      return not(`no checks recorded on ${ci.head}`)
    default:
      return not(`CI ${ci.text}`)
  }
}

function readyStage(attempt: Attempt, merged: boolean, pr: PrLookup, details: PrDetails | undefined): StageBody {
  if (!merged && changesRequested(attempt))
    return not('last review verdict changes')
  if (pr.kind === 'none')
    return not(`no PR for ${attempt.branch}`)
  return ciReadyStage(pr, details)
}

function cheapPathOf(attempt: Attempt): PathEvent | undefined {
  return attempt.pathEvent?.path === CHEAP_PATH ? attempt.pathEvent : undefined
}

function startedStage(pathEvent: PathEvent): StageBody {
  return pathEvent.started === undefined ? unknown('started; the journal event:path line records none') : done(pathEvent.started, 'journal event:path')
}

function cheapPrStage(pathEvent: PathEvent, pr: PrLookup): StageBody {
  if (pr.kind !== 'found')
    return unknown(pr.kind === 'unknown' ? pr.missing : `pr #${pathEvent.pr}`)
  return fact(`#${pr.pr.number} ${pr.pr.state}`, pathEvent.sha === undefined ? undefined : `journal event:path, sha ${pathEvent.sha.slice(0, 7)}`)
}

function cheapCategoryOf(merged: boolean, details: PrDetails | undefined): Category {
  if (merged)
    return 'merged'
  return isReady(details) ? 'waiting' : 'running'
}

function viewCheapAttempt(attempt: Attempt, pathEvent: PathEvent, prs: PrList, checksOf: ChecksOf): AttemptView {
  const pr = lookupPrNumber(prs, pathEvent.pr)
  const details = detailsOf(pr, checksOf)
  const mergedAt = mergedAtOf(attempt, pr)
  return {
    attempt,
    path: 'cheap',
    pr,
    stages: [
      { name: 'started', ...startedStage(pathEvent) },
      { name: 'ready', ...ciReadyStage(pr, details) },
      { name: 'pr', ...cheapPrStage(pathEvent, pr) },
      { name: 'merged', ...mergedStage(attempt, pr) },
    ],
    facts: [],
    category: cheapCategoryOf(mergedAt !== undefined, details),
    startedAt: pathEvent.started === undefined ? undefined : new Date(pathEvent.started),
    mergedAt,
  }
}

function prFact(attempt: Attempt, pr: PrLookup): StageBody {
  if (pr.kind === 'found')
    return fact(`#${pr.pr.number} ${pr.pr.state}`)
  if (pr.kind === 'none')
    return not(`no PR for ${attempt.branch}`)
  return unknown(pr.missing)
}

function statusFact(attempt: Attempt): StageBody {
  if (attempt.row === undefined)
    return unknown(`status.md row ghost-${attempt.id}`)
  return fact(`${attempt.row.state}, start ${attempt.row.start}, updated ${attempt.row.updated}`)
}

function ledgerFact(attempt: Attempt): StageBody {
  if (attempt.ledger === 'unreadable')
    return unknown('ledger line; runs.jsonl unreadable')
  if (attempt.ledger === null)
    return unknown(`ledger line${attempt.worktree === undefined ? '; no worktree recorded' : ` in ${attempt.worktree}`}`)
  if (attempt.ledger.kind === 'writing')
    return unknown('ledger line; runs.jsonl last line still being written')
  return fact(`${attempt.ledger.status} ${attempt.ledger.run}`)
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

function supersededFacts(attempt: Attempt): Stage[] {
  const event = attempt.supersededEvent
  return event === undefined ? [] : [{ name: 'superseded', ...fact(`by ${event.by}`, `journal event:superseded, ${new Date(event.ts).toISOString()}`) }]
}

function viewAttempt(attempt: Attempt, prs: PrList, checksOf: ChecksOf): AttemptView {
  const view = viewPathAttempt(attempt, prs, checksOf)
  return { ...view, facts: [...view.facts, ...supersededFacts(attempt)] }
}

function viewPathAttempt(attempt: Attempt, prs: PrList, checksOf: ChecksOf): AttemptView {
  const cheapPath = cheapPathOf(attempt)
  if (cheapPath !== undefined)
    return viewCheapAttempt(attempt, cheapPath, prs, checksOf)
  const pr = lookupPr(prs, attempt.branch)
  const mergedAt = mergedAtOf(attempt, pr)
  const merged = mergedAt !== undefined
  return {
    attempt,
    path: 'ladder',
    pr,
    stages: [
      { name: 'brief', ...briefStage(attempt) },
      { name: 'approved', ...approvedStage(attempt) },
      { name: 'ghost', ...ghostStage(attempt) },
      { name: 'review', ...reviewStage(attempt) },
      { name: 'ready', ...readyStage(attempt, merged, pr, detailsOf(pr, checksOf)) },
      { name: 'merged', ...mergedStage(attempt, pr) },
    ],
    facts: [
      { name: 'pr', ...prFact(attempt, pr) },
      { name: 'status.md', ...statusFact(attempt) },
      { name: 'ledger', ...ledgerFact(attempt) },
    ],
    category: categoryOf(attempt, merged),
    startedAt: localStamp(attempt.row?.start),
    mergedAt,
  }
}

export function latestStage(view: AttemptView): Extract<Stage, { state: 'done' }> | undefined {
  return view.stages.filter((stage): stage is Extract<Stage, { state: 'done' }> => stage.state === 'done').at(-1)
}

function orderKey(view: AttemptView): number {
  return (view.startedAt ?? view.attempt.tasksFileMtime)?.getTime() ?? Number.NEGATIVE_INFINITY
}

export function deriveTasks(attempts: Attempt[], prs: PrList, checksOf: ChecksOf): TaskView[] {
  const groups = new Map<string, AttemptView[]>()
  for (const attempt of attempts) {
    const key = attempt.brief ?? `attempt:${attempt.id}`
    groups.set(key, [...(groups.get(key) ?? []), viewAttempt(attempt, prs, checksOf)])
  }
  return [...groups].map(([key, views]) => {
    const ordered = views.sort((a, b) => orderKey(a) - orderKey(b))
    return { name: key.startsWith('attempt:') ? key.slice('attempt:'.length) : path.basename(key), attempts: ordered, live: ordered.at(-1)! }
  }).sort((a, b) => orderKey(a.live) - orderKey(b.live))
}

export function isSuperseded(view: AttemptView): boolean {
  return view.attempt.supersededEvent !== undefined
}

export function summarize(tasks: TaskView[], now: Date): Summary {
  const counts = { running: 0, waiting: 0, blocked: 0 }
  let longest: Summary['longest']
  for (const task of tasks.filter(candidate => !isSuperseded(candidate.live))) {
    const { category, startedAt } = task.live
    if (category !== 'running' && category !== 'waiting' && category !== 'blocked')
      continue
    counts[category] += 1
    if (startedAt === undefined)
      continue
    const minutes = Math.floor((now.getTime() - startedAt.getTime()) / 60_000)
    if (longest === undefined || minutes > longest.minutes)
      longest = { minutes, task: task.live.attempt.id }
  }
  return { counts, longest }
}

export function selectShown(tasks: TaskView[], all: boolean): TaskView[] {
  if (all)
    return tasks
  const current = tasks.filter(task => !isSuperseded(task.live))
  const open = current.filter(task => OPEN_CATEGORIES.includes(task.live.category))
  const merged = current
    .filter(task => task.live.category === 'merged')
    .sort((a, b) => b.live.mergedAt!.getTime() - a.live.mergedAt!.getTime())
    .slice(0, MERGED_SHOWN)
  return [...open, ...merged].map(task => ({ ...task, attempts: [task.live] }))
}
