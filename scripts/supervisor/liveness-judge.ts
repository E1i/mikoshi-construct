import type { DatabaseSync } from 'node:sqlite'
import type { CardTransitions, ProcessStartOf } from '../core/lease.js'
import type { DetachedLaunch } from './bg.js'
import type { ProcessBeat, VitalsReading } from './heartbeat.js'
import { RUNNING_CARD } from '../core/card-automaton.js'
import { cardsWithAState } from '../core/card-readings.js'
import { appendEvent } from '../core/db.js'
import { BY_CARD, lastPer } from '../core/events-query.js'
import { CARD_CONTINUED, CARD_STARTED, PROCESS_JUDGED } from '../core/events.js'
import { judgeHolders } from '../core/lease.js'
import { PREFIX } from './bg.js'
import { judgedLeaseLines } from './executor-lease.js'
import { CARD_PROCESS, lastProcessBeats, recordProcessHeartbeat } from './heartbeat.js'
import { beatsLive, SILENT_MS } from './liveness-sites.js'

export const SUPERVISOR_PROCESS = 'supervisor'
export const JUDGE_ACTOR = 'worker:supervisor:judge'
export const SUPERVISOR_BEAT_MS = 30_000
export const SUPERVISOR_SILENT_MS = 2 * 60_000
export const JUDGED_HORIZON_MS = 24 * 60 * 60_000
export const RESTART_RETRY_MS = 5 * 60_000

export interface Judgement {
  process: string
  lastBeat: string
  silentMs: number
}

export type ExpectedRunning = (name: string) => boolean

export const processName = (launch: DetachedLaunch): string => launch.script

export function expectedRunning(db: DatabaseSync, wanted: readonly DetachedLaunch[]): ExpectedRunning {
  const running = [...cardsWithAState(db)].filter(([, state]) => state === RUNNING_CARD).map(([card]) => `${CARD_PROCESS}${card}`)
  const names = new Set([SUPERVISOR_PROCESS, ...wanted.map(processName), ...running])
  return name => names.has(name)
}

export function judgeSilent(beats: readonly ProcessBeat[], nowMs: number, expected: ExpectedRunning): Judgement[] {
  return beats.filter(beat => expected(beat.process) && !beatsLive(beat.ts, nowMs) && nowMs - Date.parse(beat.ts) <= JUDGED_HORIZON_MS).map(beat => ({ process: beat.process, lastBeat: beat.ts, silentMs: nowMs - Date.parse(beat.ts) }))
}

export function currentLifeBeats(db: DatabaseSync, beats: readonly ProcessBeat[]): ProcessBeat[] {
  const lifeStarts = new Map(lastPer(db, BY_CARD, { types: [CARD_STARTED, CARD_CONTINUED], withCard: true }).map(row => [`${CARD_PROCESS}${row.card_id}`, row.ts]))
  return beats.map((beat) => {
    const lifeStart = lifeStarts.get(beat.process)
    return lifeStart !== undefined && lifeStart > beat.ts ? { process: beat.process, ts: lifeStart } : beat
  })
}

export function recordJudged(db: DatabaseSync, ts: string, judgement: Judgement, limitMs = SILENT_MS): boolean {
  return appendEvent(db, { ts, type: PROCESS_JUDGED, actor: JUDGE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${PROCESS_JUDGED}:${judgement.process}:${judgement.lastBeat}`, payload: { process: judgement.process, verdict: 'silent', last_beat: judgement.lastBeat, silent_ms: judgement.silentMs, limit_ms: limitMs }, legacy: false })
}

export function recordSupervisorSilent(db: DatabaseSync, nowMs: number, lastBeat: string, silentMs: number): boolean {
  return recordJudged(db, new Date(nowMs).toISOString(), { process: SUPERVISOR_PROCESS, lastBeat, silentMs }, SUPERVISOR_SILENT_MS)
}

export interface HolderJudging {
  startOf: ProcessStartOf
  cards: CardTransitions
}

export class LivenessJudge {
  private lastBeat = Number.NEGATIVE_INFINITY
  private readonly restartedAt = new Map<string, number>()

  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly expected: () => ExpectedRunning, private readonly restart: (process: string) => Promise<string[]> = async () => [], private readonly holders?: HolderJudging, private readonly vitals: VitalsReading | null = null) {}

  async step(): Promise<string[]> {
    try {
      const nowMs = this.now()
      const ts = new Date(nowMs).toISOString()
      if (nowMs - this.lastBeat >= SUPERVISOR_BEAT_MS) {
        recordProcessHeartbeat(this.db, ts, SUPERVISOR_PROCESS, undefined, this.vitals)
        this.lastBeat = nowMs
      }
      const lines: string[] = []
      const silent = judgeSilent(currentLifeBeats(this.db, lastProcessBeats(this.db)), nowMs, this.expected())
      for (const name of this.restartedAt.keys()) {
        if (!silent.some(judgement => judgement.process === name))
          this.restartedAt.delete(name)
      }
      for (const judgement of silent) {
        if (recordJudged(this.db, ts, judgement))
          lines.push(`${PREFIX}${judgement.process} has not beaten for ${Math.round(judgement.silentMs / 60_000)} min (limit ${SILENT_MS / 60_000} min); judged silent as ${PROCESS_JUDGED}`)
        lines.push(...await this.restartDue(judgement.process, nowMs))
      }
      if (this.holders !== undefined)
        lines.push(...judgedLeaseLines(judgeHolders(this.db, this.holders.cards, ts, this.holders.startOf, SILENT_MS)))
      return lines
    }
    catch (error) {
      return [`${PREFIX}judging the heartbeats failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private async restartDue(name: string, nowMs: number): Promise<string[]> {
    const last = this.restartedAt.get(name)
    if (last !== undefined && nowMs - last < RESTART_RETRY_MS)
      return []
    this.restartedAt.set(name, nowMs)
    try {
      return await this.restart(name)
    }
    catch (error) {
      return [`${PREFIX}restarting ${name} failed: ${error instanceof Error ? error.message : String(error)}; retried in ${RESTART_RETRY_MS / 60_000} min while it stays silent`]
    }
  }
}
