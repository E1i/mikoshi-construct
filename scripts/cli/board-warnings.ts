import type { DatabaseSync } from 'node:sqlite'
import type { RecordedVerdict } from '../nodes/update/update-executor.js'
import type { GitHub } from '../ports/github.js'
import type { SlotKind } from '../supervisor/scheduler.js'
import { holdReason, plannedStalls, questionReleasedLine, questionReleasedOverlaps } from '../nodes/launch/launch-candidates.js'
import { REVIEW_RULES_VERSION } from '../nodes/review/review-executor.js'
import { recordedVerdictOn } from '../nodes/update/update-executor.js'
import { Meter } from '../ports/meter.js'
import { MAIN_BRANCH } from '../ports/snapshot.js'
import { slotsOf, slotsVariable } from '../supervisor/scheduler.js'
import { IN_FLIGHT_CARDS, stalledOf, stallLine } from '../window/watch.js'
import { windowOpenPrs } from '../window/window-prs.js'
import { rerunModeOf } from './check-catalog.js'

export type WarningLevel = 'amber' | 'red'

export interface BoardWarning {
  level: WarningLevel
  text: string
}

export interface SessionContext {
  who: string
  context: number
}

export interface WarningReadings {
  contexts: readonly SessionContext[]
  contextLimit: number | null
  warnRatio: number | null
  openPrs: number
  openPrLimit: number | null
  ownerWaits: number
  stalls: readonly string[]
  savingOff: boolean
  stalePasses?: number
}

export const SAVING_OFF_WARNING = 'BUS_RERUN=by-layers, но на main strict: true (или ruleset требует up-to-date) — экономия выключена'
export const LAUNCH_GATE_SLOTS: SlotKind = 'review'
export const UP_TO_DATE_READ_MS = 10 * 60_000
const REPO = 'repos/{owner}/{repo}'
export const MAIN_PROTECTION_ENDPOINT = `${REPO}/branches/${MAIN_BRANCH}/protection`
export const MAIN_RULES_ENDPOINT = `${REPO}/rules/branches/${MAIN_BRANCH}`
const REQUIRED_CHECKS_RULE = 'required_status_checks'
const THOUSAND = 1_000

function thousands(tokens: number): string {
  return `${Math.round(tokens / THOUSAND)}k`
}

function eddiesLine(limit: number | null, warnRatio: number | null): number | null {
  return limit === null || warnRatio === null || warnRatio > 1 ? null : limit * warnRatio
}

function contextWarning({ who, context }: SessionContext, limit: number | null, line: number | null): BoardWarning[] {
  const reading = `${who}: ctx ${thousands(context)}${limit === null ? '' : ` of ${thousands(limit)}`}`
  if (limit !== null && context > limit)
    return [{ level: 'red', text: `${reading}, over the limit` }]
  return line !== null && context >= line ? [{ level: 'amber', text: `${reading}, past the Eddies line ${thousands(line)}` }] : []
}

function openPrWarning(openPrs: number, limit: number | null): BoardWarning[] {
  return limit !== null && openPrs > limit ? [{ level: 'amber', text: `${openPrs} open PRs, over the limit of ${limit} from ${slotsVariable(LAUNCH_GATE_SLOTS)}` }] : []
}

function ownerWaitWarning(waits: number): BoardWarning[] {
  return waits === 0 ? [] : [{ level: 'amber', text: `${waits} open owner wait${waits === 1 ? '' : 's'}` }]
}

export function stalePassText(count: number): string {
  return `${count} open pass verdict${count === 1 ? '' : 's'} under review rules older than version ${REVIEW_RULES_VERSION}`
}

function stalePassWarning(count: number | undefined): BoardWarning[] {
  return count === undefined || count === 0 ? [] : [{ level: 'amber', text: stalePassText(count) }]
}

function underOlderRules(verdict: RecordedVerdict | null): boolean {
  return verdict === null || verdict.rulesVersion === null || verdict.rulesVersion < REVIEW_RULES_VERSION
}

const OPEN_PASS_HEADS = `SELECT pr, head FROM prs WHERE state = 'open' AND verdict_on_head = 'pass' AND head IS NOT NULL ORDER BY pr`

export function stalePassCountOf(db: DatabaseSync): number {
  return readOr(() => (db.prepare(OPEN_PASS_HEADS).all() as { pr: number, head: string }[]).filter(row => underOlderRules(recordedVerdictOn(db, Number(row.pr), row.head))).length, 0)
}

export function boardWarnings(readings: WarningReadings): BoardWarning[] {
  const line = eddiesLine(readings.contextLimit, readings.warnRatio)
  return [
    ...readings.contexts.flatMap(session => contextWarning(session, readings.contextLimit, line)),
    ...openPrWarning(readings.openPrs, readings.openPrLimit),
    ...ownerWaitWarning(readings.ownerWaits),
    ...readings.stalls.map((stall): BoardWarning => ({ level: 'amber', text: stall })),
    ...(readings.savingOff ? [{ level: 'amber', text: SAVING_OFF_WARNING } as const] : []),
    ...stalePassWarning(readings.stalePasses),
  ]
}

function readOr<T>(read: () => T, unread: T): T {
  try {
    return read()
  }
  catch {
    return unread
  }
}

export function openPrLimitOf(env: NodeJS.ProcessEnv): number | null {
  return readOr<number | null>(() => slotsOf(LAUNCH_GATE_SLOTS, env), null)
}

export function openPrCountOf(db: DatabaseSync): number {
  return readOr(() => windowOpenPrs(db).length, 0)
}

interface LastEventRow {
  card_id: number
  id: number
  type: string
  ts: string
}

function lastEventsOfCardsInFlight(db: DatabaseSync): LastEventRow[] {
  const states = IN_FLIGHT_CARDS.map(() => '?').join(', ')
  return db.prepare(`
    SELECT card_id, id, type, ts FROM events WHERE id IN (
      SELECT MAX(event.id) FROM events AS event JOIN cards AS card ON card.card_id = event.card_id
      WHERE card.state IN (${states}) AND event.id >= (SELECT COALESCE(MIN(event_id), 0) FROM cards WHERE state IN (${states}))
      GROUP BY event.card_id
    ) ORDER BY id
  `).all(...IN_FLIGHT_CARDS, ...IN_FLIGHT_CARDS) as unknown as LastEventRow[]
}

export function stallLines(db: DatabaseSync, pulse: string | null, now: Date): string[] {
  const rows = readOr(() => lastEventsOfCardsInFlight(db), [])
  const cards = rows.map(row => ({ cardId: Number(row.card_id), lastEventId: Number(row.id), lastType: row.type, lastTs: row.ts }))
  return stalledOf(cards, pulse ?? undefined, now.getTime()).map(stall => stallLine(stall, now.getTime()))
}

export function plannedStallLines(db: DatabaseSync, now: Date): string[] {
  const stalls = readOr(() => plannedStalls(db, now.getTime()), []).map(card => `#${card.cardId} planned and startable, not started for ${card.minutes} minutes: ${holdReason(card.hold)}`)
  return [...stalls, ...readOr(() => questionReleasedOverlaps(db, now.getTime()), []).map(questionReleasedLine)]
}

function protectionStrict(meter: Meter): boolean {
  return readOr(() => (meter.get(MAIN_PROTECTION_ENDPOINT) as { required_status_checks?: { strict?: unknown } | null } | null)?.required_status_checks?.strict === true, false)
}

interface BranchRule {
  type?: unknown
  parameters?: { strict_required_status_checks_policy?: unknown } | null
}

function rulesetStrict(meter: Meter): boolean {
  return readOr(() => {
    const rules = meter.get(MAIN_RULES_ENDPOINT)
    return Array.isArray(rules) && (rules as BranchRule[]).some(rule => rule.type === REQUIRED_CHECKS_RULE && rule.parameters?.strict_required_status_checks_policy === true)
  }, false)
}

export class MainUpToDate {
  private last: { at: number, required: boolean } | null = null

  constructor(private readonly gitHub: GitHub, private readonly nowMs: () => number) {}

  required(): boolean {
    const now = this.nowMs()
    if (this.last === null || now - this.last.at >= UP_TO_DATE_READ_MS) {
      const meter = new Meter(this.gitHub, this.nowMs)
      this.last = { at: now, required: protectionStrict(meter) || rulesetStrict(meter) }
    }
    return this.last.required
  }
}

export function savingOff(env: NodeJS.ProcessEnv, main: MainUpToDate): boolean {
  return readOr(() => rerunModeOf(env) === 'by-layers' && main.required(), false)
}
