import type { PrDetails, PrList, PrLookup, PullRequest } from './gh.js'
import type { Attempt, PathEvent } from './handoff.js'
import path from 'node:path'
import { lookupGhostPr, lookupPr, lookupPrNumber, lookupPrVia, REQUIRED_CHECK } from './gh.js'
import { handLadderPolicy } from './policy.js'
import { VERIFICATION_WORDS } from './verification.js'
import { isEnded, isLive } from './window.js'

export type Category = 'running' | 'waiting' | 'blocked' | 'merged' | 'reported' | 'idle'

export const OPEN_CATEGORIES: readonly Category[] = ['running', 'waiting', 'blocked']
export const FINISHED_SHOWN_HOURS = 12

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
  reportedAt: Date | undefined
}

export interface TaskView {
  name: string
  attempts: AttemptView[]
  live: AttemptView
}

export interface Summary {
  counts: Record<'running' | 'waiting' | 'blocked', number>
  stale: number
  finished: number
  longest: { minutes: number, task: string } | undefined
  windowsLive: number
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

function handLadderStart(attempt: Attempt): Date | undefined {
  return localStamp(attempt.handLadderUpdated)
}

export function isHandLadderRunning(attempt: Attempt): boolean {
  if (attempt.handLadderUpdated === undefined)
    return false
  const start = handLadderStart(attempt)
  if (start === undefined)
    return true
  return ![attempt.taskEvent, attempt.reviewEvent, attempt.mergeEvent].some(event => event !== undefined && new Date(event.ts) > start)
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

function handLadderStage(attempt: Attempt): Stage[] {
  if (!isHandLadderRunning(attempt))
    return []
  const start = handLadderStart(attempt)
  const policy = `status.md policy ${handLadderPolicy(attempt.id)}`
  return [{ name: 'hand-ladder', ...(start === undefined ? unknown(`hand-ladder start; ${policy} updated is not YYYY-MM-DD HH:MM`) : done(start, policy)) }]
}

function handLadderFacts(attempt: Attempt): Stage[] {
  if (attempt.handLadderUpdated === undefined || isHandLadderRunning(attempt))
    return []
  return [{ name: 'hand-ladder', ...fact('finished', `status.md policy ${handLadderPolicy(attempt.id)}, updated ${attempt.handLadderUpdated}; a later journal event:task, review or merge`) }]
}

function browserWitnessFacts(attempt: Attempt): Stage[] {
  return attempt.browserWitness ? [{ name: 'verification', ...fact('browser', 'a brief witness calls browser-witness.mjs') }] : []
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

function cheapPrStage(attempt: Attempt, pathEvent: PathEvent, pr: PrLookup): StageBody {
  if (pr.kind === 'none')
    return not(`no PR for ${attempt.branch}`)
  if (pr.kind === 'unknown')
    return unknown(pr.missing)
  if (pr.via !== undefined)
    return fact(`#${pr.pr.number} ${pr.pr.state}`, `pr via ${pr.via}`)
  return fact(`#${pr.pr.number} ${pr.pr.state}`, pathEvent.sha === undefined ? undefined : `journal event:path, sha ${pathEvent.sha.slice(0, 7)}`)
}

function cheapPrLookup(attempt: Attempt, pathEvent: PathEvent, prs: PrList): PrLookup {
  return pathEvent.pr === undefined && attempt.branch !== undefined ? lookupPrVia(prs, attempt.branch) : lookupPrNumber(prs, pathEvent.pr)
}

function hasNoPr(attempt: Attempt, pathEvent: PathEvent, pr: PrLookup): boolean {
  return pathEvent.pr === undefined && (pr.kind === 'none' || attempt.branch === undefined)
}

function cheapCategoryOf(attempt: Attempt, pathEvent: PathEvent, pr: PrLookup, merged: boolean, details: PrDetails | undefined): Category {
  if (merged)
    return 'merged'
  if (isReady(details))
    return 'waiting'
  return hasNoPr(attempt, pathEvent, pr) && isEnded(attempt.window) ? 'blocked' : 'running'
}

function verificationFact(pathEvent: PathEvent): Stage {
  const word = pathEvent.verification
  if (word === undefined)
    return { name: 'verification', ...unknown('verification; the journal event:path line records none') }
  if (!(VERIFICATION_WORDS as readonly string[]).includes(word))
    return { name: 'verification', ...unknown(`verification; '${word}' is not one of ${VERIFICATION_WORDS.join(', ')}`) }
  return { name: 'verification', ...fact(word, 'journal event:path') }
}

function viewReportAttempt(attempt: Attempt, pathEvent: PathEvent & { report: string }): AttemptView {
  return {
    attempt,
    path: 'cheap',
    pr: { kind: 'none' },
    stages: [
      { name: 'started', ...startedStage(pathEvent) },
      { name: 'reported', ...done(pathEvent.ts, `journal event:path, report ${pathEvent.report}`) },
    ],
    facts: [verificationFact(pathEvent)],
    category: 'reported',
    startedAt: pathEvent.started === undefined ? undefined : new Date(pathEvent.started),
    mergedAt: undefined,
    reportedAt: new Date(pathEvent.ts),
  }
}

export function reportOf(pathEvent: PathEvent | undefined): string | undefined {
  return pathEvent?.pr === undefined ? pathEvent?.report : undefined
}

function viewCheapAttempt(attempt: Attempt, pathEvent: PathEvent, prs: PrList, checksOf: ChecksOf): AttemptView {
  const pr = cheapPrLookup(attempt, pathEvent, prs)
  const details = detailsOf(pr, checksOf)
  const mergedAt = mergedAtOf(attempt, pr)
  return {
    attempt,
    path: 'cheap',
    pr,
    stages: [
      { name: 'started', ...startedStage(pathEvent) },
      { name: 'ready', ...ciReadyStage(pr, details) },
      { name: 'pr', ...cheapPrStage(attempt, pathEvent, pr) },
      { name: 'merged', ...mergedStage(attempt, pr) },
    ],
    facts: [verificationFact(pathEvent)],
    category: cheapCategoryOf(attempt, pathEvent, pr, mergedAt !== undefined, details),
    startedAt: pathEvent.started === undefined ? undefined : new Date(pathEvent.started),
    mergedAt,
    reportedAt: undefined,
  }
}

function prFact(attempt: Attempt, pr: PrLookup): StageBody {
  if (pr.kind === 'found')
    return fact(`#${pr.pr.number} ${pr.pr.state}`, pr.via === undefined ? undefined : `pr via ${pr.via}`)
  if (pr.kind === 'none')
    return not(`no PR for ${attempt.branch}`)
  return unknown(pr.missing)
}

function statusFact(attempt: Attempt): StageBody {
  if (attempt.row === undefined)
    return unknown(`status.md row ghost-${attempt.ghost ?? attempt.id}`)
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
  if (isRunningRow(attempt) || isHandLadderRunning(attempt))
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

function stoppedCategory(view: AttemptView): Category {
  return view.attempt.stopEvent !== undefined && view.mergedAt === undefined ? 'waiting' : view.category
}

function viewAttempt(attempt: Attempt, prs: PrList, checksOf: ChecksOf): AttemptView {
  const view = viewPathAttempt(attempt, prs, checksOf)
  return { ...view, category: stoppedCategory(view), facts: [...view.facts, ...supersededFacts(attempt)] }
}

function viewPathAttempt(attempt: Attempt, prs: PrList, checksOf: ChecksOf): AttemptView {
  const cheapPath = cheapPathOf(attempt)
  const report = reportOf(cheapPath)
  if (cheapPath !== undefined && report !== undefined)
    return viewReportAttempt(attempt, { ...cheapPath, report })
  if (cheapPath !== undefined)
    return viewCheapAttempt(attempt, cheapPath, prs, checksOf)
  const pr = attempt.branch === undefined ? lookupGhostPr(prs, attempt.ghost ?? attempt.id) : lookupPr(prs, attempt.branch)
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
      ...(merged ? [] : handLadderStage(attempt)),
    ],
    facts: [
      { name: 'pr', ...prFact(attempt, pr) },
      { name: 'status.md', ...statusFact(attempt) },
      { name: 'ledger', ...ledgerFact(attempt) },
      ...handLadderFacts(attempt),
      ...browserWitnessFacts(attempt),
    ],
    category: categoryOf(attempt, merged),
    startedAt: isHandLadderRunning(attempt) ? handLadderStart(attempt) : localStamp(attempt.row?.start),
    mergedAt,
    reportedAt: undefined,
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

export function summarize(tasks: TaskView[], now: Date, isStale: (view: AttemptView) => boolean): Summary {
  const counts = { running: 0, waiting: 0, blocked: 0 }
  let longest: Summary['longest']
  let stale = 0
  let finished = 0
  let windowsLive = 0
  for (const task of tasks.filter(candidate => !isSuperseded(candidate.live))) {
    const { category, startedAt } = task.live
    if (finishedAt(task.live) !== undefined && !finishedTooLongAgo(task.live, now))
      finished += 1
    if (category !== 'running' && category !== 'waiting' && category !== 'blocked')
      continue
    counts[category] += 1
    if (isStale(task.live))
      stale += 1
    if (task.live.path === CHEAP_PATH && isLive(task.live.attempt.window))
      windowsLive += 1
    if (startedAt === undefined)
      continue
    const minutes = Math.floor((now.getTime() - startedAt.getTime()) / 60_000)
    if (longest === undefined || minutes > longest.minutes)
      longest = { minutes, task: task.live.attempt.id }
  }
  return { counts, stale, finished, longest, windowsLive }
}

export function finishedAt(view: AttemptView): Date | undefined {
  return view.mergedAt ?? view.reportedAt
}

function finishedTooLongAgo(view: AttemptView, now: Date): boolean {
  const at = finishedAt(view)
  return at !== undefined && now.getTime() - at.getTime() > FINISHED_SHOWN_HOURS * 3_600_000
}

export function selectShown(tasks: TaskView[], all: boolean, now: Date): TaskView[] {
  if (all)
    return tasks
  const current = tasks.filter(task => !isSuperseded(task.live))
  const open = current.filter(task => OPEN_CATEGORIES.includes(task.live.category))
  const finished = current
    .filter(task => finishedAt(task.live) !== undefined && !finishedTooLongAgo(task.live, now))
    .sort((a, b) => finishedAt(b.live)!.getTime() - finishedAt(a.live)!.getTime())
  return [...open, ...finished].map(task => ({ ...task, attempts: [task.live] }))
}
