import type { DatabaseSync } from 'node:sqlite'
import type { Goal } from '../../src/commands/board/goal.js'
import type { CardBodyLane, OpenCardWait } from '../core/card-readings.js'
import type { ChainState } from '../core/chain.js'
import type { EventRow } from '../core/events-query.js'
import type { WaitKind, WaitLifter } from '../core/events.js'
import type { Queue } from '../core/identifiers.js'
import type { LeaseOrder, PullHead } from '../core/lease.js'
import type { PrRow } from '../core/pr-readings.js'
import type { WindowShard } from '../policy/shards.js'
import { isLaneName } from '../../src/card/grammar.js'
import { goalOf } from '../../src/commands/board/goal.js'
import { DROPPED_CARD, FALLEN_CARD, MERGED_CARD, QUEUED_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { cardBodyLanes, cardStatesAmong, cardsWithTheirLines, openCardWaits } from '../core/card-readings.js'
import { chainOfCard, chainOfDir, WAITING } from '../core/chain.js'
import { BY_CARD, countOf, EITHER_JOURNAL, events, lastPer, lastTsPerActor, latest, latestTs } from '../core/events-query.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_WAITS, CHAIN_OBSERVED, CHAIN_RESTARTED, CUTOVER, MERGE_DONE, PR_CLOSED, PR_OBSERVED, PR_OPENED, REJECTED, RESTARTED, REVIEW_RECORDED, SESSION_HEARTBEAT, SHARD_DECIDED, TASK_COMPLETED, TASK_LEASED, WINDOW_HEARTBEAT } from '../core/events.js'
import { QUEUES } from '../core/identifiers.js'
import { RESTART_MISSED } from '../core/inbox.js'
import { grantOrder, RENEW_MS } from '../core/lease.js'
import { all as allPrs } from '../core/pr-readings.js'
import { LEASED } from '../core/queue.js'
import { replayDifferences } from '../core/report.js'
import { inStates as tasksInStates } from '../core/tasks-query.js'
import { cardContract } from '../intake/card-contract.js'
import { roleReadings } from '../nodes/restart/role.js'
import { activeWindowShards } from '../policy/shards.js'
import { ANY, BusRead } from '../ports/bus-read.js'
import { stillSilent } from '../supervisor/supervisor.js'

export const BOARD_FILE = 'board.html'
export const FRESH_MS = RENEW_MS
export const NO_PROGRESS_MS = 30 * 60_000
export const PAST_THE_BUS_SHOWN_MS = 24 * 60 * 60_000
export const PROGRESS_EVENTS = [REVIEW_RECORDED, MERGE_DONE, PR_OPENED, 'pr.closed', CARD_STARTED, CARD_ADMITTED, CARD_CLOSED, TASK_COMPLETED] as const
export const MERGE_PAST_THE_BUS = 'merge past the bus'
export const SILENT_PROCESS = 'silent process'

export type Health = 'alive' | 'down' | 'unknown' | 'off'

export interface Watched {
  name: string
  actor: string | null
  queue: Queue | null
  pid: number | null
  wanted: boolean
}

type Projections = Parameters<typeof replayDifferences>[1]

export interface BoardSources {
  db: DatabaseSync
  now: Date
  watched: readonly Watched[]
  leaseOrders: LeaseOrders
  projections: Projections
  pulls: readonly PullHead[]
}

export type LeaseOrders = Partial<Record<Queue, LeaseOrder>>

export interface CardWait {
  card: number
  lane: string
  kind: WaitKind
  lifter: WaitLifter
  detail: string
  since: string
  deadline: string
  event: number
}

export interface WaitsReading {
  at: number
  waits: CardWait[]
}

export interface QueueCard {
  card: string
  lane: string
  reason: string
  wait: CardWait
}

export interface ComponentHealth {
  name: string
  health: Health
  lastSign: string | null
  why: string
}

export interface ExecutionRow {
  card: number
  pr: number | null
  stage: string
  since: string | null
  review: string | null
  markers: string[]
}

export interface ContractLink {
  link: string
  green: boolean
  fact: string
}

export interface LeasedTask {
  taskKey: string
  card: number
  holder: string | null
  leaseGen: number
  since: string | null
}

export interface TaskQueue {
  queue: Queue
  leased: LeasedTask[]
  waiting: { taskKey: string, card: number }[]
}

export interface Progress {
  last: string | null
  stalled: boolean
  cause: string | null
}

export interface CardGauges {
  card: number
  ts: string
  context: number | null
  spent: number | null
  model: string | null
}

export interface WindowGauges {
  session: string | null
  ts: string
  context: number | null
  spent: number | null
  model: string | null
}

export interface ActiveShard extends WindowShard {
  leftMinutes: number
}

export interface ShardDecision {
  card: number
  shard: string
  wait: string
  answer: string
  ts: string
}

export interface Board {
  at: string
  goal: Goal | null
  ready: QueueCard[]
  waiting: QueueCard[]
  blocked: QueueCard[]
  waitsAt: number
  window: ComponentHealth
  shard: ActiveShard | null
  shardDecisions: ShardDecision[]
  execution: ExecutionRow[]
  health: ComponentHealth[]
  progress: Progress
  contract: ContractLink[]
  queues: TaskQueue[]
  gauges: CardGauges[]
  windowGauges: WindowGauges | null
}

const STAGE_WORKER: Record<string, string> = { 'review': 'review', 'awaiting merge': 'merge', 'fixes': 'answer' }

interface ChainRow {
  dir: string
  card_id: number
  state: ChainState
  since: string | null
  waiting_on: unknown[]
}

const SHOWN_SHARD_DECISIONS = 20

const ANSWER_QUEUE: Queue = 'answer'

const OPEN_PR = 'open'

const MERGED_PR = 'merged'

const AUTO_RULE = 'auto'

const CHAIN_STOPPED: ChainState = 'stopped'

const CHAINS_IN_WORK: readonly ChainState[] = ['running', 'fault']

const STANDING_STATES: readonly (string | null)[] = [null, QUEUED_CARD, FALLEN_CARD, STOPPED_CARD]

const MERGED_FLAGS: readonly unknown[] = [1, true]

const SHIFT_CARD = 'shift'

const FIRST_PRIORITY = 'p0'

function textOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function earliest(stamps: readonly (string | null)[]): string | null {
  return stamps.filter(ts => ts !== null).sort()[0] ?? null
}

function newest(stamps: readonly (string | null)[]): string | null {
  return stamps.filter(ts => ts !== null).sort().at(-1) ?? null
}

function idsByCard(rows: readonly EventRow[]): Map<number, EventRow> {
  return new Map(rows.flatMap(row => row.card_id === null ? [] : [[row.card_id, row] as const]))
}

function statesOf(db: DatabaseSync, cards: readonly number[]): (card: number) => string | null {
  const states = cardStatesAmong(db, [...new Set(cards)])
  return card => states.get(card) ?? null
}

function chainOf(db: DatabaseSync, dir: string): ChainRow | null {
  const chain = chainOfDir(db, dir)
  if (chain === undefined)
    return null
  const card = Number(chain.card_id)
  const observed = events(db, { types: [CHAIN_OBSERVED], card, legacy: EITHER_JOURNAL }).filter(row => row.data?.dir === dir)
  const waitingOn = chain.state === WAITING ? [...observed].reverse().find(row => row.data?.state === WAITING)?.data?.waitingOn : undefined
  return { dir, card_id: card, state: chain.state, since: earliest(observed.map(row => row.ts)), waiting_on: Array.isArray(waitingOn) ? waitingOn : [] }
}

function allChains(db: DatabaseSync): ChainRow[] {
  const observed = lastPer(db, '$.dir', { types: [CHAIN_OBSERVED, CHAIN_RESTARTED], legacy: EITHER_JOURNAL }).flatMap(row => typeof row.data?.dir === 'string' ? [row.data.dir] : [])
  const cards = new Set([...cardsWithTheirLines(db).map(card => card.id), ...cardBodyLanes(db).map(body => body.card_id)])
  const ofCards = [...cards].flatMap(card => chainOfCard(db, card)?.dir ?? [])
  return [...new Set([...observed, ...ofCards])].sort().flatMap(dir => chainOf(db, dir) ?? [])
}

function undroppedChains(db: DatabaseSync, chains: readonly ChainRow[]): ChainRow[] {
  const stateOf = statesOf(db, chains.map(chain => chain.card_id))
  return chains.filter(chain => stateOf(chain.card_id) !== DROPPED_CARD)
}

function mergedSinceItsLastStart(db: DatabaseSync, prs: readonly PrRow[]): (card: number) => boolean {
  const lastStart = idsByCard(lastPer(db, BY_CARD, { types: [CARD_STARTED], withCard: true }))
  const merged = prs.filter(pr => pr.state === MERGED_PR && pr.card_id !== null)
  return card => merged.some(pr => pr.card_id === card && pr.event_id > (lastStart.get(card)?.id ?? 0))
}

function cardsInWork(db: DatabaseSync, chains: readonly ChainRow[]): number[] {
  const lastClosed = idsByCard(lastPer(db, BY_CARD, { types: [CARD_CLOSED], withCard: true, legacy: EITHER_JOURNAL }))
  const started = lastPer(db, BY_CARD, { types: [CARD_STARTED], withCard: true })
    .filter(row => row.id > (lastClosed.get(row.card_id!)?.id ?? 0))
    .map(row => row.card_id!)
  const candidates = [...new Set([...chains.filter(chain => CHAINS_IN_WORK.includes(chain.state)).map(chain => chain.card_id), ...started])]
  const stateOf = statesOf(db, candidates)
  const merged = mergedSinceItsLastStart(db, allPrs(db))
  return candidates.filter(card => stateOf(card) !== DROPPED_CARD && stateOf(card) !== MERGED_CARD && !merged(card)).sort((a, b) => a - b)
}

interface OpenPrRow {
  open: PrRow
  card: number
  since: string | null
  review: string | null
  stop: string | null
}

function observedSince(db: DatabaseSync, pr: PrRow): string | null {
  if (pr.head === null || pr.ci === null)
    return null
  const seen = events(db, { types: [PR_OBSERVED], pr: pr.pr, head: pr.head, legacy: EITHER_JOURNAL })
    .filter(row => row.data?.ci === pr.ci && (row.data.verdict_on_head ?? null) === pr.verdict_on_head)
  return earliest(seen.map(row => row.ts))
}

function lastReviewOf(db: DatabaseSync, pr: PrRow): string | null {
  const recorded = latest(db, { types: [REVIEW_RECORDED], pr: pr.pr })
  const verdict = textOf(recorded?.data?.verdict)
  const depth = textOf(recorded?.data?.depth)
  if (recorded === null || verdict === null || depth === null)
    return null
  return `${verdict} · ${depth}${recorded.head !== null && recorded.head === pr.head ? '' : ' (an earlier head)'}`
}

function standingStopLine(db: DatabaseSync, card: number): string | null {
  const stop = latest(db, { types: [CARD_STOPPED], card })
  const reason = textOf(stop?.data?.reason)
  if (reason === null)
    return null
  const detail = textOf(stop?.data?.detail)
  return `stopped ${reason}${detail === null ? '' : `: ${detail}`}`
}

function openPrRows(db: DatabaseSync): OpenPrRow[] {
  const open = allPrs(db).filter(pr => pr.state === OPEN_PR && pr.card_id !== null)
  const stateOf = statesOf(db, open.map(pr => pr.card_id!))
  return open.map(pr => ({
    open: pr,
    card: pr.card_id!,
    since: observedSince(db, pr),
    review: lastReviewOf(db, pr),
    stop: stateOf(pr.card_id!) === STOPPED_CARD ? standingStopLine(db, pr.card_id!) : null,
  }))
}

interface MergedPastTheBus {
  pr: number | null
  ts: string | null
  card_id: number | null
  commit_sha: string | null
}

function mergedPastTheBus(db: DatabaseSync): MergedPastTheBus[] {
  const done = new Set(events(db, { types: [MERGE_DONE], withPr: true, legacy: EITHER_JOURNAL }).map(row => row.pr))
  const closed = events(db, { types: [PR_CLOSED] }).filter(row => MERGED_FLAGS.includes(row.data?.merged) && (row.pr === null || !done.has(row.pr)))
  return closed.sort((a, b) => (a.pr ?? Number.NEGATIVE_INFINITY) - (b.pr ?? Number.NEGATIVE_INFINITY)).map(row => ({
    pr: row.pr,
    ts: row.ts,
    card_id: row.card_id ?? (row.pr === null ? null : latest(db, { pr: row.pr, withCard: true, legacy: EITHER_JOURNAL })?.card_id ?? null),
    commit_sha: textOf(row.data?.commit),
  }))
}

interface Ahead {
  lane: string
  card: number
  pr: number
  event: number
  since: string | null
}

function aheadInLanes(db: DatabaseSync, bodies: readonly CardBodyLane[], prs: readonly PrRow[]): Ahead[] {
  const lanes = new Map(bodies.flatMap(body => body.lane === null ? [] : [[body.card_id, body.lane] as const]))
  const open = prs.filter(pr => pr.state === OPEN_PR && pr.card_id !== null && lanes.has(pr.card_id))
  const opened = new Map(events(db, { ids: open.map(pr => pr.event_id), legacy: EITHER_JOURNAL }).map(row => [row.id, row.ts] as const))
  return open.filter(pr => opened.has(pr.event_id))
    .map(pr => ({ lane: lanes.get(pr.card_id!)!, card: pr.card_id!, pr: pr.pr, event: pr.event_id, since: opened.get(pr.event_id) ?? null }))
}

function firstOpenWaits(waits: readonly OpenCardWait[]): Map<number, OpenCardWait> {
  const first = new Map<number, OpenCardWait>()
  for (const wait of waits) {
    if (!first.has(wait.card))
      first.set(wait.card, wait)
  }
  return first
}

function unmetOf(body: CardBodyLane, stateOf: (card: number) => string | null): string | null {
  const unmet = body.depends.filter(dep => stateOf(Number(dep)) !== MERGED_CARD).map(dep => `#${String(dep)}`)
  return unmet.length === 0 ? null : unmet.join(', ')
}

function standingRows(db: DatabaseSync): StandingRow[] {
  const bodies = cardBodyLanes(db)
  const prs = allPrs(db)
  const stateOf = statesOf(db, bodies.flatMap(body => [body.card_id, ...body.depends.map(Number)]))
  const live = new Set(allChains(db).filter(chain => chain.state !== CHAIN_STOPPED).map(chain => chain.card_id))
  const merged = mergedSinceItsLastStart(db, prs)
  const standing = bodies.filter(body => body.who === SHIFT_CARD && STANDING_STATES.includes(stateOf(body.card_id)) && !live.has(body.card_id) && !merged(body.card_id))
    .sort((a, b) => Number(a.priority !== FIRST_PRIORITY) - Number(b.priority !== FIRST_PRIORITY) || a.card_id - b.card_id)
  const stops = idsByCard(lastPer(db, BY_CARD, { types: [CARD_STOPPED], withCard: true }))
  const lasts = idsByCard(lastPer(db, BY_CARD, { withCard: true }))
  const owners = firstOpenWaits(openCardWaits(db))
  const ahead = aheadInLanes(db, bodies, prs)
  return standing.map((body) => {
    const stop = stops.get(body.card_id)
    const last = lasts.get(body.card_id)
    const owner = owners.get(body.card_id)
    const before = ahead.find(entry => entry.lane === body.lane && entry.card !== body.card_id)
    return {
      card_id: body.card_id,
      lane: body.lane,
      state: stateOf(body.card_id),
      unmet: unmetOf(body, stateOf),
      stop_id: stop?.id ?? null,
      stop_ts: stop?.ts ?? null,
      stop_reason: textOf(stop?.data?.reason),
      standing_id: last?.id ?? null,
      standing_ts: last?.ts ?? null,
      owner_id: owner?.id ?? null,
      owner_need: owner?.need ?? null,
      owner_since: owner?.since ?? null,
      owner_event: owner?.event_id ?? null,
      ahead_card: before?.card ?? null,
      ahead_pr: before?.pr ?? null,
      ahead_event: before?.event ?? null,
      ahead_since: before?.since ?? null,
    }
  })
}

interface LeasedRow {
  task_key: string
  card_id: number
  lease_gen: number
  actor: string | null
  ts: string | null
}

function leasedTasks(db: DatabaseSync, queue: Queue): LeasedRow[] {
  const tasks = tasksInStates(db, [LEASED]).filter(task => task.queue === queue)
  const keyOf = (task: { task_key: string, lease_gen: number }): string => `${TASK_LEASED}:${task.task_key}:${task.lease_gen}`
  const leased = new Map(events(db, { keys: tasks.map(keyOf), legacy: EITHER_JOURNAL }).map(row => [row.dedupe_key, row] as const))
  return tasks.map((task) => {
    const event = leased.get(keyOf(task))
    return { task_key: task.task_key, card_id: task.card_id, lease_gen: task.lease_gen, actor: event?.actor ?? null, ts: event?.ts ?? null }
  })
}

function ageMs(now: Date, ts: string | null): number {
  return ts === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(ts)
}

const WAIT_PROJECTIONS = ['cards', 'owner_waits'] as const

const WAIT_COLUMN: Record<WaitKind, keyof Pick<Board, 'ready' | 'waiting' | 'blocked'>> = { launch: 'ready', depends: 'waiting', lane: 'waiting', stopped: 'blocked', owner: 'blocked' }

const MINUTE_MS = 60_000

interface StandingRow {
  card_id: number
  lane: string | null
  state: string | null
  unmet: string | null
  stop_id: number | null
  stop_ts: string | null
  stop_reason: string | null
  standing_id: number | null
  standing_ts: string | null
  owner_id: string | null
  owner_need: string | null
  owner_since: string | null
  owner_event: number | null
  ahead_card: number | null
  ahead_pr: number | null
  ahead_event: number | null
  ahead_since: string | null
}

interface Opened {
  kind: WaitKind
  detail: string
  event: number
  since: string
}

function waitOf(card: number, lane: string, opened: Opened): CardWait {
  const term = CARD_WAITS[opened.kind]
  const deadline = new Date(Date.parse(opened.since) + term.deadlineMinutes * MINUTE_MS).toISOString()
  return { card, lane, kind: opened.kind, lifter: term.lifter, detail: opened.detail, since: opened.since, deadline, event: opened.event }
}

function openedWait(row: StandingRow, now: Date): Opened {
  if (row.owner_id !== null && row.owner_since !== null)
    return { kind: 'owner', detail: `${row.owner_id} ${row.owner_need ?? ''}`.trim(), event: Number(row.owner_event ?? 0), since: row.owner_since }
  if (row.state === STOPPED_CARD && row.stop_id !== null && row.stop_ts !== null)
    return { kind: 'stopped', detail: row.stop_reason ?? 'fault', event: Number(row.stop_id), since: row.stop_ts }
  const standing = { event: Number(row.standing_id ?? 0), since: row.standing_ts ?? now.toISOString() }
  if (row.state === STOPPED_CARD)
    return { kind: 'stopped', detail: 'fault', ...standing }
  if (row.unmet !== null)
    return { kind: 'depends', detail: `${row.unmet} not merged`, ...standing }
  if (row.ahead_card !== null && row.ahead_since !== null)
    return { kind: 'lane', detail: `behind #${row.ahead_card} PR #${row.ahead_pr}`, event: Number(row.ahead_event ?? 0), since: row.ahead_since }
  return { kind: 'launch', detail: 'startable', ...standing }
}

function copyEventOf(db: DatabaseSync): number {
  const reading = new BusRead(db).current(WAIT_PROJECTIONS, () => null)
  return reading.stale === null ? reading.at : reading.stale.through
}

export function cardWaits(db: DatabaseSync, now: Date): WaitsReading {
  const at = copyEventOf(db)
  const rows = standingRows(db).filter(row => row.lane !== null && isLaneName(row.lane))
  return { at, waits: rows.map(row => waitOf(Number(row.card_id), row.lane!, openedWait(row, now))) }
}

export function readAtLine(at: number): string {
  return `read at event ${at}`
}

export function waitText(wait: CardWait): string {
  return `${wait.kind} ${wait.detail}, the ${wait.lifter} lifts it by ${wait.deadline}`
}

function projectedQueue(db: DatabaseSync, now: Date): Pick<Board, 'ready' | 'waiting' | 'blocked' | 'waitsAt'> {
  const reading = cardWaits(db, now)
  const queue: Pick<Board, 'ready' | 'waiting' | 'blocked' | 'waitsAt'> = { ready: [], waiting: [], blocked: [], waitsAt: reading.at }
  for (const wait of reading.waits)
    queue[WAIT_COLUMN[wait.kind]].push({ card: String(wait.card), lane: wait.lane, reason: waitText(wait), wait })
  return queue
}

function lastSignOf(signs: ReadonlyMap<string, string>, actor: string | null): string | null {
  if (actor === null)
    return null
  const matching = [...signs].filter(([name]) => actor.endsWith(':') ? name.startsWith(actor) : name === actor).map(([, ts]) => ts)
  return matching.length === 0 ? null : matching.sort().at(-1)!
}

function liveLease(db: DatabaseSync, queue: Queue | null, now: Date): boolean {
  const at = now.toISOString()
  return queue !== null && tasksInStates(db, [LEASED]).some(task => task.queue === queue && task.lease_until !== null && task.lease_until > at)
}

function componentHealth(db: DatabaseSync, signs: ReadonlyMap<string, string>, now: Date, watched: Watched): ComponentHealth {
  const lastSign = lastSignOf(signs, watched.actor)
  if (watched.pid === null)
    return { name: watched.name, health: watched.wanted ? 'down' : 'off', lastSign, why: watched.wanted ? 'switched on, no process' : 'switched off' }
  if (ageMs(now, lastSign) <= FRESH_MS)
    return { name: watched.name, health: 'alive', lastSign, why: `pid ${watched.pid}, a fresh event` }
  if (liveLease(db, watched.queue, now))
    return { name: watched.name, health: 'alive', lastSign, why: `pid ${watched.pid}, a live lease` }
  return { name: watched.name, health: 'unknown', lastSign, why: `pid ${watched.pid}, no fresh event and no live lease` }
}

function roleHealth(db: DatabaseSync, now: Date, role: string, name: string): ComponentHealth {
  const reading = roleReadings(db).find(row => row.role === role)
  if (reading === undefined)
    return { name, health: 'unknown', lastSign: null, why: 'no role record in bus.db' }
  if (reading.lease_until !== null && reading.lease_until > now.toISOString())
    return { name, health: 'alive', lastSign: reading.ts, why: `${reading.state}, lease until ${reading.lease_until}` }
  if (reading.state === 'stopped' || reading.state === 'owner')
    return { name, health: 'down', lastSign: reading.ts, why: reading.state }
  return { name, health: 'unknown', lastSign: reading.ts, why: `${reading.state}${reading.pid === null ? '' : ` as pid ${reading.pid}`}, no fresh event and no live lease` }
}

function stageOf(row: PrRow): string {
  if (row.verdict_on_head === 'changes' || row.ci === 'red')
    return 'fixes'
  if (row.verdict_on_head === 'pass')
    return 'awaiting merge'
  if (row.ci === 'green')
    return 'review'
  return 'CI'
}

function markersOf(stage: string, down: ReadonlySet<string>): string[] {
  const worker = STAGE_WORKER[stage]
  return worker !== undefined && down.has(worker) ? [`${worker} down`] : []
}

function stageOfChain(chain: ChainRow): string {
  if (chain.state !== WAITING)
    return 'writing'
  return `waiting on ${chain.waiting_on.map(card => `#${String(card)}`).join(', ')}`
}

function executionBlock(db: DatabaseSync, now: Date, chains: readonly ChainRow[], down: ReadonlySet<string>): ExecutionRow[] {
  const open = openPrRows(db)
  const withPr = new Set(open.map(row => row.card))
  const writing = chains.filter(chain => chain.state !== 'stopped' && !withPr.has(chain.card_id))
    .map(chain => ({ card: chain.card_id, pr: null, stage: stageOfChain(chain), since: chain.since, review: null, markers: [] }))
  const reviewed = open.map((row) => {
    const stage = stageOf(row.open)
    return { card: row.card, pr: row.open.pr, stage, since: row.since, review: row.review, markers: [...markersOf(stage, down), ...(row.stop === null ? [] : [row.stop])] }
  })
  const past = mergedPastTheBus(db)
    .filter(row => row.card_id !== null && ageMs(now, row.ts) <= PAST_THE_BUS_SHOWN_MS)
    .map(row => ({ card: row.card_id!, pr: row.pr, stage: `merged${row.commit_sha === null ? '' : ` ${row.commit_sha}`}`, since: row.ts, review: null, markers: [MERGE_PAST_THE_BUS] }))
  return [...writing, ...reviewed, ...past]
}

function lastProgress(db: DatabaseSync, inWork: readonly number[]): string | null {
  if (inWork.length === 0)
    return latestTs(db, { types: PROGRESS_EVENTS })
  return newest(inWork.map(card => latestTs(db, { types: PROGRESS_EVENTS, card })))
}

function queueBlockedCause(inWork: readonly number[], blocked: readonly QueueCard[], ready: readonly QueueCard[]): string | null {
  const blocking = inWork.length === 0
    ? (ready.length === 0 ? blocked : [])
    : blocked.filter(card => inWork.includes(Number(card.card)))
  return blocking.length === 0 ? null : `queue blocked: ${blocking.map(card => `#${card.card} ${card.reason}`).join('; ')}`
}

function silentAtStep(db: DatabaseSync, now: Date, inWork: readonly number[]): string | null {
  const silent = inWork.flatMap((card) => {
    const beat = cardContract(db, card)?.lastHeartbeat
    if (beat === null || beat === undefined)
      return []
    const minutes = Math.floor(ageMs(now, lastProgress(db, [card]) ?? beat.ts) / 60_000)
    return [`#${card} no progress ${minutes} min, step ${beat.step ?? 'unknown'}`]
  })
  return silent.length === 0 ? null : silent.join('; ')
}

function progressOf(db: DatabaseSync, now: Date, chains: readonly ChainRow[], health: readonly ComponentHealth[], queue: Pick<Board, 'blocked' | 'ready'>): Progress {
  const { blocked, ready } = queue
  const inWork = cardsInWork(db, chains)
  const last = lastProgress(db, inWork)
  if (ageMs(now, last) < NO_PROGRESS_MS)
    return { last, stalled: false, cause: null }
  const down = health.filter(component => component.health === 'down').map(component => component.name)
  if (down.length > 0)
    return { last, stalled: true, cause: `down: ${down.join(', ')}` }
  const queueBlocked = queueBlockedCause(inWork, blocked, ready)
  if (queueBlocked !== null)
    return { last, stalled: true, cause: queueBlocked }
  if (inWork.length === 0)
    return { last, stalled: false, cause: null }
  return { last, stalled: true, cause: silentAtStep(db, now, inWork) ?? 'cause unknown' }
}

function link(name: string, green: boolean, fact: string): ContractLink {
  return { link: name, green, fact }
}

function writerLink(db: DatabaseSync): ContractLink {
  const cutover = events(db, { types: [CUTOVER], legacy: EITHER_JOURNAL, limit: 1 })[0]
  if (cutover === undefined)
    return link('one writer', false, `no ${CUTOVER} recorded`)
  const after = countOf(db, { legacy: true, since: cutover.id })
  return link('one writer', after === 0, `${after} legacy events after the cutover`)
}

function judgedSilentLink(db: DatabaseSync): ContractLink {
  const silent = stillSilent(db)
  return link(SILENT_PROCESS, silent.length === 0, silent.length === 0 ? 'no process judged silent' : `judged silent, no heartbeat since: ${silent.map(judged => `${judged.process} (last beat ${judged.lastBeat})`).join(', ')}`)
}

function replayLink(db: DatabaseSync, projections: Projections): ContractLink {
  const replayed = replayDifferences(db, projections).differences.length === 0
  return link('replay', replayed, replayed ? 'matches' : 'differs')
}

function contractRow(db: DatabaseSync, projections: Projections): ContractLink[] {
  const started = countOf(db, { types: [CARD_STARTED] })
  const answered = events(db, { types: [TASK_COMPLETED] }).filter(row => row.data?.queue === ANSWER_QUEUE).length
  const shards = events(db, { types: [MERGE_DONE] }).filter(row => textOf(row.data?.rule) !== null && row.data?.rule !== AUTO_RULE).length
  const opened = countOf(db, { types: [PR_OPENED] })
  const stateless = cardsWithTheirLines(db).filter(card => card.state === null).length
  const rejected = countOf(db, { types: [REJECTED], legacy: EITHER_JOURNAL })
  const lastRestart = latest(db, { types: [RESTARTED], legacy: EITHER_JOURNAL })?.id ?? 0
  const missed = countOf(db, { types: [RESTART_MISSED], since: lastRestart, legacy: EITHER_JOURNAL })
  return [
    link('launch', started > 0, `${started} ${CARD_STARTED} from the bus`),
    link('answer', answered > 0, `${answered} answer tasks completed`),
    link('Shard', shards > 0, `${shards} ${MERGE_DONE} with a rule other than auto`),
    link('automaton', opened > 0 && stateless === 0, `${opened} pr.opened, ${stateless} cards without state`),
    writerLink(db),
    replayLink(db, projections),
    link(REJECTED, rejected === 0, `${rejected}`),
    link(RESTART_MISSED, missed === 0, `${missed} restart${missed === 1 ? '' : 's'} after a merge under scripts/bus did not happen within the limit and no supervisor start on newer code followed`),
    judgedSilentLink(db),
  ]
}

function activeShard(db: DatabaseSync, now: Date): ActiveShard | null {
  const shard = activeWindowShards(db, now)[0]
  return shard === undefined ? null : { ...shard, leftMinutes: Math.ceil((Date.parse(shard.until) - now.getTime()) / 60_000) }
}

export function shardDecisions(db: DatabaseSync): ShardDecision[] {
  const stopped = new BusRead(db).where({ card: ANY, present: ['stop'], limit: SHOWN_SHARD_DECISIONS }).slice(SHARD_DECIDED, ['shard', 'wait', 'answer'], 'newest')
  return stopped.map(row => ({ card: row.card!, shard: String(row.fields.shard), wait: String(row.fields.wait), answer: String(row.fields.answer), ts: row.ts! }))
}

function taskQueues(db: DatabaseSync, pulls: readonly PullHead[], orders: LeaseOrders): TaskQueue[] {
  return QUEUES.map(queue => ({
    queue,
    leased: leasedTasks(db, queue)
      .map(row => ({ taskKey: row.task_key, card: row.card_id, holder: row.actor, leaseGen: row.lease_gen, since: row.ts })),
    waiting: grantOrder(db, pulls, queue, orders[queue]).map(task => ({ taskKey: task.taskKey, card: task.cardId })),
  })).filter(queue => queue.leased.length + queue.waiting.length > 0)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function cardGauges(db: DatabaseSync): CardGauges[] {
  const beats = new BusRead(db).where({ card: ANY }).slice(SESSION_HEARTBEAT, ['context', 'spent', 'model'], 'last-per-card')
  const gauges = beats.map(row => ({ card: row.card!, ts: row.ts!, context: numberOrNull(row.fields.context), spent: numberOrNull(row.fields.spent), model: textOrNull(row.fields.model) }))
  return gauges.filter(row => row.context !== null || row.spent !== null)
}

export function windowGauges(db: DatabaseSync): WindowGauges | null {
  const row = new BusRead(db).slice(WINDOW_HEARTBEAT, ['session', 'context', 'spent', 'model'], 'last')[0]
  if (row === undefined)
    return null
  const gauges = { session: textOrNull(row.fields.session), ts: row.ts!, context: numberOrNull(row.fields.context), spent: numberOrNull(row.fields.spent), model: textOrNull(row.fields.model) }
  return gauges.context === null && gauges.spent === null ? null : gauges
}

export function readBoard(sources: BoardSources): Board {
  const { db, now } = sources
  const chains = undroppedChains(db, allChains(db))
  const signs = lastTsPerActor(db)
  const health = [
    ...sources.watched.map(watched => componentHealth(db, signs, now, watched)),
    roleHealth(db, now, 'operator', 'Operator'),
    roleHealth(db, now, 'miko', 'Miko'),
  ]
  const down = new Set(health.filter(component => component.health === 'down').map(component => component.name))
  const queue = projectedQueue(db, now)
  return {
    at: now.toISOString(),
    goal: goalOf(db, now),
    ...queue,
    window: health.find(component => component.name === 'Operator')!,
    shard: activeShard(db, now),
    shardDecisions: shardDecisions(db),
    execution: executionBlock(db, now, chains, down),
    health,
    progress: progressOf(db, now, chains, health, queue),
    contract: contractRow(db, sources.projections),
    queues: taskQueues(db, sources.pulls, sources.leaseOrders),
    gauges: cardGauges(db),
    windowGauges: windowGauges(db),
  }
}
