import type { OwnerMergeKind } from '../shredder/reader.js'
import type { AttemptView } from './derive.js'
import type { PrDetails, PullRequest } from './gh.js'
import { ownerMerges } from '../shredder/authority.js'
import { changesRequested, isHandLadderRunning, isRunningRow, reportOf } from './derive.js'
import { handLadderPolicy } from './policy.js'

export const NEXT_BY_SITUATION = {
  'brief': 'brief (window)',
  'approval': 'Eli\'s approval',
  'launch': 'launch (window)',
  'ghost-running': 'the Ghost\'s run',
  'hand-ladder-running': 'the ladder\'s run',
  'verdict': 'verdict (window)',
  'new-attempt': 'a new attempt (window)',
  'pr': 'a PR (window)',
  'pr-unknown': 'UNKNOWN (the PR is not readable)',
  'pr-closed': 'a decision (window): PR closed unmerged',
  'ci': 'CI',
  'ci-red': 'a fix (window): CI red',
  'ci-unknown': 'UNKNOWN (the PR\'s checks are not readable)',
  'owner-merge': 'Eli\'s merge',
  'auto-merge': 'auto-merge (window arms it)',
  'merge-unknown': 'merge (UNKNOWN whether Eli\'s or auto-merge)',
  'merged': '—',
  'report': 'report: ',
  'window-closed': 'window closed, no PR',
  'window-handoff': 'handoff, waits for a new window',
  'superseded': '— (superseded)',
} as const

export type Situation = keyof typeof NEXT_BY_SITUATION

export type Ownership = { kind: 'owner', why: string } | { kind: 'auto' } | { kind: 'unknown', missing: string }

export interface Next {
  situation: Situation
  text: string
  why: string | undefined
}

export function ownershipOf(pr: PullRequest, files: string[] | undefined, kinds: OwnerMergeKind[] | undefined): Ownership {
  if (kinds === undefined)
    return { kind: 'unknown', missing: 'architecture/owner-merges.md' }
  const byTitle = kinds.find(kind => kind.title !== null && kind.title === pr.title)
  if (byTitle !== undefined)
    return { kind: 'owner', why: `owner-merges ${byTitle.kind}: title` }
  if (files === undefined)
    return { kind: 'unknown', missing: `the files of PR #${pr.number}` }
  const verdict = ownerMerges(files, kinds)
  return verdict.ownerMerged ? { kind: 'owner', why: verdict.why.join('; ') } : { kind: 'auto' }
}

function next(situation: Situation, why?: string): Next {
  return { situation, text: NEXT_BY_SITUATION[situation], why }
}

function prNext(view: AttemptView, details: PrDetails | undefined, kinds: OwnerMergeKind[] | undefined): Next {
  if (view.pr.kind === 'unknown')
    return next('pr-unknown', view.pr.missing)
  if (view.pr.kind === 'none')
    return next('pr')
  const pr = view.pr.pr
  if (pr.state !== 'OPEN')
    return next('pr-closed', `#${pr.number} ${pr.state}`)
  if (details === undefined || details.ci.state === 'unknown')
    return next('ci-unknown')
  if (details.ci.state === 'red')
    return next('ci-red', details.ci.text)
  if (details.ci.state === 'none' || details.ci.state === 'pending')
    return next('ci', details.ci.text)
  const ownership = ownershipOf(pr, details.files, kinds)
  if (ownership.kind === 'owner')
    return next('owner-merge', ownership.why)
  if (ownership.kind === 'auto')
    return next('auto-merge', 'no owner-merges kind matches by title or paths; new-write-path is not checked by paths')
  return next('merge-unknown', `missing: ${ownership.missing}`)
}

function ladderNext(view: AttemptView, details: PrDetails | undefined, kinds: OwnerMergeKind[] | undefined): Next {
  const { attempt } = view
  const task = attempt.taskEvent
  if (isHandLadderRunning(attempt))
    return next('hand-ladder-running', `status.md policy ${handLadderPolicy(attempt.id)}`)
  if (changesRequested(attempt))
    return next('new-attempt', 'last review verdict changes')
  if (task !== undefined && (task.exit !== 0 || task.ladder !== 'done'))
    return next('new-attempt', `ladder ${task.ladder}, exit ${task.exit}`)
  if (isRunningRow(attempt))
    return next('ghost-running', `status.md ${attempt.row!.state}`)
  if (task !== undefined)
    return attempt.reviewEvent === undefined ? next('verdict') : prNext(view, details, kinds)
  if (attempt.approval !== undefined)
    return next('launch')
  return attempt.briefWrittenAt === undefined ? next('brief') : next('approval')
}

export function nextOf(view: AttemptView, details: PrDetails | undefined, kinds: OwnerMergeKind[] | undefined): Next {
  if (view.mergedAt !== undefined)
    return next('merged')
  if (view.attempt.supersededEvent !== undefined)
    return next('superseded', `by ${view.attempt.supersededEvent.by}`)
  const report = reportOf(view.attempt.pathEvent)
  if (view.path === 'cheap' && report !== undefined)
    return { situation: 'report', text: `${NEXT_BY_SITUATION.report}${report}`, why: undefined }
  if (view.path === 'cheap' && view.category === 'blocked')
    return view.attempt.handoffFile === undefined ? next('window-closed') : next('window-handoff', view.attempt.handoffFile)
  if (view.path === 'cheap')
    return view.attempt.pathEvent?.pr === undefined ? next('pr', 'the journal event:path line records no PR') : prNext(view, details, kinds)
  return ladderNext(view, details, kinds)
}
