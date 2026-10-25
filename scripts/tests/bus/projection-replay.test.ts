import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import { describe, expect, it } from 'vitest'
import { observeChain } from '../../core/chain.js'
import { appendEvent, openBus } from '../../core/db.js'
import { recordHeartbeat } from '../../supervisor/heartbeat.js'
import { withdrawLegacyLaunchTasks } from '../../nodes/launch/launch-withdraw.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext, releaseTask, renewLease } from '../../core/lease.js'
import { FAILURES_TO_STOP, queueTask } from '../../core/queue.js'
import { reduce, reducedThrough } from '../../core/reducer.js'
import { FOLDED_ON_APPEND, replayDifferences } from '../../core/report.js'
import { observeRoleStop, returnEndedRole, returnSilentRole, ROLE_FOLDS, roleToOwner } from '../../nodes/restart/role.js'
import { watermarkOf } from '../../core/watermark.js'
import { recordWindowHeartbeat } from '../../window/window-heartbeat.js'
import { requestFromWindow } from '../../window/window-requests.js'
import { MERGE_DONE, PR_OPENED, REVIEW_RECORDED } from '../../core/events.js'

const EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'
const START = Date.parse('2026-10-20T10:00:00.000Z')
const at = (ms: number): string => new Date(START + ms).toISOString()
const ACTOR = 'worker:restart:w'

function stop(db: DatabaseSync, ms: number, role: 'miko' | 'operator', handoff: string): void {
  observeRoleStop(db, at(ms), `worker:${role}:7`, { role, handoff, status: 'CONTINUE', reason: 'context', raised: false })
}

function liveRoles(): DatabaseSync {
  const db = openBus(':memory:')
  stop(db, 0, 'miko', '/handoff/miko.md')
  reduce(db)
  roleToOwner(db, at(10), ACTOR)
  requestFromWindow(db, at(20), 'owner-session', { kind: 'status' })
  recordWindowHeartbeat(db, at(30), 'owner-session')
  returnSilentRole(db, at(40 + LEASE_MS), ACTOR)
  stop(db, 50 + LEASE_MS, 'operator', '/handoff/operator.md')
  roleToOwner(db, at(60 + LEASE_MS), ACTOR)
  return db
}

function rolesOf(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT * FROM roles ORDER BY role').all()
}

function liveTasks(): DatabaseSync {
  const db = openBus(':memory:')
  for (const cardId of [1, 2, 3, 4])
    queueTask(db, at(0), { queue: 'launch', cardId, generation: `admission-${cardId}` })
  reduce(db)
  const done = leaseNext(db, at(1), 'launch', ACTOR)!
  renewLease(db, at(2), done)
  recordHeartbeat(db, at(3), { card: done.cardId, pr: null, head: null, step: 'launch', session: 'session-1', lease: { taskKey: done.taskKey, leaseGen: done.leaseGen } })
  completeTask(db, at(4), done, [])
  for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
    failTask(db, at(10 + failure), leaseNext(db, at(10 + failure), 'launch', ACTOR)!, { reason: 'session_failed', withdraw: false })
  releaseTask(db, at(20), leaseNext(db, at(20), 'launch', ACTOR)!, 'drain')
  leaseNext(db, at(30), 'launch', ACTOR)
  expireLeases(db, at(31 + LEASE_MS))
  withdrawLegacyLaunchTasks(db, at(40 + LEASE_MS))
  return db
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const CHAIN_ACTOR = 'worker:chain:9'

function cardEvent(ms: number, type: string, cardId: number, pr: number, payload: Record<string, unknown> = {}): BusEvent {
  return { ts: at(ms), type, actor: ACTOR, cardId, pr, head: SHA_A, dedupeKey: `${type}:${cardId}:${pr}:${ms}`, payload, legacy: false }
}

function liveChainsAndCards(): DatabaseSync {
  const db = openBus(':memory:')
  observeChain(db, at(0), CHAIN_ACTOR, { dir: '/chains/a', parking: 'lane-1', cardId: 1, sha: SHA_A, pid: 101, leader: null, boundary: false, state: 'running' })
  appendEvent(db, cardEvent(1, PR_OPENED, 1, 11))
  appendEvent(db, cardEvent(2, PR_OPENED, 2, 12))
  reduce(db)
  observeChain(db, at(3), CHAIN_ACTOR, { dir: '/chains/a', parking: 'lane-1', cardId: 1, sha: SHA_A, pid: 101, leader: 101, boundary: true, state: 'waiting', waitingOn: [2] })
  queueTask(db, at(4), { queue: 'launch', cardId: 2, generation: 'admission-2' })
  for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
    failTask(db, at(10 + failure), leaseNext(db, at(10 + failure), 'launch', ACTOR)!, { reason: 'session_failed', withdraw: false })
  queueTask(db, at(20), { queue: 'launch', cardId: 1, generation: 'admission-1' })
  completeTask(db, at(21), leaseNext(db, at(21), 'launch', ACTOR)!, [cardEvent(21, REVIEW_RECORDED, 1, 11, { verdict: 'pass' }), cardEvent(22, MERGE_DONE, 1, 11, { commit: SHA_B, rule: 'auto' })])
  observeChain(db, at(30), CHAIN_ACTOR, { dir: '/chains/b', parking: 'lane-2', cardId: 2, sha: SHA_B, pid: 202, leader: 202, boundary: false, state: 'stopped' })
  return db
}

function chainsAndCardsOf(db: DatabaseSync): unknown {
  return { chains: db.prepare('SELECT * FROM chains ORDER BY dir').all(), cards: db.prepare('SELECT * FROM cards ORDER BY card_id').all() }
}

function tasksOf(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT * FROM tasks ORDER BY task_key').all()
}

function rebuiltThrough(live: DatabaseSync, watermark: number): DatabaseSync {
  const clean = openBus(':memory:')
  const insert = clean.prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of live.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id <= ? ORDER BY id`).all(watermark))
    insert.run(row.id, row.ts, row.type, row.actor, row.card_id, row.pr, row.head, row.dedupe_key, row.payload, row.legacy)
  reduce(clean)
  return clean
}

describe('roles are a projection the reducer alone writes', () => {
  it('roles rebuilt by the reducer alone from a clean db equal the live roles at one watermark', () => {
    const live = liveRoles()
    const watermark = watermarkOf(live, 'roles')
    expect(watermark).toBeGreaterThan(reducedThrough(live))
    const clean = rebuiltThrough(live, watermark)
    expect(clean.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected' AND json_extract(payload, '$.type') LIKE 'role.%'`).get()).toEqual({ n: 0 })
    expect(rolesOf(clean)).toEqual(rolesOf(live))
    expect(rolesOf(live).map(row => (row as { state: string }).state)).toEqual(['owner', 'stopped'])
    clean.close()
    live.close()
  })

  it('the roles replay needs no fold-on-append compensation', () => {
    expect(Object.keys(ROLE_FOLDS).filter(type => FOLDED_ON_APPEND.has(type))).toEqual([])
    const db = liveRoles()
    expect(reducedThrough(db)).toBeLessThan(watermarkOf(db, 'roles'))
    expect(replayDifferences(db).differences).toEqual([])
    stop(db, 70 + LEASE_MS, 'miko', '/handoff/miko.md')
    returnEndedRole(db, at(80 + LEASE_MS), ACTOR, 'miko', 'close')
    stop(db, 90 + LEASE_MS, 'operator', '/handoff/operator.md')
    expect(replayDifferences(db).differences).toEqual([])
    reduce(db)
    expect(watermarkOf(db, 'roles')).toBe(reducedThrough(db))
    expect(reducedThrough(db)).toBe(db.prepare('SELECT max(id) AS id FROM events').get()!.id)
    expect(replayDifferences(db).differences).toEqual([])
    db.close()
  })
})

describe('tasks are a projection the reducer alone writes', () => {
  it('tasks rebuilt by the reducer alone equal the live projection', () => {
    const live = liveTasks()
    const watermark = watermarkOf(live, 'tasks')
    expect(watermark).toBeGreaterThan(reducedThrough(live))
    const clean = rebuiltThrough(live, watermark)
    expect(clean.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected' AND (json_extract(payload, '$.type') LIKE 'task.%' OR json_extract(payload, '$.type') = 'session.heartbeat')`).get()).toEqual({ n: 0 })
    expect(tasksOf(clean)).toEqual(tasksOf(live))
    expect(tasksOf(live).map(row => (row as { state: string }).state)).toEqual(['completed', 'withdrawn', 'withdrawn', 'withdrawn'])
    expect(replayDifferences(live).differences).toEqual([])
    clean.close()
    live.close()
  })
})

describe('chains and cards are projections the reducer alone writes', () => {
  it('chains and cards rebuilt by the reducer alone equal the live projection', () => {
    const live = liveChainsAndCards()
    const through = reducedThrough(live)
    expect(watermarkOf(live, 'chains')).toBeGreaterThan(through)
    expect(watermarkOf(live, 'cards')).toBeGreaterThan(through)
    const clean = rebuiltThrough(live, Math.max(watermarkOf(live, 'chains'), watermarkOf(live, 'cards')))
    expect(clean.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected'`).get()).toEqual({ n: 0 })
    expect(chainsAndCardsOf(clean)).toEqual(chainsAndCardsOf(live))
    const { chains, cards } = chainsAndCardsOf(live) as { chains: { state: string }[], cards: { state: string }[] }
    expect(chains.map(row => row.state)).toEqual(['waiting', 'stopped'])
    expect(cards.map(row => row.state)).toEqual(['merged', 'stopped'])
    expect(replayDifferences(live).differences).toEqual([])
    clean.close()
    live.close()
  })
})
