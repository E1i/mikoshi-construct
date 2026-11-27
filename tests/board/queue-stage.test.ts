import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../../scripts/core/stored.js'
import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printBoard, PROGRESS_ORDER } from '../../scripts/cli/board-page.js'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { byId } from '../../scripts/core/events-query.js'
import { CARD_PLANNED, CARD_UNPLANNED, PLAN_OPENED, RESTARTED } from '../../scripts/core/events.js'
import { OWNER } from '../../scripts/core/inbox.js'
import { payloadOf, STORED_COLUMNS, storedByKey } from '../../scripts/core/stored.js'
import { RECUT_ACTOR } from '../../scripts/policy/round-limit-decision.js'
import { foldPlanEvent } from '../../scripts/window/plan-folds.js'
import { busReaderAt, CARD_STAGES, FLOW_STAGES, openLineCards } from '../../src/commands/board/bus.js'
import { BOARD_BUS } from '../../src/commands/board/index.js'
import { backlogLines, flowLines, isQueued, QUEUE_STAGE } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'

const NOW = new Date('2026-11-27T12:00:00.000Z')
const OPEN_LINE = 'factory-0.48.0'
const IN_LINE = [2364, 2365]
const NO_LINE = 1701
const QUEUE_HELD = 2332
const UNPLANNED = 2339
const NEW_MAIN = 'f'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class Bench {
  readonly file: string
  readonly db: DatabaseSync
  private sequence = 0

  constructor() {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-queue-stage-'))
    roots.push(root)
    this.file = path.join(root, 'bus.db')
    this.db = openBus(this.file)
  }

  event(type: string, payload: Record<string, unknown>, cardId: number | null = null, actor = OWNER): number {
    this.sequence += 1
    const dedupeKey = `${type}:${this.sequence}`
    appendEvent(this.db, { ts: NOW.toISOString(), type, actor, cardId, pr: null, head: null, dedupeKey, payload, legacy: false })
    return storedByKey(this.db, dedupeKey).id
  }

  plan(type: string, payload: Record<string, unknown>, cardId: number | null = null): this {
    const id = this.event(type, payload, cardId)
    foldPlanEvent(this.db, this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id = ?`).get(id) as unknown as StoredEvent, { owner: OWNER, recut: RECUT_ACTOR, payloadOf, actorOf: (db, event) => byId(db, event.id)?.actor ?? null })
    return this
  }

  queued(...cards: number[]): this {
    for (const card of cards) {
      const eventId = this.event('card.state', {}, card, 'netwatch')
      this.db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, ?)').run(card, 'queued', null, eventId)
      this.db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, card_line) VALUES (?, ?, ?, ?, ?, ?)').run(card, eventId, `card ${card}`, `sha-${card}`, null, `card: #${card} slice-${card} [implement/construct/S/cheap/auto] · depends — · blocks —`)
    }
    return this
  }

  facts(): BusFacts {
    const reading = busReaderAt(this.file, () => NOW)(BOARD_BUS)
    if (reading.status !== 'read')
      throw new Error(`the bus was ${reading.status}`)
    return reading.facts
  }

  html(): string {
    let html = ''
    expect(printBoard(this.file, NOW, (text) => {
      html += text
    }, path.join(path.dirname(this.file), 'miko.md'), 'html')).toBe(0)
    return html
  }
}

function openLineBench(): Bench {
  const bench = new Bench().queued(...IN_LINE, NO_LINE, QUEUE_HELD, UNPLANNED)
  bench.plan(PLAN_OPENED, { id: OPEN_LINE, title: OPEN_LINE, goal: 'the board tells the line from the queue', plan_file: '/plans/0.48.md' })
  for (const card of [...IN_LINE, UNPLANNED])
    bench.plan(CARD_PLANNED, { release: OPEN_LINE }, card)
  bench.plan(CARD_UNPLANNED, { card: UNPLANNED }, UNPLANNED)
  return bench
}

function rowsSection(html: string): string {
  return /<table id="slot-rows">([\s\S]*?)<\/table>/.exec(html)![1]!
}

function flowSection(html: string): string {
  return /<div class="flow">([\s\S]*?)<div class="flow-note">/.exec(html)![1]!
}

describe('the queue stage', () => {
  it('a queued card in no open release is queue and absent from the planned column', () => {
    const bench = openLineBench()
    const facts = bench.facts()
    const stageOf = (id: number): string | undefined => facts.cards.find(card => card.id === id)?.stage
    expect(IN_LINE.map(stageOf)).toEqual(['planned', 'planned'])
    expect([NO_LINE, QUEUE_HELD, UNPLANNED].map(stageOf)).toEqual([QUEUE_STAGE, QUEUE_STAGE, QUEUE_STAGE])

    const planned = facts.cards.filter(card => card.stage === 'planned').map(card => card.id)
    expect(planned).toEqual(IN_LINE)
    expect(facts.goal!.plans[0]!.stages.queued).toBe(planned.length)
    expect(facts.goal!.plans[0]!.cards.map(card => card.card)).toEqual(IN_LINE)
    expect(flowLines(facts.cards, PLAIN_LORE)[0]).toBe(`planned (2): ${IN_LINE.map(id => `#${id}`).join(' · ')}`)

    const backlog = backlogLines(facts.cards, PLAIN_LORE)
    const queueAt = backlog.indexOf('queue (3)')
    expect(queueAt).toBeGreaterThan(0)
    expect(backlog.slice(queueAt + 1).map(line => /#(\d+)/.exec(line)![1])).toEqual([NO_LINE, QUEUE_HELD, UNPLANNED].sort((a, b) => a - b).map(String))
    expect(backlog.slice(0, queueAt).some(line => [NO_LINE, QUEUE_HELD, UNPLANNED].some(id => line.includes(`#${id} `)))).toBe(false)

    const html = bench.html()
    const flow = flowSection(html)
    expect(flow).toContain('<span class="name">planned</span><span class="n">2</span>')
    expect(flow).not.toContain(`>${QUEUE_STAGE}<`)
    for (const id of [NO_LINE, QUEUE_HELD, UNPLANNED])
      expect(flow).not.toContain(`#${id}`)
    const queueGroup = /<tbody class="task-group" data-task="queue" data-collapsed>[\s\S]*?<\/tbody>/.exec(rowsSection(html))![0]
    expect(queueGroup).toContain('<button type="button" class="task-fold" data-fold="queue" aria-expanded="false">queue (3)</button>')
    for (const id of [NO_LINE, QUEUE_HELD, UNPLANNED])
      expect(queueGroup).toContain(`data-card="${id}"`)
    for (const id of IN_LINE)
      expect(queueGroup).not.toContain(`data-card="${id}"`)
  })

  it('with no open release every queued card is queue and the planned column is empty', () => {
    const bench = new Bench().queued(...IN_LINE, NO_LINE)
    const facts = bench.facts()
    expect(facts.goal).toBeNull()
    expect(facts.cards.every(isQueued)).toBe(true)
    expect(flowLines(facts.cards, LORE)[0]).toBe('planned (0): —')
  })

  it('queue is a stage of its own, outside the flow and its progress', () => {
    expect(CARD_STAGES).toContain(QUEUE_STAGE)
    expect(FLOW_STAGES.flat()).not.toContain(QUEUE_STAGE)
    expect(PROGRESS_ORDER).not.toContain(QUEUE_STAGE)
    expect([...openLineCards(null)]).toEqual([])
  })

  it('the board reads the last supervisor.restarted from the bus with its sha', () => {
    const bench = new Bench()
    bench.event(RESTARTED, { sha: NEW_MAIN }, null, 'policy')
    expect(bench.facts().restart).toEqual({ sha: NEW_MAIN, at: NOW.toISOString() })
    expect(new Bench().facts().restart).toBeUndefined()
  })
})
