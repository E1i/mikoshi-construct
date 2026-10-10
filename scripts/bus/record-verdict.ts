import type { DatabaseSync } from 'node:sqlite'
import type { ReviewStatus, StatusPublisher } from '../ghosts/verdict.js'
import type { GitHub } from './github.js'
import type { Lease } from './lease.js'
import { REVIEW_STATUS_CONTEXT } from '../ghosts/verdict.js'
import { CARD_STARTED } from './launch-candidates.js'
import { assertHeld } from './lease.js'
import { Meter } from './meter.js'
import { ciOf } from './snapshot.js'

export type VerdictWord = 'pass' | 'changes'
export type TechnicalReason = 'stale_head' | 'github_error' | 'ci_not_ready' | 'ci_red' | 'review_failed'

export type Denial
  = | { kind: 'technical', reason: TechnicalReason, detail: string }
    | { kind: 'authority', rule: 'reviewer_is_author', detail: string }

export type VerdictOutcome = { kind: 'recorded' } | { kind: 'denied', denial: Denial }

export interface VerdictRequest {
  lease: Lease
  verdict: VerdictWord
  reviewerSession: string
}

const REPO = 'repos/{owner}/{repo}'
const STATUS_STATE: Record<VerdictWord, ReviewStatus['state']> = { pass: 'success', changes: 'failure' }

interface Pull {
  state?: string
  head?: { sha?: string }
}

function sessionsIn(payload: Record<string, unknown>): string[] {
  const listed = Array.isArray(payload.sessions) ? payload.sessions.map(each => (each as { id?: unknown } | null)?.id) : []
  return [payload.session, ...listed].filter((each): each is string => typeof each === 'string' && each !== '')
}

export function authorSessions(db: DatabaseSync, cardId: number): Set<string> {
  const rows = db.prepare(`SELECT payload FROM events WHERE card_id = ? AND (type = '${CARD_STARTED}' OR legacy = 1) ORDER BY id`).all(cardId)
  const sessions = new Set<string>()
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload)) as unknown
      if (payload !== null && typeof payload === 'object')
        sessionsIn(payload as Record<string, unknown>).forEach(session => sessions.add(session))
    }
    catch {}
  }
  return sessions
}

function technical(reason: TechnicalReason, detail: string): Denial {
  return { kind: 'technical', reason, detail }
}

export function freshDenial(gitHub: GitHub, lease: Lease, nowMs: () => number): Denial | null {
  const meter = new Meter(gitHub, nowMs)
  try {
    const pull = meter.get(`${REPO}/pulls/${lease.pr}`) as Pull
    if (pull.state !== 'open' || pull.head?.sha !== lease.head)
      return technical('stale_head', `#${lease.pr} is ${pull.state ?? 'unknown'} at ${pull.head?.sha ?? 'no head'}, the lease is for ${lease.head}`)
    const ci = ciOf(meter, lease.head!)
    if (ci === 'red')
      return technical('ci_red', `CI is red on ${lease.head}`)
    return ci === 'green' ? null : technical('ci_not_ready', `CI is ${ci} on ${lease.head}`)
  }
  catch (error) {
    return technical('github_error', error instanceof Error ? error.message : String(error))
  }
}

export function recordVerdict(db: DatabaseSync, gitHub: GitHub, publish: StatusPublisher, request: VerdictRequest, nowMs: () => number): VerdictOutcome {
  const { lease } = request
  assertHeld(db, lease)
  if (authorSessions(db, lease.cardId).has(request.reviewerSession))
    return { kind: 'denied', denial: { kind: 'authority', rule: 'reviewer_is_author', detail: `session ${request.reviewerSession} wrote card #${lease.cardId}` } }
  const denial = freshDenial(gitHub, lease, nowMs)
  if (denial !== null)
    return { kind: 'denied', denial }
  try {
    publish({ commit: lease.head!, state: STATUS_STATE[request.verdict], context: REVIEW_STATUS_CONTEXT, description: `review verdict ${request.verdict} for card #${lease.cardId} by ${request.reviewerSession}` })
  }
  catch (error) {
    return { kind: 'denied', denial: technical('github_error', error instanceof Error ? error.message : String(error)) }
  }
  return { kind: 'recorded' }
}
