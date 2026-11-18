import type { DatabaseSync } from 'node:sqlite'
import type { BoardData, BoardFiles } from '../../cli/board-page.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { boardProjection, printBoard } from '../../cli/board-page.js'
import { FILTER_ATTRIBUTE, filterRule, LIVE_FILTER, ownerHolds } from '../../cli/board-page/live-cards.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, OPEN_PLAN } from '../../core/events.js'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const TICK_MS = 10_000
const RELEASE = 'factory-0.47'
const RUNNING = 4101
const IN_RELEASE = 4102
const HELD = 4103
const BACKLOG = 4104
const HOLD_REASON = 'D-325 keeps it for factory-0.48'
const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function admit(db: DatabaseSync, card: number, state: string, depends = '—'): number {
  const line = `#${card} task-${card} [implement/construct/S/cheap/auto] · depends ${depends} · blocks —`
  const text = `card: ${line}\nbranch: feat/${card}\ntouches: scripts/${card}/**\nwho: shift\n\ndo ${card}\n`
  appendEvent(db, { ts: NOW.toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}`, payload: {}, legacy: false })
  const eventId = (db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`${CARD_ADMITTED}:${card}`) as { id: number }).id
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends, card_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(card, eventId, text, 'a'.repeat(40), null, 'shift', null, '[]', line)
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, state, eventId)
  return eventId
}

function seededBus(): { busPath: string, db: DatabaseSync } {
  const root = mkdtempSync(path.join(tmpdir(), 'board-live-filter-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  admit(db, RUNNING, 'running')
  const released = admit(db, IN_RELEASE, 'queued', `#${RUNNING}`)
  admit(db, HELD, 'queued')
  admit(db, BACKLOG, 'queued')
  db.prepare('INSERT INTO plans (plan_id, title, goal, plan_file, state, event_id, gate) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(RELEASE, RELEASE, 'ship it', 'plan.md', OPEN_PLAN, released)
  db.prepare('INSERT INTO card_releases (card_id, release, event_id) VALUES (?, ?, ?)').run(IN_RELEASE, RELEASE, released)
  appendEvent(db, { ts: NOW.toISOString(), type: CARD_HELD, actor: 'owner', cardId: HELD, pr: null, head: null, dedupeKey: `${CARD_HELD}:${HELD}`, payload: { reason: HOLD_REASON }, legacy: false })
  return { busPath, db }
}

function projectedRows(busPath: string, db: DatabaseSync): string {
  const texts = new Map<string, string>()
  const files: BoardFiles = { write: (file, text) => texts.set(file, text), rename: (from, to) => texts.set(to, texts.get(from)!) }
  const projection = boardProjection(db, busPath, TICK_MS, files, path.join(path.dirname(busPath), 'handoff.md'))
  projection.project(NOW)
  const window: { BOARD?: BoardData } = {}
  vm.runInNewContext(texts.get(projection.dataFile)!, { window })
  return window.BOARD!.slots.rows
}

function rowOf(rows: string, card: number): string {
  return new RegExp(`<tr data-card="${card}"[\\s\\S]*?</tr>`).exec(rows)![0]
}

function liveCards(rows: string): number[] {
  return [...rows.matchAll(/<tr data-card="(\d+)"[^>]* data-live[ >]/g)].map(match => Number(match[1])).sort((a, b) => a - b)
}

class StubNode {
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: StubNode[] = []
  textContent = ''
  innerHTML = ''
  open = false
  addEventListener(): void {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  remove(): void {}
  appendChild(): void {}
}

interface Loaded {
  backlog: StubNode
  appended: StubNode[]
}

function loadShell(hash: string, stored: Record<string, unknown> = {}): Loaded {
  const backlog = new StubNode()
  const ids = new Map([['drill', new StubNode()], ['backlog', backlog]])
  const appended: StubNode[] = []
  const document = {
    title: '',
    body: { dataset: { written: '', tickMs: String(TICK_MS) } },
    head: { appendChild: (child: StubNode) => appended.push(child) },
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: () => new StubNode(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  }
  const names = { drill: 'drill', drillContent: 'drill-content', backlog: 'backlog', viewKey: 'view', filterAttribute: FILTER_ATTRIBUTE, dataFile: 'board-data.js', round: {} }
  const storage = { getItem: () => JSON.stringify(stored), setItem: () => {} }
  const context: Record<string, unknown> = { BOARD_NAMES: names, document, localStorage: storage, location: { hash }, addEventListener: () => {}, setTimeout: () => 0, Date }
  context.window = context
  vm.runInNewContext(SCRIPT, context)
  return { backlog, appended }
}

describe('the LIVE filter after a reload', () => {
  it('a reload with #show-live names the LIVE filter on the backlog before the first board data is read', () => {
    const { backlog, appended } = loadShell('#show-live')
    expect(appended).toHaveLength(1)
    expect(backlog.attributes.get(FILTER_ATTRIBUTE)).toBe('show-live')
  })

  it('a reload with no anchor takes the filter the last view stored, still before the first render', () => {
    expect(loadShell('', { filter: '#show-live' }).backlog.attributes.get(FILTER_ATTRIBUTE)).toBe('show-live')
    expect(loadShell('').backlog.hasAttribute(FILTER_ATTRIBUTE)).toBe(false)
  })

  it('the LIVE rule hides every row without data-live and lights the LIVE chip from the same attribute', () => {
    const rule = filterRule(LIVE_FILTER)
    expect(rule.startsWith(`.backlog[${FILTER_ATTRIBUTE}="show-live"] {`)).toBe(true)
    expect(rule).toContain('& tr[data-card]:not([data-live])')
    expect(rule).toContain('& .chip[href="#show-live"]')
    expect(rule).not.toContain(':target')
  })
})

describe('the LIVE set', () => {
  it('lIVE holds the running card and the open release card, never a backlog card held by an owner decision', () => {
    const { busPath, db } = seededBus()
    expect(liveCards(projectedRows(busPath, db))).toEqual([RUNNING, IN_RELEASE])
    db.close()
  })

  it('every non-running card shows its release and its blocker or hold reason, and the running card shows none', () => {
    const { busPath, db } = seededBus()
    const rows = projectedRows(busPath, db)
    expect(rowOf(rows, RUNNING)).not.toContain('class="why"')
    expect(rowOf(rows, IN_RELEASE)).toContain(`<span class="why">release ${RELEASE} · blocked by #${RUNNING}</span>`)
    expect(rowOf(rows, HELD)).toContain(`<span class="why">no open release · held: ${HOLD_REASON}</span>`)
    expect(rowOf(rows, BACKLOG)).toContain('<span class="why">no open release · no blocker recorded</span>')
    db.close()
  })

  it('the text board shows the same release and hold reason', () => {
    const { busPath, db } = seededBus()
    db.close()
    let text = ''
    expect(printBoard(busPath, NOW, (written) => {
      text += written
    }, path.join(path.dirname(busPath), 'handoff.md'), 'text')).toBe(0)
    expect(text).toContain(`planned · no open release · held: ${HOLD_REASON}`)
    expect(text).toContain(`planned · release ${RELEASE} · blocked by #${RUNNING}`)
  })
})

describe('owner holds', () => {
  const held = (id: number, card: number, fields: Record<string, unknown> = {}) => ({ id, card, fields })

  it('a released owner hold leaves the card free and a takeover over an owner hold is not an owner hold', () => {
    expect(ownerHolds([held(1, 7, { reason: 'wait' }), held(3, 8, { reason: 'wait' }), held(4, 8, { takeover: 'window' })], [held(2, 7)])).toEqual(new Map())
  })

  it('a release lifts the takeover first and leaves the owner hold under it', () => {
    expect(ownerHolds([held(1, 8, { reason: 'D-1' }), held(2, 8, { takeover: 'window', reason: 'fix' })], [held(3, 8)])).toEqual(new Map([[8, 'D-1']]))
  })

  it('an owner hold with no reason says so', () => {
    expect(ownerHolds([held(1, 9)], [])).toEqual(new Map([[9, 'the hold names no reason']]))
  })
})
