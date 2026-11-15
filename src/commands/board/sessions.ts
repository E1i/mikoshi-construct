import type { TranscriptReader } from '../liveness.js'
import { minutesBetween, sessionTimeIn, sessionTimeLine } from '../liveness.js'

export { clientTranscriptReader, type TranscriptReader } from '../liveness.js'

export interface QueuedStanding {
  card: number
  queue: string
  since: string | null
  behind: number[]
}

export function sessionRowTime(transcripts: TranscriptReader, session: string, startedAt: string, tree: string | null, now: Date): string {
  return sessionTimeLine(sessionTimeIn(transcripts, session, startedAt, tree), now)
}

export function queuedLine(standing: QueuedStanding, now: Date): string {
  const waited = standing.since === null ? 'waited for a time the bus did not record' : `waited ${minutesBetween(standing.since, now.toISOString())} min`
  const behind = standing.behind.length === 0 ? 'first in the queue' : `behind ${standing.behind.map(card => `#${card}`).join(', ')}`
  return `queued in ${standing.queue}, ${behind} · ${waited}`
}
