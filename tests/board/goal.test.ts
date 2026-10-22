import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../../scripts/bus/stored.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../scripts/bus/db.js'
import { OWNER } from '../../scripts/bus/inbox.js'
import { PLAN_FOLDS } from '../../scripts/bus/reducer.js'
import { STORED_COLUMNS, storedByKey } from '../../scripts/bus/stored.js'
import { PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_OPENED } from '../../scripts/core/events.js'
import { goalOf, planLine } from '../../src/commands/board/goal.js'
import { goalLines } from '../../src/commands/board/screens.js'

const NOW = new Date('2026-10-22T12:00:00.000Z')
const HOUR = 3_600_000
const PLAN = 'p-045'

interface SeedCard {
  state: string | null
  at?: string
  pr?: { pr: number, state: string }
  queue?: string
  lane?: string | null
}

const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

class Bench {
  readonly db = openBus(path.join(mkdtempSync(path.join(tmpdir(), 'construct-board-goal-')), 'bus.db'))
  private sequence = 0

  constructor() {
    opened.push(this.db)
  }

  event(type: string, ts: string, payload: Record<string, unknown> = {}, actor = 'netwatch'): number {
    this.sequence += 1
    const dedupeKey = `${type}:${this.sequence}`
    appendEvent(this.db, { ts, type, actor, cardId: null, pr: null, head: null, dedupeKey, payload, legacy: false })
    return storedByKey(this.db, dedupeKey).id
  }

  plan(type: string, payload: Record<string, unknown>): this {
    const id = this.event(type, NOW.toISOString(), payload, OWNER)
    PLAN_FOLDS[type]!(this.db, this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id = ?`).get(id) as unknown as StoredEvent)
    return this
  }

  open(): this {
    return this.plan(PLAN_OPENED, { id: PLAN, title: 'Plan 0.45', goal: 'explicit journals', plan_file: '/plans/0.45.md' })
  }

  item(item: string, ...cards: number[]): this {
    this.plan(PLAN_ITEM_ADDED, { plan: PLAN, item, title: `slice ${item}` })
    for (const card of cards)
      this.plan(PLAN_ITEM_LINKED, { plan: PLAN, item, card })
    return this
  }

  card(id: number, seed: SeedCard): this {
    const eventId = this.event('card.state', seed.at ?? ago(48 * HOUR))
    this.db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, ?)').run(id, seed.state, seed.pr?.pr ?? null, eventId)
    this.db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane) VALUES (?, ?, ?, ?, ?)').run(id, eventId, `card ${id}`, `sha-${id}`, seed.lane ?? null)
    if (seed.pr !== undefined)
      this.db.prepare('INSERT INTO prs (pr, card_id, state, event_id) VALUES (?, ?, ?, ?)').run(seed.pr.pr, id, seed.pr.state, this.event('pr.closed', seed.at ?? ago(48 * HOUR)))
    if (seed.queue !== undefined)
      this.db.prepare('INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES (?, ?, ?, ?, ?)').run(`${seed.queue}:${id}`, seed.queue, id, 'leased', eventId)
    return this
  }

  goal(): NonNullable<ReturnType<typeof goalOf>> {
    const goal = goalOf(this.db, NOW)
    expect(goal).not.toBeNull()
    return goal!
  }
}

describe('the plan journal on the board', () => {
  it('an item with no card counts in slices without cards', () => {
    const goal = new Bench().card(1, { state: 'queued' }).open().item('S1').item('S2', 1).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 0, total: 2, stages: { not_created: 1, queued: 1 } })
    expect(planLine(goal.plans[0]!, goal.backlog)).toContain('slices without cards: 1')
  })

  it('an item with three cards, two merged and one in work, is not delivered', () => {
    const bench = new Bench()
      .card(1, { state: 'merged' })
      .card(2, { state: 'closed', pr: { pr: 20, state: 'merged' } })
      .card(3, { state: 'running' })
    const goal = bench.open().item('S1', 1, 2, 3).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 0, total: 1, stages: { in_progress: 1, delivered: 0 } })
  })

  it('two cards on one item do not grow M', () => {
    const goal = new Bench().card(1, { state: 'merged' }).card(2, { state: 'merged' }).open().item('S1', 1, 2).item('S2').goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 1, total: 2 })
  })

  it('a dropped card does not grow N', () => {
    const goal = new Bench().card(1, { state: 'dropped' }).card(2, { state: 'merged' }).open().item('S1', 1).item('S2', 2).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 1, total: 2, stages: { not_created: 1, delivered: 1 } })
  })

  it('a task outside the plan is only in the backlog', () => {
    const bench = new Bench().card(1, { state: 'running' }).card(2, { state: 'queued' }).card(3, { state: 'merged' }).card(4, { state: 'queued', lane: 'archive' })
    const goal = bench.open().item('S1', 1).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 0, total: 1 })
    expect(goal.backlog).toBe(1)
  })

  it('plan.closed leaves no bar', () => {
    const bench = new Bench().card(1, { state: 'merged' }).open().item('S1', 1)
    expect(bench.goal().plans).toHaveLength(1)
    bench.plan(PLAN_CLOSED, { plan: PLAN })
    expect(goalOf(bench.db, NOW)).toBeNull()
    expect(goalLines({ at: NOW.toISOString(), goal: goalOf(bench.db, NOW), waits: [], pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0 })).toEqual([])
    expect(bench.db.prepare('SELECT plan_id, state FROM plans').all()).toEqual([{ plan_id: PLAN, state: 'closed' }])
  })

  it('the line reads delivered of total, by stage, slices without cards, delivered in 24 h and the backlog', () => {
    const bench = new Bench()
      .card(1, { state: 'merged', at: ago(HOUR) })
      .card(2, { state: null, pr: { pr: 20, state: 'merged' }, at: ago(30 * HOUR) })
      .card(3, { state: 'in_review' })
      .card(4, { state: 'queued', queue: 'review' })
      .card(5, { state: 'queued' })
      .card(6, { state: 'changes' })
      .card(9, { state: 'queued' })
    const goal = bench.open().item('S1', 1).item('S2', 2).item('S3', 3, 4).item('S4', 5).item('S5', 6).item('S6').goal()
    expect(planLine(goal.plans[0]!, goal.backlog)).toBe('Plan 0.45: delivered 2 of 6 · queued 1 · in progress 1 · review 1 · slices without cards: 1 · +1 in 24 h · backlog: 1')
  })

  it('a bus without the plan tables has no goal', () => {
    const bench = new Bench()
    bench.db.exec('DROP TABLE plan_items; DROP TABLE plans;')
    expect(goalOf(bench.db, NOW)).toBeNull()
  })
})
