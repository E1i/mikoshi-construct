import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../../scripts/core/stored.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { CARD_PLANNED, CARD_UNPLANNED, PLAN_CLOSED, PLAN_OPENED } from '../../scripts/core/events.js'
import { OWNER } from '../../scripts/core/inbox.js'
import { PLAN_FOLDS } from '../../scripts/core/reducer.js'
import { STORED_COLUMNS, storedByKey } from '../../scripts/core/stored.js'
import { droppedLine, goalOf, planLine } from '../../src/commands/board/goal.js'
import { goalLines } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'

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

  event(type: string, ts: string, payload: Record<string, unknown> = {}, actor = 'netwatch', cardId: number | null = null): number {
    this.sequence += 1
    const dedupeKey = `${type}:${this.sequence}`
    appendEvent(this.db, { ts, type, actor, cardId, pr: null, head: null, dedupeKey, payload, legacy: false })
    return storedByKey(this.db, dedupeKey).id
  }

  plan(type: string, payload: Record<string, unknown>, cardId: number | null = null): this {
    const id = this.event(type, NOW.toISOString(), payload, OWNER, cardId)
    PLAN_FOLDS[type]!(this.db, this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id = ?`).get(id) as unknown as StoredEvent)
    return this
  }

  open(gate?: string): this {
    return this.plan(PLAN_OPENED, { id: PLAN, title: 'Plan 0.45', goal: 'explicit journals', plan_file: '/plans/0.45.md', ...(gate === undefined ? {} : { gate }) })
  }

  planned(...cards: number[]): this {
    for (const card of cards)
      this.plan(CARD_PLANNED, { release: PLAN }, card)
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

describe('the release on the board', () => {
  it('an open release with no card reads merged 0 of 0 with nothing left', () => {
    const goal = new Bench().card(1, { state: 'queued' }).open().goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 0, total: 0, remainder: 0, cards: [] })
    expect(goal.backlog).toBe(1)
  })

  it('three cards, two merged and one in work, leave a remainder of one', () => {
    const bench = new Bench()
      .card(1, { state: 'merged' })
      .card(2, { state: 'closed', pr: { pr: 20, state: 'merged' } })
      .card(3, { state: 'running' })
    const goal = bench.open().planned(1, 2, 3).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 2, total: 3, remainder: 1, stages: { in_progress: 1, delivered: 2 } })
  })

  it('a dropped card does not grow the total and shows on its own line', () => {
    const goal = new Bench().card(1, { state: 'dropped' }).card(2, { state: 'merged' }).card(3, { state: 'queued', lane: 'archive' }).open().planned(1, 2, 3).goal()
    expect(goal.plans[0]).toMatchObject({ delivered: 1, total: 1, remainder: 0 })
    expect(droppedLine(goal.plans[0]!, PLAIN_LORE)).toBe('dropped 2: #1, #3')
    expect(droppedLine(goal.plans[0]!, LORE)).toBe('dropped 2: #1, #3')
  })

  it('a card with no release is only in the backlog, and plan remove returns it there', () => {
    const bench = new Bench().card(1, { state: 'running' }).card(2, { state: 'queued' }).card(3, { state: 'merged' }).card(4, { state: 'queued', lane: 'archive' })
    expect(bench.open().planned(1).goal()).toMatchObject({ plans: [{ total: 1 }], backlog: 1 })
    bench.plan(CARD_UNPLANNED, {}, 1)
    expect(bench.goal()).toMatchObject({ plans: [{ total: 0 }], backlog: 2 })
  })

  it('plan.closed leaves no bar', () => {
    const bench = new Bench().card(1, { state: 'merged' }).open().planned(1)
    expect(bench.goal().plans).toHaveLength(1)
    bench.plan(PLAN_CLOSED, { plan: PLAN })
    expect(goalOf(bench.db, NOW)).toBeNull()
    expect(goalLines({ at: NOW.toISOString(), goal: goalOf(bench.db, NOW), waits: [], pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0 }, PLAIN_LORE)).toEqual([])
    expect(bench.db.prepare('SELECT plan_id, state FROM plans').all()).toEqual([{ plan_id: PLAN, state: 'closed' }])
  })

  it('the line reads merged of total, by stage, the remainder, the gate, merged in 24 h and the backlog', () => {
    const bench = new Bench()
      .card(1, { state: 'merged', at: ago(HOUR) })
      .card(2, { state: null, pr: { pr: 20, state: 'merged' }, at: ago(30 * HOUR) })
      .card(3, { state: 'in_review' })
      .card(4, { state: 'queued', queue: 'review' })
      .card(5, { state: 'queued' })
      .card(6, { state: 'changes' })
      .card(9, { state: 'queued' })
    const goal = bench.open('VEDETIRUN').planned(1, 2, 3, 4, 5, 6).goal()
    expect(planLine(goal.plans[0]!, goal.backlog)).toBe('Plan 0.45: merged 2 of 6 · in work 1 · review 2 · queue 1 · remainder 4 · gate VEDETIRUN: open · +1 in 24 h · backlog: 1')
  })

  it('a bus without the release tables has no goal', () => {
    const bench = new Bench()
    bench.db.exec('DROP TABLE card_releases;')
    expect(goalOf(bench.db, NOW)).toBeNull()
  })
})
