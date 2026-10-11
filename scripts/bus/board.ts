import type { DatabaseSync } from 'node:sqlite'
import type { Choice, ParkingReads } from '../shift/parking.js'
import type { Queue } from './identifiers.js'
import path from 'node:path'
import { DEPENDS_FAILED, readParking } from '../shift/parking.js'
import { isLaneName } from './admissions.js'
import { CHAIN_OBSERVED } from './chain.js'
import { openBus } from './db.js'
import { MERGE_DONE } from './executor.js'
import { QUEUES } from './identifiers.js'
import { CARD_STARTED } from './inbox.js'
import { LEASE_FOLDS, RENEW_MS, TASK_COMPLETED, TASK_LEASED } from './lease.js'
import { CARD_ADMITTED } from './operator-work.js'
import { CARD_CLOSED, LEASED, QUEUED, TASK_FOLDS } from './queue.js'
import { projectionDump, reduce, reducedThrough, REJECTED } from './reducer.js'
import { REVIEW_RECORDED } from './review-worker.js'
import { ROLE_FOLDS, roleReadings } from './role.js'

export const BOARD_FILE = 'board.html'
export const FRESH_MS = RENEW_MS
export const NO_PROGRESS_MS = 30 * 60_000
export const CUTOVER = 'bus.cutover'
export const PROGRESS_EVENTS = [REVIEW_RECORDED, MERGE_DONE, 'pr.opened', 'pr.closed', CARD_STARTED, CARD_ADMITTED, CARD_CLOSED, TASK_COMPLETED] as const
export const MERGE_PAST_THE_BUS = 'merge past the bus'

export type Health = 'alive' | 'down' | 'unknown' | 'off'

export interface Watched {
  name: string
  actor: string | null
  queue: Queue | null
  pid: number | null
  wanted: boolean
}

export interface LaneParking {
  lane: string
  dir: string
  choice: Choice
}

export interface BoardSources {
  db: DatabaseSync
  now: Date
  watched: readonly Watched[]
  parking: readonly LaneParking[]
}

export interface QueueCard {
  card: string
  lane: string
  reason: string | null
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

export interface Board {
  at: string
  ready: QueueCard[]
  waiting: QueueCard[]
  blocked: QueueCard[]
  lanes: LaneRow[]
  window: ComponentHealth
  execution: ExecutionRow[]
  health: ComponentHealth[]
  progress: Progress
  contract: ContractLink[]
  queues: TaskQueue[]
}

const BLOCKING = ['waits question', 'waits boundary', 'waits fault', DEPENDS_FAILED.trim(), 'classify']
const CLOSED = 'closed'

const STAGE_WORKER: Record<string, string> = { 'review': 'review', 'awaiting merge': 'merge', 'fixes': 'answer' }

interface ChainLane {
  dir: string
  parking: string
  card_id: number
  state: string
  since: string | null
}

const CHAINS = `
  SELECT chains.dir, chains.parking, chains.card_id, chains.state,
    (SELECT min(seen.ts) FROM events AS seen WHERE seen.type = '${CHAIN_OBSERVED}' AND seen.card_id = chains.card_id AND json_extract(seen.payload, '$.dir') = chains.dir) AS since
  FROM chains ORDER BY chains.dir
`

const OPEN_PRS = `
  SELECT prs.pr, prs.card_id, prs.head, prs.ci, prs.verdict_on_head,
    (SELECT min(seen.ts) FROM events AS seen WHERE seen.type = 'pr.observed' AND seen.pr = prs.pr AND seen.head = prs.head
      AND json_extract(seen.payload, '$.ci') = prs.ci AND json_extract(seen.payload, '$.verdict_on_head') IS prs.verdict_on_head) AS since,
    (SELECT json_extract(recorded.payload, '$.verdict') || ' · ' || json_extract(recorded.payload, '$.depth') || CASE WHEN recorded.head = prs.head THEN '' ELSE ' (an earlier head)' END
      FROM events AS recorded WHERE recorded.type = '${REVIEW_RECORDED}' AND recorded.pr = prs.pr AND recorded.legacy = 0 ORDER BY recorded.id DESC LIMIT 1) AS review
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

const LEASED_TASKS = `
  SELECT tasks.task_key, tasks.card_id, tasks.lease_gen, leased.actor, leased.ts FROM tasks
  LEFT JOIN events AS leased ON leased.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = ? AND tasks.state = '${LEASED}' ORDER BY tasks.id
`

const WAITING_TASKS = `
  SELECT task_key, card_id FROM tasks WHERE queue = ? AND state = '${QUEUED}'
  ORDER BY CASE WHEN queue = 'review' THEN event_id ELSE id END
`

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n)
}

function ageMs(now: Date, ts: string | null): number {
  return ts === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(ts)
}

function isBlocking(reason: string): boolean {
  return BLOCKING.some(prefix => reason.startsWith(prefix))
}

function queueBlock(parking: readonly LaneParking[], inLanes: ReadonlySet<number>): Pick<Board, 'ready' | 'waiting' | 'blocked'> {
  const ready: QueueCard[] = []
  const waiting: QueueCard[] = []
  const blocked: QueueCard[] = []
  for (const { lane, choice } of parking) {
    ready.push(...choice.chosen.filter(task => !inLanes.has(Number(task.id))).map(task => ({ card: task.id, lane, reason: null })))
    for (const left of choice.left.filter(card => card.reason !== CLOSED))
      (isBlocking(left.reason) ? blocked : waiting).push({ card: left.id, lane, reason: left.reason })
  }
  return { ready, waiting, blocked }
}

function laneBlock(chains: readonly ChainLane[], parking: readonly LaneParking[]): LaneRow[] {
  const names = [...new Set([...parking.map(lane => lane.lane), ...chains.map(chain => path.basename(chain.parking))])].sort()
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

function executionBlock(db: DatabaseSync, chains: readonly ChainLane[], down: ReadonlySet<string>): ExecutionRow[] {
  const open = db.prepare(OPEN_PRS).all() as unknown as OpenPrRow[]
  const withPr = new Set(open.map(row => row.card_id))
  const writing = chains.filter(chain => chain.state !== 'stopped' && !withPr.has(chain.card_id))
    .map(chain => ({ card: chain.card_id, pr: null, stage: 'writing', since: chain.since, review: null, markers: [] }))
  const reviewed = open.map((row) => {
    const stage = stageOf(row)
    return { card: row.card_id, pr: row.pr, stage, since: row.since, review: row.review, markers: markersOf(stage, down) }
  })
  const past = (db.prepare(MERGED_PAST_THE_BUS).all() as { pr: number, ts: string, card_id: number | null, commit_sha: string | null }[])
    .filter(row => row.card_id !== null)
    .map(row => ({ card: row.card_id!, pr: row.pr, stage: `merged${row.commit_sha === null ? '' : ` ${row.commit_sha}`}`, since: row.ts, review: null, markers: [MERGE_PAST_THE_BUS] }))
  return [...writing, ...reviewed, ...past]
}

function progressOf(db: DatabaseSync, now: Date, health: readonly ComponentHealth[], blocked: readonly QueueCard[], ready: readonly QueueCard[]): Progress {
  const last = (db.prepare(`SELECT max(ts) AS ts FROM events WHERE legacy = 0 AND type IN (${PROGRESS_EVENTS.map(type => `'${type}'`).join(', ')})`).get() as { ts: string | null }).ts
  if (ageMs(now, last) < NO_PROGRESS_MS)
    return { last, stalled: false, cause: null }
  const down = health.filter(component => component.health === 'down').map(component => component.name)
  if (down.length > 0)
    return { last, stalled: true, cause: `down: ${down.join(', ')}` }
  if (ready.length === 0 && blocked.length > 0)
    return { last, stalled: true, cause: `queue blocked: ${blocked.map(card => `#${card.card} ${card.reason}`).join('; ')}` }
  return { last, stalled: true, cause: 'cause unknown' }
}

const FOLDED_ON_APPEND = new Set([...Object.keys(TASK_FOLDS), ...Object.keys(LEASE_FOLDS), ...Object.keys(ROLE_FOLDS), CHAIN_OBSERVED])
const EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'

export function replayMatches(db: DatabaseSync): boolean {
  const through = reducedThrough(db) === 0 ? Number.POSITIVE_INFINITY : reducedThrough(db)
  const replay = openBus(':memory:')
  try {
    const insert = replay.prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of db.prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY id`).all()) {
      if (Number(row.id) <= through || FOLDED_ON_APPEND.has(String(row.type)))
        insert.run(row.id, row.ts, row.type, row.actor, row.card_id, row.pr, row.head, row.dedupe_key, row.payload, row.legacy)
    }
    reduce(replay)
    return projectionDump(replay) === projectionDump(db)
  }
  finally {
    replay.close()
  }
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

function contractRow(db: DatabaseSync): ContractLink[] {
  const started = count(db, `SELECT count(*) AS n FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0`)
  const answered = count(db, `SELECT count(*) AS n FROM events WHERE type = '${TASK_COMPLETED}' AND legacy = 0 AND json_extract(payload, '$.queue') = 'answer'`)
  const shards = count(db, `SELECT count(*) AS n FROM events WHERE type = '${MERGE_DONE}' AND legacy = 0 AND json_extract(payload, '$.rule') != 'auto'`)
  const opened = count(db, `SELECT count(*) AS n FROM events WHERE type = 'pr.opened' AND legacy = 0`)
  const stateless = count(db, 'SELECT count(*) AS n FROM cards WHERE state IS NULL')
  const replayed = replayMatches(db)
  const rejected = count(db, `SELECT count(*) AS n FROM events WHERE type = '${REJECTED}'`)
  return [
    link('launch', started > 0, `${started} ${CARD_STARTED} from the bus`),
    link('answer', answered > 0, `${answered} answer tasks completed`),
    link('Shard', shards > 0, `${shards} ${MERGE_DONE} with a rule other than auto`),
    link('automaton', opened > 0 && stateless === 0, `${opened} pr.opened, ${stateless} cards without state`),
    writerLink(db),
    link('replay', replayed, replayed ? 'matches' : 'differs'),
    link(REJECTED, rejected === 0, `${rejected}`),
  ]
}

function taskQueues(db: DatabaseSync): TaskQueue[] {
  return QUEUES.map(queue => ({
    queue,
    leased: (db.prepare(LEASED_TASKS).all(queue) as { task_key: string, card_id: number, lease_gen: number, actor: string | null, ts: string | null }[])
      .map(row => ({ taskKey: row.task_key, card: row.card_id, holder: row.actor, leaseGen: row.lease_gen, since: row.ts })),
    waiting: (db.prepare(WAITING_TASKS).all(queue) as { task_key: string, card_id: number }[]).map(row => ({ taskKey: row.task_key, card: row.card_id })),
  })).filter(queue => queue.leased.length + queue.waiting.length > 0)
}

export function readBoard(sources: BoardSources): Board {
  const { db, now } = sources
  const chains = db.prepare(CHAINS).all() as unknown as ChainLane[]
  const inLanes = new Set(chains.filter(chain => chain.state !== 'stopped').map(chain => chain.card_id))
  const signs = lastSigns(db)
  const health = [
    ...sources.watched.map(watched => componentHealth(db, signs, now, watched)),
    roleHealth(db, now, 'operator', 'Operator'),
    roleHealth(db, now, 'miko', 'Miko'),
  ]
  const down = new Set(health.filter(component => component.health === 'down').map(component => component.name))
  const queue = queueBlock(sources.parking, inLanes)
  return {
    at: now.toISOString(),
    ...queue,
    lanes: laneBlock(chains, sources.parking),
    window: health.find(component => component.name === 'Operator')!,
    execution: executionBlock(db, chains, down),
    health,
    progress: progressOf(db, now, health, queue.blocked, queue.ready),
    contract: contractRow(db),
    queues: taskQueues(db),
  }
}

export function parkingLanes(reads: ParkingReads, root: string): LaneParking[] {
  if (!reads.exists(root))
    return []
  return reads.listDir(root).filter(isLaneName).sort().map((lane) => {
    const dir = path.join(root, lane)
    return { lane, dir, choice: readParking(reads, dir).choice }
  })
}
