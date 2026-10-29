import type { StoredEvent } from '../../scripts/core/stored.js'
import type { BusCard, BusFacts, OwnerWait } from '../../src/commands/board/bus.js'
import type { SeedEvent } from './bus-fixture.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { printBoard } from '../../scripts/cli/board-page.js'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { CARD_MOVED, LANE_ASSIGNED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_OPENED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../scripts/core/events.js'
import { OWNER } from '../../scripts/core/inbox.js'
import { PLAN_FOLDS } from '../../scripts/core/reducer.js'
import { STORED_COLUMNS, storedByKey } from '../../scripts/core/stored.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { goalOf } from '../../src/commands/board/goal.js'
import { backlogLines, boardScreens, flowLines, waitHint, waitsLines } from '../../src/commands/board/screens.js'
import { factoryLiveness, WINDOW_SILENT_MS } from '../../src/commands/liveness.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const { RUNNING_VERSION, LOADED_VERSION } = vi.hoisted(() => ({ RUNNING_VERSION: '9.9.9-running', LOADED_VERSION: '0.0.0-loaded' }))

vi.mock('../../src/version.js', async importOriginal => ({ ...await importOriginal<object>(), VERSION: LOADED_VERSION, currentVersion: () => RUNNING_VERSION }))

const GREETING_TWINS = [
  path.join(import.meta.dirname, '../../templates/ai/claude/scripts/construct/window-hooks.mjs'),
  path.join(import.meta.dirname, '../../templates/attach/_construct/window-hooks.mjs'),
]
const NOW = new Date('2026-10-29T12:00:00.000Z')
const MINUTE = 60_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

function busWith(events: SeedEvent[], cards: Parameters<typeof writeBus>[1]['cards'] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), 'boardtruth-'))
  roots.push(root)
  const file = writeBus(path.join(root, 'bus.db'), { cards, events: [{ ts: ago(MINUTE), type: 'netwatch.tick', card: null, payload: '{}' }, ...events] })
  const db = new DatabaseSync(file)
  try {
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  }
  finally {
    db.close()
  }
  return file
}

function pageOf(busPath: string): string {
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(path.dirname(busPath), 'miko.md'))).toBe(0)
  return html
}

function factsOf(busPath: string): BusFacts {
  const reading = busReaderAt(busPath, () => NOW)()
  if (reading.status !== 'read')
    throw new Error(`the bus was ${reading.status}`)
  return reading.facts
}

function noFacts(overrides: Partial<BusFacts>): BusFacts {
  return { at: NOW.toISOString(), goal: null, waits: [], pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0, ...overrides }
}

function liveCard(id: number): BusCard {
  return { id, state: 'queued', stage: 'planned', lane: 'lane-21', slot: null, line: null, since: null, body: true, closed: false, closedAt: null }
}

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'boardtruth-'))
  roots.push(root)
  return root
}

function greeting(template: string, busFile: string): string {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, ...rest } = process.env
  const home = tempDir()
  const run = spawnSync(process.execPath, [template, 'session-start'], {
    input: JSON.stringify({ source: 'startup' }),
    encoding: 'utf8',
    env: { ...rest, HOME: home, CLAUDE_PROJECT_DIR: tempDir(), CONSTRUCT_HANDOFF: path.join(home, 'absent.md'), CONSTRUCT_BUS_DB: busFile },
  })
  return run.stdout === '' ? '' : (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
}

function planEvent(db: DatabaseSync, type: string, payload: Record<string, unknown>): void {
  const dedupeKey = `${type}:${JSON.stringify(payload)}`
  appendEvent(db, { ts: NOW.toISOString(), type, actor: OWNER, cardId: null, pr: null, head: null, dedupeKey, payload, legacy: false })
  PLAN_FOLDS[type]!(db, db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id = ?`).get(storedByKey(db, dedupeKey).id) as unknown as StoredEvent)
}

function seedCard(db: DatabaseSync, card: number, lane: string): void {
  const dedupeKey = `card.state:${card}`
  appendEvent(db, { ts: NOW.toISOString(), type: 'card.state', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey, payload: {}, legacy: false })
  const eventId = storedByKey(db, dedupeKey).id
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, 'queued', eventId)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane) VALUES (?, ?, ?, ?, ?)').run(card, eventId, `card ${card}`, `sha-${card}`, lane)
}

function windowBeat(milliseconds: number): SeedEvent {
  return { ts: ago(milliseconds), type: WINDOW_HEARTBEAT, card: null, payload: '{}' }
}

describe('the board tells the truth and hints', () => {
  it('bus live reads the liveness function: stale heartbeat is offline', () => {
    const fresh = busWith([windowBeat(2 * MINUTE)])
    expect(factoryLiveness(fresh, NOW.getTime()).state).toBe('live')
    expect(pageOf(fresh)).toContain('<span class="live" id="bus-live">bus live</span>')
    for (const silent of [busWith([windowBeat(WINDOW_SILENT_MS + MINUTE)]), busWith([])]) {
      expect(factoryLiveness(silent, NOW.getTime()).state).toBe('offline')
      const html = pageOf(silent)
      expect(html).toContain('<span class="live" id="bus-live" data-stale>bus offline</span>')
      expect(html).not.toContain('bus live')
    }
  })

  it('every wait carries a hint with a command', () => {
    const since = ago(MINUTE)
    const waits: OwnerWait[] = [
      { id: 'Q1', need: 'decision', text: 'which path?', command: null, card: 10, pr: null, since },
      { id: 'Q2', need: 'decision', text: 'which release?', command: null, card: null, pr: null, since },
      { id: 'Q3', need: 'merge', text: 'changes security invariants', command: null, card: 12, pr: 669, since },
      { id: 'Q4', need: 'command', text: 'card #1407 asks to widen its touches', command: 'pnpm intake --admit parking/lane-21/1407.md', card: 1407, pr: null, since },
      { id: 'Q5', need: 'command', text: 'the merge queue runs unswitched', command: 'pnpm decisions:add "[owner] allow-live merge"', card: null, pr: null, since },
    ]
    expect(waits.map(waitHint)).toEqual([
      { who: 'owner', command: 'pnpm decisions:add --card #10 "[owner] <decision>"' },
      { who: 'owner', command: 'pnpm decisions:add "[owner] <decision>"' },
      { who: 'owner', command: 'gh pr merge 669' },
      { who: 'window', command: 'pnpm intake --admit parking/lane-21/1407.md' },
      { who: 'owner', command: 'pnpm decisions:add "[owner] allow-live merge"' },
    ])
    const [line] = waitsLines(noFacts({ waits }), PLAIN_LORE)
    for (const wait of waits) {
      const hint = waitHint(wait)
      expect(line).toContain(`${wait.text} · ${hint.who} runs: ${hint.command}`)
    }
  })

  it('cards without a plan hint the registration command', () => {
    const flow = (facts: BusFacts): string[] => boardScreens(facts, PLAIN_LORE).screens[0]!.lines
    expect(flow(noFacts({ cards: [liveCard(1404)] }))[0]).toBe('plan not registered · window runs: pnpm bus:request plan --op open --plan <id> --title <text> --goal <text> --file <absolute plan file>')
    const empty = flow(noFacts({}))
    expect(empty).not.toContain(expect.stringContaining('plan not registered'))
    expect(empty.at(-1)).toBe('nothing in the flow · window runs: pnpm intake --admit <parking>/<lane>/<N>.md')
  })

  it('a card moved to a parking lane shows under that lane', () => {
    const busPath = busWith([
      { ts: ago(30 * MINUTE), type: LANE_ASSIGNED, card: 1395, payload: JSON.stringify({ lane: 'lane-1', lanes: 4 }) },
      { ts: ago(20 * MINUTE), type: CARD_MOVED, card: 1395, payload: JSON.stringify({ lane: 'lane-21' }) },
    ], [{ id: 1395, state: 'queued', lane: null, line: '#1395 moved' }])
    const facts = factsOf(busPath)
    expect(facts.cards.map(card => [card.id, card.lane, card.slot])).toEqual([[1395, 'lane-21', 'slot-1']])
    const backlog = backlogLines(facts.cards, PLAIN_LORE)
    expect(backlog).toEqual(['lane-21 (1)', '  #1395 moved · planned'])
    expect(backlog.join('\n')).not.toContain('lane-1 ')
  })

  it('service tile readings of six and more digits show whole at any card count and width', () => {
    const cards = Array.from({ length: 24 }, (_, index) => ({ id: 1400 + index, state: 'running', lane: null, line: null }))
    const beats = cards.map((card): SeedEvent => ({ ts: ago(3 * MINUTE), type: SESSION_HEARTBEAT, card: card.id, payload: JSON.stringify({ step: 'launch', session: `s${card.id}`, context: 182_345, spent: 2_950_000 }) }))
    const html = pageOf(busWith(beats, cards))
    const readings = [...html.matchAll(/<span class="edd-v">([^<]+)<\/span>/g)].map(match => match[1]!)
    expect(readings).toHaveLength(cards.length * 2)
    for (const reading of readings)
      expect(reading).toMatch(/^(?:182k|3M)(?:\/\d+(?:\.\d)?[kM])?$/)
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    const edd = /\n\.edd \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(edd).toContain('flex-wrap: wrap;')
    expect(style).toMatch(/\.edd-v \{[^}]*white-space: nowrap/)
    expect(style).toMatch(/\.edd-k \{[^}]*flex: 0 0/)
    expect(style).not.toMatch(/text-overflow|overflow: hidden/)
  })

  it('the header version is the version of the running construct', () => {
    const html = pageOf(busWith([]))
    expect(html).toContain(`<p class="subtitle">${LORE.subtitle(RUNNING_VERSION)}</p>`)
    expect(html).not.toContain(LOADED_VERSION)
  })

  it('an absorbed slice parked in a terminal lane leaves planned on the board and in the plan', () => {
    const busPath = busWith([
      { ts: ago(20 * MINUTE), type: CARD_MOVED, card: 1368, payload: JSON.stringify({ lane: 'superseded' }) },
    ], [{ id: 1368, state: 'queued', lane: 'lane-21', line: '#1368 absorbed' }, { id: 1369, state: 'queued', lane: 'archive', line: '#1369 archived' }, { id: 1371, state: 'queued', lane: 'lane-21', line: '#1371 live' }])
    const facts = factsOf(busPath)
    expect(facts.cards.map(card => [card.id, card.stage])).toEqual([[1368, 'dropped'], [1369, 'dropped'], [1371, 'planned']])
    expect(flowLines(facts.cards, PLAIN_LORE)[0]).toBe('planned (1): #1371')

    const db = openBus(path.join(tempDir(), 'bus.db'))
    try {
      seedCard(db, 1368, 'superseded')
      seedCard(db, 1371, 'lane-21')
      planEvent(db, PLAN_OPENED, { id: 'p-046', title: 'Plan 0.46', goal: 'the board tells the truth', plan_file: '/plans/0.46.md' })
      for (const [item, card] of [['S1', 1368], ['S2', 1371]] as const) {
        planEvent(db, PLAN_ITEM_ADDED, { plan: 'p-046', item, title: `slice ${item}` })
        planEvent(db, PLAN_ITEM_LINKED, { plan: 'p-046', item, card })
      }
      expect(goalOf(db, NOW)!.plans[0]!.stages).toMatchObject({ queued: 1, not_created: 1 })
    }
    finally {
      db.close()
    }
  })

  it('a plan the bus opens is picked up on the next reading with its progress bar, and the hint goes', () => {
    const db = openBus(path.join(tempDir(), 'bus.db'))
    try {
      seedCard(db, 1404, 'lane-21')
      const flow = (): string[] => boardScreens(factsOf(db.location()!), PLAIN_LORE).screens[0]!.lines
      expect(flow()[0]).toMatch(/^plan not registered · /)
      planEvent(db, PLAN_OPENED, { id: 'p-046', title: 'Plan 0.46', goal: 'the board tells the truth', plan_file: '/plans/0.46.md' })
      planEvent(db, PLAN_ITEM_ADDED, { plan: 'p-046', item: 'S1', title: 'slice S1' })
      planEvent(db, PLAN_ITEM_LINKED, { plan: 'p-046', item: 'S1', card: 1404 })
      const [first] = flow()
      expect(first).toMatch(/^\[░{10}\] Plan 0\.46: delivered 0 of 1/)
      expect(flow()).not.toContain(expect.stringContaining('plan not registered'))
    }
    finally {
      db.close()
    }
  })

  it('the window greeting names construct board --every and board.html once the factory has a bus', () => {
    const busFile = path.join(tempDir(), 'bus.db')
    for (const template of GREETING_TWINS)
      expect(greeting(template, busFile)).toBe('')
    writeFileSync(busFile, '')
    for (const template of GREETING_TWINS) {
      const context = greeting(template, busFile)
      expect(context).toContain('construct board --every 5')
      expect(context).toContain(path.join(path.dirname(busFile), 'board.html'))
    }
  })
})
