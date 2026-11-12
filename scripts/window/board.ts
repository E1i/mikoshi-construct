import type { DatabaseSync } from 'node:sqlite'
import type { Goal } from '../../src/commands/board/goal.js'
import type { WaitKind, WaitLifter } from '../core/events.js'
import type { Queue } from '../core/identifiers.js'
import type { LeaseOrder } from '../core/lease.js'
import type { WindowShard } from '../policy/shards.js'
import path from 'node:path'
import { goalOf } from '../../src/commands/board/goal.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { DROPPED_CARD, FALLEN_CARD, MERGED_CARD, QUEUED_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { WAITING } from '../core/chain.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_WAITS, CHAIN_OBSERVED, CUTOVER, MERGE_DONE, OWNER_WAIT_CLOSED, PR_OPENED, REJECTED, RESTARTED, REVIEW_RECORDED, SESSION_HEARTBEAT, SHARD_DECIDED, TASK_COMPLETED, TASK_LEASED, WINDOW_HEARTBEAT } from '../core/events.js'
import { QUEUES } from '../core/identifiers.js'
import { RESTART_MISSED } from '../core/inbox.js'
import { grantOrder, RENEW_MS } from '../core/lease.js'
import { LEASED } from '../core/queue.js'
import { replayDifferences } from '../core/report.js'
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
  projections?: Projections
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

export interface LaneRow {
  lane: string
  card: number | null
  state: string | null
  since: string | null
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
  lanes: LaneRow[]
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

interface ChainLane {
  dir: string
  parking: string
  card_id: number
  state: string
  since: string | null
  waiting_on: string | null
}

function mergedSinceItsLastStart(card: string): string {
  return `EXISTS (SELECT 1 FROM prs AS merged WHERE merged.card_id = ${card} AND merged.state = 'merged'
    AND merged.event_id > (SELECT coalesce(max(last_start.id), 0) FROM events AS last_start WHERE last_start.type = '${CARD_STARTED}' AND last_start.legacy = 0 AND last_start.card_id = ${card}))`
}

const CHAINS = `
  SELECT chains.dir, chains.parking, chains.card_id, chains.state,
    (SELECT min(seen.ts) FROM events AS seen WHERE seen.type = '${CHAIN_OBSERVED}' AND seen.card_id = chains.card_id AND json_extract(seen.payload, '$.dir') = chains.dir) AS since,
    (SELECT json_extract(folded.payload, '$.waitingOn') FROM events AS folded WHERE folded.id = chains.event_id) AS waiting_on
  FROM chains
  WHERE NOT EXISTS (SELECT 1 FROM cards WHERE cards.card_id = chains.card_id AND cards.state = '${DROPPED_CARD}')
  ORDER BY chains.dir
`

const CARDS_IN_WORK = `
  SELECT card_id FROM (
    SELECT card_id FROM chains WHERE state IN ('running', 'fault')
    UNION
    SELECT started.card_id FROM events AS started
    WHERE started.type = '${CARD_STARTED}' AND started.legacy = 0 AND started.card_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = started.card_id AND closed.id > started.id)
  ) AS work
  WHERE NOT EXISTS (SELECT 1 FROM cards WHERE cards.card_id = work.card_id AND cards.state IN ('${DROPPED_CARD}', '${MERGED_CARD}'))
    AND NOT ${mergedSinceItsLastStart('work.card_id')}
`

const OPEN_PRS = `
  SELECT prs.pr, prs.card_id, prs.head, prs.ci, prs.verdict_on_head,
    (SELECT min(seen.ts) FROM events AS seen WHERE seen.type = 'pr.observed' AND seen.pr = prs.pr AND seen.head = prs.head
      AND json_extract(seen.payload, '$.ci') = prs.ci AND json_extract(seen.payload, '$.verdict_on_head') IS prs.verdict_on_head) AS since,
    (SELECT json_extract(recorded.payload, '$.verdict') || ' · ' || json_extract(recorded.payload, '$.depth') || CASE WHEN recorded.head = prs.head THEN '' ELSE ' (an earlier head)' END
      FROM events AS recorded WHERE recorded.type = '${REVIEW_RECORDED}' AND recorded.pr = prs.pr AND recorded.legacy = 0 ORDER BY recorded.id DESC LIMIT 1) AS review,
    (SELECT 'stopped ' || json_extract(stop.payload, '$.reason') || coalesce(': ' || json_extract(stop.payload, '$.detail'), '')
      FROM cards JOIN events AS stop ON stop.card_id = cards.card_id AND stop.type = '${CARD_STOPPED}' AND stop.legacy = 0
      WHERE cards.card_id = prs.card_id AND cards.state = '${STOPPED_CARD}' ORDER BY stop.id DESC LIMIT 1) AS stop
  FROM prs WHERE prs.state = 'open' AND prs.card_id IS NOT NULL ORDER BY prs.pr
`

const MERGED_PAST_THE_BUS = `
  SELECT closed.pr, closed.ts,
    coalesce(closed.card_id, (SELECT named.card_id FROM events AS named WHERE named.pr = closed.pr AND named.card_id IS NOT NULL ORDER BY named.id DESC LIMIT 1)) AS card_id,
    json_extract(closed.payload, '$.commit') AS commit_sha
  FROM events AS closed
  WHERE closed.type = 'pr.closed' AND closed.legacy = 0 AND json_extract(closed.payload, '$.merged') = 1
    AND NOT EXISTS (SELECT 1 FROM events AS done WHERE done.type = '${MERGE_DONE}' AND done.pr = closed.pr)
  ORDER BY closed.pr
`

const PROJECTED_QUEUE = `
  WITH stop AS (SELECT card_id, id, ts, json_extract(payload, '$.reason') AS reason FROM events
      WHERE id IN (SELECT max(id) FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id IS NOT NULL GROUP BY card_id)),
    standing AS (SELECT card_id, id, ts FROM events WHERE id IN (SELECT max(id) FROM events WHERE legacy = 0 AND card_id IS NOT NULL GROUP BY card_id)),
    owner AS (SELECT wait.card_id, wait.id, wait.need, wait.opened_at, wait.event_id FROM owner_waits AS wait
      WHERE wait.state = 'open' AND wait.card_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND closed.legacy = 0 AND json_valid(closed.payload) AND json_extract(closed.payload, '$.id') = wait.id)),
    ahead AS (SELECT other.lane, other.card_id, prs.pr, opened.id, opened.ts FROM card_bodies AS other
      JOIN prs ON prs.card_id = other.card_id AND prs.state = 'open' JOIN events AS opened ON opened.id = prs.event_id)
  SELECT body.card_id, body.lane, cards.state,
    (SELECT group_concat('#' || dep.value, ', ') FROM json_each(body.depends) AS dep
      WHERE NOT EXISTS (SELECT 1 FROM cards AS done WHERE done.card_id = dep.value AND done.state = '${MERGED_CARD}')) AS unmet,
    stop.id AS stop_id, stop.ts AS stop_ts, stop.reason AS stop_reason,
    standing.id AS standing_id, standing.ts AS standing_ts,
    (SELECT owner.id FROM owner WHERE owner.card_id = body.card_id ORDER BY owner.event_id LIMIT 1) AS owner_id,
    (SELECT owner.need FROM owner WHERE owner.card_id = body.card_id ORDER BY owner.event_id LIMIT 1) AS owner_need,
    (SELECT owner.opened_at FROM owner WHERE owner.card_id = body.card_id ORDER BY owner.event_id LIMIT 1) AS owner_since,
    (SELECT owner.event_id FROM owner WHERE owner.card_id = body.card_id ORDER BY owner.event_id LIMIT 1) AS owner_event,
    (SELECT ahead.card_id FROM ahead WHERE ahead.lane = body.lane AND ahead.card_id != body.card_id ORDER BY ahead.pr LIMIT 1) AS ahead_card,
    (SELECT ahead.pr FROM ahead WHERE ahead.lane = body.lane AND ahead.card_id != body.card_id ORDER BY ahead.pr LIMIT 1) AS ahead_pr,
    (SELECT ahead.id FROM ahead WHERE ahead.lane = body.lane AND ahead.card_id != body.card_id ORDER BY ahead.pr LIMIT 1) AS ahead_event,
    (SELECT ahead.ts FROM ahead WHERE ahead.lane = body.lane AND ahead.card_id != body.card_id ORDER BY ahead.pr LIMIT 1) AS ahead_since
  FROM card_bodies AS body LEFT JOIN cards ON cards.card_id = body.card_id
  LEFT JOIN stop ON stop.card_id = body.card_id LEFT JOIN standing ON standing.card_id = body.card_id
  WHERE body.who = 'shift' AND (cards.state IS NULL OR cards.state IN ('${QUEUED_CARD}', '${FALLEN_CARD}', '${STOPPED_CARD}'))
    AND NOT EXISTS (SELECT 1 FROM chains WHERE chains.card_id = body.card_id AND chains.state != 'stopped')
    AND NOT ${mergedSinceItsLastStart('body.card_id')}
  ORDER BY body.priority IS NOT 'p0', body.lane, body.card_id
`

const LEASED_TASKS = `
  SELECT tasks.task_key, tasks.card_id, tasks.lease_gen, leased.actor, leased.ts FROM tasks
  LEFT JOIN events AS leased ON leased.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = ? AND tasks.state = '${LEASED}' ORDER BY tasks.id
`

const SHOWN_SHARD_DECISIONS = 20

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n)
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
  const rows = (db.prepare(PROJECTED_QUEUE).all() as unknown as StandingRow[]).filter(row => row.lane !== null && isLaneName(row.lane))
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

function laneBlock(chains: readonly ChainLane[]): LaneRow[] {
  const names = [...new Set(chains.map(chain => path.basename(chain.parking)))].sort()
  return names.map((lane) => {
    const active = chains.find(chain => path.basename(chain.parking) === lane && chain.state !== 'stopped')
    return active === undefined ? { lane, card: null, state: null, since: null } : { lane, card: active.card_id, state: active.state, since: active.since }
  })
}

function lastSigns(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare(`SELECT actor, max(ts) AS ts FROM events WHERE legacy = 0 AND actor IS NOT NULL GROUP BY actor`).all() as { actor: string, ts: string }[]
  return new Map(rows.map(row => [row.actor, row.ts]))
}

function lastSignOf(signs: ReadonlyMap<string, string>, actor: string | null): string | null {
  if (actor === null)
    return null
  const matching = [...signs].filter(([name]) => actor.endsWith(':') ? name.startsWith(actor) : name === actor).map(([, ts]) => ts)
  return matching.length === 0 ? null : matching.sort().at(-1)!
}

function liveLease(db: DatabaseSync, queue: Queue | null, now: Date): boolean {
  return queue !== null && count(db, `SELECT count(*) AS n FROM tasks WHERE queue = ? AND state = '${LEASED}' AND lease_until > ?`, queue, now.toISOString()) > 0
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

interface OpenPrRow {
  pr: number
  card_id: number
  ci: string | null
  verdict_on_head: string | null
  since: string | null
  review: string | null
  stop: string | null
}

function stageOf(row: OpenPrRow): string {
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

function stageOfChain(chain: ChainLane): string {
  if (chain.state !== WAITING)
    return 'writing'
  const cards = JSON.parse(chain.waiting_on ?? '[]') as number[]
  return `waiting on ${cards.map(card => `#${card}`).join(', ')}`
}

function executionBlock(db: DatabaseSync, now: Date, chains: readonly ChainLane[], down: ReadonlySet<string>): ExecutionRow[] {
  const open = db.prepare(OPEN_PRS).all() as unknown as OpenPrRow[]
  const withPr = new Set(open.map(row => row.card_id))
  const writing = chains.filter(chain => chain.state !== 'stopped' && !withPr.has(chain.card_id))
    .map(chain => ({ card: chain.card_id, pr: null, stage: stageOfChain(chain), since: chain.since, review: null, markers: [] }))
  const reviewed = open.map((row) => {
    const stage = stageOf(row)
    return { card: row.card_id, pr: row.pr, stage, since: row.since, review: row.review, markers: [...markersOf(stage, down), ...(row.stop === null ? [] : [row.stop])] }
  })
  const past = (db.prepare(MERGED_PAST_THE_BUS).all() as { pr: number, ts: string, card_id: number | null, commit_sha: string | null }[])
    .filter(row => row.card_id !== null && ageMs(now, row.ts) <= PAST_THE_BUS_SHOWN_MS)
    .map(row => ({ card: row.card_id!, pr: row.pr, stage: `merged${row.commit_sha === null ? '' : ` ${row.commit_sha}`}`, since: row.ts, review: null, markers: [MERGE_PAST_THE_BUS] }))
  return [...writing, ...reviewed, ...past]
}

function lastProgress(db: DatabaseSync, inWork: readonly number[]): string | null {
  const ofCardsInWork = inWork.length === 0 ? '' : ` AND card_id IN (${inWork.join(', ')})`
  return (db.prepare(`SELECT max(ts) AS ts FROM events WHERE legacy = 0 AND type IN (${PROGRESS_EVENTS.map(type => `'${type}'`).join(', ')})${ofCardsInWork}`).get() as { ts: string | null }).ts
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

function progressOf(db: DatabaseSync, now: Date, health: readonly ComponentHealth[], blocked: readonly QueueCard[], ready: readonly QueueCard[]): Progress {
  const inWork = (db.prepare(CARDS_IN_WORK).all() as { card_id: number }[]).map(row => row.card_id)
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
  const cutover = db.prepare(`SELECT id FROM events WHERE type = '${CUTOVER}' ORDER BY id LIMIT 1`).get() as { id: number } | undefined
  if (cutover === undefined)
    return link('one writer', false, `no ${CUTOVER} recorded`)
  const after = count(db, 'SELECT count(*) AS n FROM events WHERE legacy = 1 AND id > ?', cutover.id)
  return link('one writer', after === 0, `${after} legacy events after the cutover`)
}

function judgedSilentLink(db: DatabaseSync): ContractLink {
  const silent = stillSilent(db)
  return link(SILENT_PROCESS, silent.length === 0, silent.length === 0 ? 'no process judged silent' : `judged silent, no heartbeat since: ${silent.map(judged => `${judged.process} (last beat ${judged.lastBeat})`).join(', ')}`)
}

function replayLink(db: DatabaseSync, projections: Projections | undefined): ContractLink {
  if (projections === undefined)
    return link('replay', false, 'not replayed: this reading was given no projection list')
  const replayed = replayDifferences(db, projections).differences.length === 0
  return link('replay', replayed, replayed ? 'matches' : 'differs')
}

function contractRow(db: DatabaseSync, projections: Projections | undefined): ContractLink[] {
  const started = count(db, `SELECT count(*) AS n FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0`)
  const answered = count(db, `SELECT count(*) AS n FROM events WHERE type = '${TASK_COMPLETED}' AND legacy = 0 AND json_extract(payload, '$.queue') = 'answer'`)
  const shards = count(db, `SELECT count(*) AS n FROM events WHERE type = '${MERGE_DONE}' AND legacy = 0 AND json_extract(payload, '$.rule') != 'auto'`)
  const opened = count(db, `SELECT count(*) AS n FROM events WHERE type = '${PR_OPENED}' AND legacy = 0`)
  const stateless = count(db, 'SELECT count(*) AS n FROM cards WHERE state IS NULL')
  const rejected = count(db, `SELECT count(*) AS n FROM events WHERE type = '${REJECTED}'`)
  const missed = count(db, `SELECT count(*) AS n FROM events WHERE type = '${RESTART_MISSED}' AND id > (SELECT coalesce(max(id), 0) FROM events WHERE type = '${RESTARTED}')`)
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

function taskQueues(db: DatabaseSync, orders: LeaseOrders): TaskQueue[] {
  return QUEUES.map(queue => ({
    queue,
    leased: (db.prepare(LEASED_TASKS).all(queue) as { task_key: string, card_id: number, lease_gen: number, actor: string | null, ts: string | null }[])
      .map(row => ({ taskKey: row.task_key, card: row.card_id, holder: row.actor, leaseGen: row.lease_gen, since: row.ts })),
    waiting: grantOrder(db, queue, orders[queue]).map(task => ({ taskKey: task.taskKey, card: task.cardId })),
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
  const chains = db.prepare(CHAINS).all() as unknown as ChainLane[]
  const signs = lastSigns(db)
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
    lanes: laneBlock(chains),
    window: health.find(component => component.name === 'Operator')!,
    shard: activeShard(db, now),
    shardDecisions: shardDecisions(db),
    execution: executionBlock(db, now, chains, down),
    health,
    progress: progressOf(db, now, health, queue.blocked, queue.ready),
    contract: contractRow(db, sources.projections),
    queues: taskQueues(db, sources.leaseOrders),
    gauges: cardGauges(db),
    windowGauges: windowGauges(db),
  }
}
