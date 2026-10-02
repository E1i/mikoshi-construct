import type { LedgerEntry } from '../cost/ledger.js'
import type { PullRequest } from './prs.js'
import { ciOf } from './prs.js'

export const NO_NEXT = '—'
const TASK_WIDTH = 40

export type ItemState = 'running' | 'waiting' | 'blocked' | 'merged' | 'closed' | 'superseded'
export type Tone = 'red' | null

export interface Item {
  task: string
  path: 'ladder' | 'pr'
  stage: string
  state: ItemState
  at: Date
  next: string
  tone: Tone
}

function cut(text: string): string {
  return text.length > TASK_WIDTH ? `${text.slice(0, TASK_WIDTH - 1)}…` : text
}

export function ladderItems(entries: LedgerEntry[]): Item[] {
  return entries.map((entry, index) => {
    const superseded = entries.slice(index + 1).some(later => later.task === entry.task)
    const base = { task: cut(entry.task), path: 'ladder' as const, stage: `ladder ${entry.status}`, at: new Date(entry.at) }
    if (superseded)
      return { ...base, state: 'superseded', next: NO_NEXT, tone: null }
    if (entry.status === 'done')
      return { ...base, state: 'waiting', next: 'a review, then a PR (you)', tone: 'red' }
    return { ...base, state: 'blocked', next: `a decision (you): ladder ${entry.status}`, tone: 'red' }
  })
}

function openPr(pr: PullRequest, base: Pick<Item, 'task' | 'path'>): Item {
  const ci = ciOf(pr.statusCheckRollup)
  if (ci.state === 'green')
    return { ...base, stage: 'ready', state: 'waiting', at: new Date(ci.completedAt ?? pr.createdAt), next: 'a merge (you)', tone: 'red' }
  const at = new Date(pr.createdAt)
  if (ci.state === 'red')
    return { ...base, stage: 'open', state: 'blocked', at, next: 'a fix (you): CI red', tone: 'red' }
  if (ci.state === 'pending')
    return { ...base, stage: 'open', state: 'running', at, next: 'CI', tone: null }
  return { ...base, stage: 'open', state: 'waiting', at, next: 'a merge (you): no CI checks reported', tone: 'red' }
}

export function prItems(prs: PullRequest[]): Item[] {
  return prs.map((pr) => {
    const base = { task: `#${pr.number} ${pr.title}`, path: 'pr' as const }
    if (pr.state === 'MERGED')
      return { ...base, stage: 'merged', state: 'merged', at: new Date(pr.mergedAt ?? pr.createdAt), next: NO_NEXT, tone: null }
    if (pr.state === 'CLOSED')
      return { ...base, stage: 'closed', state: 'closed', at: new Date(pr.closedAt ?? pr.createdAt), next: NO_NEXT, tone: null }
    return openPr(pr, base)
  })
}
