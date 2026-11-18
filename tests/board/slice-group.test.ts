import type { BusCard, BusFacts, OwnerWait } from '../../src/commands/board/bus.js'
import { describe, expect, it } from 'vitest'
import { renderBoard } from '../../scripts/cli/board-page.js'
import { backlogLines, taskGroups } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'

const AT = '2026-11-13T10:00:00.000Z'
const TASK = 30
const MERGED_SLICE = 31
const WAITING_SLICE = 32
const PLANNED_SLICE = 33
const WHOLE = 40
const SLICES = 3
const TASK_LINE = `task #${TASK} · slices merged 1 of ${SLICES} · waits for you: Q1 decision #${WAITING_SLICE}`

function card(id: number, stage: BusCard['stage'], lane: string, parent?: BusCard['parent']): BusCard {
  return { id, state: null, stage, lane, line: `#${id} card-${id} [implement/construct/S/cheap/auto] · depends — · blocks —`, since: AT, body: true, closed: false, closedAt: null, ...parent === undefined ? {} : { parent } }
}

const CARDS: BusCard[] = [
  card(WHOLE, 'in work', 'lane-1'),
  card(PLANNED_SLICE, 'planned', 'lane-1', { card: TASK, part: 3, of: SLICES }),
  card(WAITING_SLICE, 'in work', 'lane-2', { card: TASK, part: 2, of: SLICES }),
  card(MERGED_SLICE, 'merged', 'lane-1', { card: TASK, part: 1, of: SLICES }),
]

const OWNER_WAIT: OwnerWait = { id: 'Q1', need: 'decision', text: 'which way', command: null, card: WAITING_SLICE, pr: null, since: AT, lifter: 'owner', decision: null }
const WINDOW_WAIT: OwnerWait = { ...OWNER_WAIT, id: 'Q2', lifter: 'window' }

function facts(): BusFacts {
  return { at: AT, goal: null, waits: [OWNER_WAIT, WINDOW_WAIT], pulse: null, slots: [], cards: CARDS, services: [], matrices: [], failure: null, reviewQueue: 0 }
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

function taskBody(html: string): string {
  const from = html.indexOf(`<tbody class="task-group" data-task="${TASK}"`)
  expect(from).toBeGreaterThanOrEqual(0)
  return html.slice(from, html.indexOf('</tbody>', from))
}

describe('the board groups slices under one task line', () => {
  it('gathers every slice of a task, across lanes, with its progress and the owner wait inside it', () => {
    expect(taskGroups(CARDS, CARDS, facts().waits)).toEqual([{
      task: TASK,
      of: SLICES,
      merged: 1,
      slices: [CARDS[3], CARDS[2], CARDS[1]],
      waits: [OWNER_WAIT],
    }])
  })

  it('prints one task line in text with every slice under it, naming no lane, and whole cards after it', () => {
    const lines = backlogLines(CARDS, PLAIN_LORE, CARDS, facts().waits)
    expect(lines.slice(0, 4)).toEqual([
      TASK_LINE,
      expect.stringContaining(`#${MERGED_SLICE} card-${MERGED_SLICE}`),
      expect.stringContaining(`#${WAITING_SLICE} card-${WAITING_SLICE}`),
      expect.stringContaining(`#${PLANNED_SLICE} card-${PLANNED_SLICE}`),
    ])
    expect(lines[1]).toContain(`◧ 1/${SLICES} · of #${TASK} · `)
    expect(lines[2]).toContain(`◧ 2/${SLICES} · of #${TASK} · `)
    expect(lines[3]).toContain(`◧ 3/${SLICES} · of #${TASK} · `)
    expect(lines.filter(line => line.includes('lane'))).toEqual([])
    expect(lines.filter(line => line.includes(`task #${TASK}`))).toHaveLength(1)
    expect(lines.slice(4).some(line => line.includes(`#${WHOLE}`))).toBe(true)
    expect(lines.slice(4).some(line => line.includes('◧'))).toBe(false)
  })

  it('counts progress over every slice of the task, also those the backlog does not show', () => {
    const shown = CARDS.filter(each => each.stage !== 'merged')
    expect(backlogLines(shown, PLAIN_LORE, CARDS, facts().waits)[0]).toBe(TASK_LINE)
  })

  it('draws the task as a collapsed group on the page whose task line carries the owner wait', () => {
    const body = taskBody(page())
    expect(body).toMatch(/^<tbody class="task-group" data-task="30" data-collapsed><tr class="task" data-waits>/)
    const taskRow = body.slice(0, body.indexOf('</tr>'))
    expect(taskRow).toContain(`data-fold="${TASK}"`)
    expect(taskRow).toContain(TASK_LINE)
    expect(taskRow).not.toContain('Q2')
    expect([MERGED_SLICE, WAITING_SLICE, PLANNED_SLICE].map(id => body.includes(`data-card="${id}"`))).toEqual([true, true, true])
    expect(body).not.toContain(`data-card="${WHOLE}"`)
  })

  it('a task with no owner wait inside carries no wait mark', () => {
    const quiet = { ...facts(), waits: [WINDOW_WAIT] }
    expect(taskGroups(CARDS, CARDS, quiet.waits)[0]!.waits).toEqual([])
  })
})
