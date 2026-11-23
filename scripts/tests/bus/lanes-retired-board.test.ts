import type { BusCard, BusFacts } from '../../../src/commands/board/bus.js'
import type { HandoffState } from '../../window/handoff-write.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { screenLines } from '../../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../../src/ui/lore.js'
import { renderBoard } from '../../cli/board-page.js'
import { openBus } from '../../core/db.js'
import { busProjections, pullRequests } from '../../supervisor/composition.js'
import { readBoard } from '../../window/board.js'
import { stateLines } from '../../window/handoff-write.js'

const AT = '2026-11-18T10:00:00.000Z'
const LANE_WORD = /\blane\b|lane-\d/
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function card(id: number, stage: BusCard['stage'], lane: string | null): BusCard {
  return { id, state: null, stage, lane, line: `#${id} card-${id} [implement/construct/S/cheap/auto] · depends — · blocks —`, since: AT, body: true, closed: false, closedAt: null }
}

const CARDS: BusCard[] = [
  card(3, 'review', 'lane-2'),
  card(1, 'planned', 'lane-1'),
  card(4, 'ready', null),
  card(2, 'planned', 'lane-3'),
]

function facts(): BusFacts {
  return { at: AT, goal: null, waits: [], pulse: null, slots: [], cards: CARDS, services: [], matrices: [], failure: null, reviewQueue: 0, laneHeads: [{ lane: 'lane-3', card: 2, reason: 'held by an open PR' }] }
}

function page(): string {
  return renderBoard({
    version: '0.0.0',
    machine: { load: 0, cores: 1 },
    liveness: 'live',
    modelVersion: null,
    facts: facts(),
    windowGauges: null,
    limits: { contextLimit: null, cardContextLine: null, sessionSpend: null, agentSpend: null, warnRatio: null, modelWindows: new Map() },
    details: new Map(),
    decisions: { stale: null, rows: [], at: 0 },
    handoff: { file: 'miko.md', text: null },
    repository: null,
    tickMs: null,
    warnings: [],
  })
}

describe('the board prints no lane', () => {
  it('the text board prints no lane heading and no lane head, and lists whole cards by state, then the order they arrive in', () => {
    const lines = screenLines(facts(), PLAIN_LORE)
    expect(lines.filter(line => LANE_WORD.test(line))).toEqual([])
    const backlog = lines.slice(lines.indexOf(PLAIN_LORE.boardTabBacklog) + 1, lines.indexOf(PLAIN_LORE.boardTabServices))
    expect(backlog.map(line => line.trim().split(' ')[0])).toEqual(['#1', '#2', '#3', '#4'])
  })

  it('the board page draws no lane row group and names no lane of a card', () => {
    const html = page()
    expect(html).not.toContain('class="lane"')
    expect(html).not.toMatch(/lane-\d/)
    expect(html).not.toContain('grouped by lane')
  })

  it('the board read from the bus carries no lane block', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lanes-retired-board-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const board = readBoard({ db, now: new Date(AT), watched: [], leaseOrders: {}, projections: busProjections(), pulls: pullRequests(db) })
    expect(Object.keys(board)).not.toContain('lanes')
  })

  it('the handoff names the current card by its stage and writes no lane', () => {
    const state: HandoffState = { ready: [], blocked: [], waitsAt: 1, execution: [{ card: 7, pr: null, stage: 'writing', since: null, review: null, markers: [] }, { card: 8, pr: 80, stage: 'review', since: null, review: null, markers: [] }] }
    const lines = stateLines(state)
    expect(lines[0]).toBe('current card: #7 writing')
    expect(lines.filter(line => LANE_WORD.test(line))).toEqual([])
  })
})
