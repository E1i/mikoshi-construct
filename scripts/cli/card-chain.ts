import type { DatabaseSync } from 'node:sqlite'
import { byId, events, latest } from '../core/events-query.js'
import { CARD_VERIFIED, PR_CLOSED, REVIEW_RECORDED } from '../core/events.js'

const DECISION = /\bD-[1-9]\d*\b/g
const MERGED_FLAGS: readonly unknown[] = [true, 1]

export interface ChainBody {
  admissionEventId: number
  text: string
}

export interface CardChain {
  card: number
  versions: number[]
  decisions: string[]
  verdict: { event: number, verdict: unknown } | null
  proof: number | null
}

function versionsFrom(db: DatabaseSync, latestAdmission: number): number[] {
  const versions: number[] = []
  let current: number | null = latestAdmission
  while (current !== null && !versions.includes(current)) {
    versions.push(current)
    const previous: unknown = byId(db, current)?.data?.prevAdmissionId
    current = typeof previous === 'number' ? previous : null
  }
  return versions
}

function latestMerge(db: DatabaseSync, card: number, prs: readonly number[]): number | null {
  const closes = [
    ...events(db, { types: [PR_CLOSED], card }),
    ...prs.flatMap(pr => events(db, { types: [PR_CLOSED], pr })),
  ]
  const merged = closes.filter(row => MERGED_FLAGS.includes(row.data?.merged)).map(row => row.id)
  return merged.length === 0 ? null : Math.max(...merged)
}

export function cardChain(db: DatabaseSync, card: number, body: ChainBody, prs: readonly number[]): CardChain {
  const review = latest(db, { types: [REVIEW_RECORDED], card })
  return {
    card,
    versions: versionsFrom(db, body.admissionEventId),
    decisions: [...new Set(body.text.match(DECISION) ?? [])],
    verdict: review === null ? null : { event: review.id, verdict: review.data?.verdict },
    proof: latestMerge(db, card, prs) ?? latest(db, { types: [CARD_VERIFIED], card })?.id ?? null,
  }
}
