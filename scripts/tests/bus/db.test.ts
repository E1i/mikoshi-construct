import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { Node, NodeStep } from '../../core/node.js'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, BUSY_TIMEOUT_MS, CACHE_KIB, inTransaction, openBus, openOwnerWait, OWNER_WAITS } from '../../core/db.js'
import { CARD_WAITING, WITNESS_DOWNGRADE } from '../../core/events.js'
import { FACTORY_FOLDERS } from '../../core/factory-paths.js'
import { cardIdOf, isActor, taskKey } from '../../core/identifiers.js'
import { closeWaitsOfEndedCards, DIRTY_ROWS, reduce, SNAPSHOT } from '../../core/reducer.js'
import { CloseNode } from '../../nodes/close/close-worker.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { MergeNode } from '../../nodes/merge/merge-worker.js'
import { ReviewNode } from '../../nodes/review/review-worker.js'
import { UpdateNode } from '../../nodes/update/update-worker.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { TICK_MS } from '../../ports/netwatch.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const WAIT_ON_MAIN_MS = 5000
const LOCK_HELD_MS = WAIT_ON_MAIN_MS + 1000
const HOLDS_THE_WRITE_LOCK = `
const { DatabaseSync } = require('node:sqlite')
const { workerData } = require('node:worker_threads')
const db = new DatabaseSync(workerData.file)
db.exec('BEGIN IMMEDIATE')
Atomics.store(workerData.signal, 0, 1)
Atomics.notify(workerData.signal, 0)
Atomics.wait(workerData.signal, 1, 0, workerData.holdMs)
db.exec('COMMIT')
db.close()
`
const roots: string[] = []
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const SQLITE_LOADER = 'scripts/core/sqlite.ts'
const OPENED_BEFORE_THE_CONTOURS = ['scripts/window/eddies-measure.ts', 'scripts/window/watch-store.ts']

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-db-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function observed(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    ts: '2026-10-09T12:00:00.000Z',
    type: 'pr.observed',
    actor: 'netwatch',
    cardId: 792,
    pr: 800,
    head: HEAD,
    dedupeKey: 'pr:800:abc',
    payload: { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false },
    legacy: false,
    ...overrides,
  }
}

function plansOf(db: DatabaseSync, sql: string): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => String(row.detail))
}

function scansEvents(db: DatabaseSync, sql: string): boolean {
  const names = new Set(['events', ...[...sql.matchAll(/\bevents AS (\w+)/g)].map(found => found[1])])
  return plansOf(db, sql).some(detail => /^SCAN (\w+)/.exec(detail) !== null && names.has(/^SCAN (\w+)/.exec(detail)![1]))
}

type QuietNode = (db: DatabaseSync, clock: () => Date) => { node: Node<NodeStep>, prototype: object }

function shadowParts(db: DatabaseSync, clock: () => Date): never {
  return { db, clock, session: 'idle', mode: 'shadow', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), lanes: () => 2 } as never
}

const QUIET_NODES: Record<string, QuietNode> = {
  launch: (db, clock) => ({ node: new LaunchNode({ ...shadowParts(db, clock) as object, mode: 'live' } as never), prototype: LaunchNode.prototype }),
  review: (db, clock) => ({ node: new ReviewNode(shadowParts(db, clock)), prototype: ReviewNode.prototype }),
  merge: (db, clock) => ({ node: new MergeNode(shadowParts(db, clock)), prototype: MergeNode.prototype }),
  update: (db, clock) => ({ node: new UpdateNode(shadowParts(db, clock)), prototype: UpdateNode.prototype }),
  close: (db, clock) => ({ node: new CloseNode(shadowParts(db, clock)), prototype: CloseNode.prototype }),
  witness: (db, clock) => ({ node: new WitnessNode(shadowParts(db, clock)), prototype: WitnessNode.prototype }),
}

describe('bus.db', () => {
  it('opens in WAL mode with the five tables of the contract and the mains and chains the restart queue reads, the node cursors, the plan journal and the owner waits', () => {
    const db = newBus()
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(row => row.name)
    expect(tables).toEqual(['card_bodies', 'cards', 'chains', 'decisions', 'events', 'mains', 'node_cursors', 'owner_waits', 'plan_items', 'plans', 'projection_watermarks', 'prs', 'roles', 'tasks'])
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
    expect(taskColumns).toContain('lease_gen')
    db.close()
  })

  it('bus start closes the owner waits of merged, closed and dropped cards', () => {
    const db = newBus()
    const ts = '2026-10-09T12:00:00.000Z'
    let sequence = 0
    const append = (type: string, fields: Partial<BusEvent>): void => {
      sequence += 1
      appendEvent(db, { ts, type, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${type}:${sequence}`, payload: {}, legacy: false, ...fields })
    }
    const downgrade = (cardId: number): void => append(CARD_WAITING, { actor: 'worker:intake:s1', cardId, payload: { reason: WITNESS_DOWNGRADE, witnesses: ['w'], actions: [`разрешить понижение свидетеля w у #${cardId}`] } })
    for (const cardId of [1262, 1292, 1293, 1300]) {
      append('card.admitted', { actor: 'reducer', cardId, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [] } })
      downgrade(cardId)
    }
    const question = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1292, request: 7 })
    for (const [cardId, pr] of [[1292, 900], [1293, 901]] as const) {
      append('card.started', { actor: 'worker:launch:s1', cardId, payload: { session: 's1' } })
      append('pr.opened', { actor: 'worker:launch:s1', cardId, payload: { pr } })
    }
    for (const [cardId, pr] of [[1292, 900], [1293, 901]] as const)
      append('merge.done', { actor: 'worker:merge:s1', cardId, pr, head: HEAD, payload: { commit: HEAD, rule: 'auto' } })
    append('card.closed', { cardId: 1293, pr: 901 })
    append('card.dropped', { cardId: 1262, payload: { replaced_by: 1263 } })
    reduce(db)
    for (const table of [OWNER_WAITS, `${OWNER_WAITS}_${SNAPSHOT}`])
      db.exec(`UPDATE ${table} SET state = 'open', answer = NULL`)
    db.exec(`DELETE FROM ${DIRTY_ROWS}`)
    const openWaits = (): unknown[] => db.prepare(`SELECT card_id, id FROM ${OWNER_WAITS} WHERE state = 'open' ORDER BY card_id, id`).all().map(row => [row.card_id, row.id])
    expect(openWaits()).toHaveLength(5)
    const closed = inTransaction(db, () => closeWaitsOfEndedCards(db, ts))
    expect(closed).toHaveLength(3)
    expect(reduce(db).rejected).toBe(0)
    expect(openWaits()).toEqual([[1292, question], [1300, expect.stringMatching(/^W\d+$/)]])
    expect(db.prepare(`SELECT answer FROM ${OWNER_WAITS} WHERE state = 'closed' ORDER BY card_id`).all().map(row => row.answer)).toEqual(['card #1262 dropped', 'card #1292 merged', 'card #1293 closed'])
    expect(inTransaction(db, () => closeWaitsOfEndedCards(db, ts))).toEqual([])
    db.close()
  })

  it('a second event with the same dedupe_key is not inserted', () => {
    const db = newBus()
    expect(appendEvent(db, observed())).toBe(true)
    expect(appendEvent(db, observed({ ts: '2026-10-09T12:01:00.000Z' }))).toBe(false)
    expect(appendEvent(db, observed({ dedupeKey: 'pr:800:def' }))).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 })
    db.close()
  })

  it('keeps events append-only: an update or a delete is refused', () => {
    const db = newBus()
    appendEvent(db, observed())
    expect(() => db.exec(`UPDATE events SET type = 'x'`)).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/)
    db.close()
  })

  it('refuses an event outside the actor enum, a partial head or a non-integer pr', () => {
    const db = newBus()
    expect(() => appendEvent(db, observed({ actor: 'window' }))).toThrow(/actor/)
    expect(() => appendEvent(db, observed({ head: 'abc123' }))).toThrow(/full sha/)
    expect(() => appendEvent(db, observed({ pr: 1.5 }))).toThrow(/pr/)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
    db.close()
  })

  it('a null actor is stored only on a legacy event', () => {
    const db = newBus()
    const insert = db.prepare(`INSERT INTO events (ts, type, actor, dedupe_key, payload, legacy) VALUES ('2026-10-09T12:00:00.000Z', 'note', NULL, ?, '{}', ?)`)
    expect(() => insert.run('live:1', 0)).toThrow(/CHECK/)
    insert.run('legacy:1', 1)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
    db.close()
  })

  it('enforces task_key UNIQUE in tasks', () => {
    const db = newBus()
    appendEvent(db, observed())
    const insert = db.prepare(`INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES (?, 'review', 792, 'queued', 1)`)
    insert.run('review:792:800:-')
    expect(() => insert.run('review:792:800:-')).toThrow(/UNIQUE/)
    db.close()
  })

  it('with two connections, one holding BEGIN IMMEDIATE, the second waits in inTransaction instead of throwing database is locked', async () => {
    const db = newBus()
    const file = db.prepare('PRAGMA database_list').get()!.file as string
    const signal = new Int32Array(new SharedArrayBuffer(8))
    const holder = new Worker(HOLDS_THE_WRITE_LOCK, { eval: true, workerData: { file, signal, holdMs: LOCK_HELD_MS } })
    const holderDone = once(holder, 'exit')
    expect(Atomics.wait(signal, 0, 0, 10_000)).not.toBe('timed-out')

    const started = performance.now()
    expect(inTransaction(db, () => appendEvent(db, observed()))).toBe(true)
    expect(performance.now() - started).toBeGreaterThan(WAIT_ON_MAIN_MS)
    expect(BUSY_TIMEOUT_MS).toBeGreaterThan(LOCK_HELD_MS)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
    await holderDone
    db.close()
  }, LOCK_HELD_MS * 3)

  it('the last event of a type and the events of a card are read through an index', () => {
    const db = newBus()
    const lastOfType = plansOf(db, `SELECT id FROM events WHERE type = ? ORDER BY id DESC LIMIT 1`)
    const ofCard = plansOf(db, `SELECT id FROM events WHERE card_id = ? AND id > ? LIMIT 1`)
    expect(lastOfType).toEqual([expect.stringMatching(/^SEARCH events USING (COVERING )?INDEX events_by_type \(type=\?\)$/)])
    expect(ofCard).toEqual([expect.stringMatching(/^SEARCH events USING (COVERING )?INDEX events_by_card \(card_id=\? AND id>\?\)$/)])
    expect(db.prepare('PRAGMA cache_size').get()).toEqual({ cache_size: -CACHE_KIB })
    db.close()
  })

  it.each(Object.keys(QUIET_NODES))('a tick with no new events runs no query that scans events, and the %s node still computes its candidates on it', async (kind) => {
    const db = newBus()
    let now = Date.parse('2026-10-09T12:00:00.000Z')
    const clock = (): Date => new Date(now)
    for (let index = 0; index < 50; index++)
      appendEvent(db, observed({ cardId: 700 + index, pr: 700 + index, dedupeKey: `pr:${700 + index}:abc` }))
    const { node, prototype } = QUIET_NODES[kind]!(db, clock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(prototype as unknown as { before: () => void }, 'before').mockImplementation(() => {})
    const candidates = vi.spyOn(prototype as unknown as { candidates: () => unknown }, 'candidates')
    const controller = new AbortController()
    const queries = new Set<string>()
    const prepare = db.prepare.bind(db)
    let pauses = 0
    let candidatesBefore = 0
    const pause = async (): Promise<void> => {
      if (node instanceof LaunchNode)
        node.stopOverdue()
      pauses += 1
      if (pauses === 1) {
        now += TICK_MS
        candidatesBefore = candidates.mock.calls.length
        db.prepare = (sql: string) => {
          queries.add(sql)
          return prepare(sql)
        }
        return
      }
      db.prepare = prepare
      controller.abort()
    }
    await node.run({ pause, signal: controller.signal })
    expect(candidatesBefore).toBeGreaterThan(0)
    expect(candidates.mock.calls.length).toBeGreaterThan(candidatesBefore)
    expect([...queries].filter(sql => scansEvents(db, sql))).toEqual([])
    db.close()
  })

  it('every bus database open under the factory contours passes the busy timeout', () => {
    const lines = FACTORY_FOLDERS.sharedCode
      .flatMap(folder => readdirSync(path.join(REPO_ROOT, folder), { recursive: true, encoding: 'utf8' }).map(file => path.posix.join(folder, file)))
      .filter(file => file.endsWith('.ts') && !OPENED_BEFORE_THE_CONTOURS.includes(file))
      .flatMap(file => readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').map(line => ({ file, line })))
    const opens = lines.filter(({ line }) => line.includes('openDatabase(') && !line.includes('function openDatabase('))
    expect(opens.length).toBeGreaterThan(0)
    expect(opens.filter(({ line }) => !line.includes('timeout: BUSY_TIMEOUT_MS'))).toEqual([])
    expect(lines.filter(({ file, line }) => line.includes('DatabaseSync(') && file !== SQLITE_LOADER)).toEqual([])
  })
})

describe('identifiers', () => {
  it('task_key is <queue>:<card_id>:<pr|->:<head|->', () => {
    expect(taskKey({ queue: 'review', cardId: 792, pr: 800, head: HEAD })).toBe(`review:792:800:${HEAD}`)
    expect(taskKey({ queue: 'launch', cardId: 792 })).toBe('launch:792:-:-')
    expect(taskKey({ queue: 'update', cardId: 792, pr: 800 })).toBe('update:792:800:-')
    expect(() => taskKey({ queue: 'review', cardId: 792, pr: 800, head: 'abc123' })).toThrow(/full sha/)
    expect(() => taskKey({ queue: 'review', cardId: 0 })).toThrow(/card_id/)
  })

  it('reads a card id from a number, a numeric string, a card line or an object, and nothing from a bare slug', () => {
    expect(cardIdOf(656)).toBe(656)
    expect(cardIdOf('656')).toBe(656)
    expect(cardIdOf('#753 owner-merges-narrows [implement/runner/S/cheap/owner] · depends — · blocks —')).toBe(753)
    expect(cardIdOf({ id: 729, name: 'x' })).toBe(729)
    expect(cardIdOf('271-2')).toBe(271)
    expect(cardIdOf('shredder-collect')).toBeNull()
    expect(cardIdOf(null)).toBeNull()
  })

  it('accepts the actor enum and nothing else', () => {
    for (const actor of ['netwatch', 'reducer', 'owner', 'policy', 'worker:review:827aa1a1'])
      expect(isActor(actor)).toBe(true)
    for (const actor of ['window', 'worker:review', 'worker::s', ''])
      expect(isActor(actor)).toBe(false)
  })
})
