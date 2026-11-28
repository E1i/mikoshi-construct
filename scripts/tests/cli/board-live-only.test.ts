import type { DatabaseSync } from 'node:sqlite'
import type { BoardData, BoardFiles } from '../../cli/board-page.js'
import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentVersion } from '../../../src/version.js'
import { boardProjection, DISK_FILES, renderShell, runBoardCli } from '../../cli/board-page.js'
import { BOARD_HISTORY_FILE, liveCardsOf, MERGED_SHOWN_HOURS } from '../../cli/board-page/live-cards.js'
import { BoardTimer, boardTimerLine, runBoardTimer } from '../../cli/board-page/timer.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'

const NOW = new Date('2026-11-17T12:00:00.000Z')
const HOUR_MS = 3_600_000
const TICK_MS = 10_000
const ALL_CARDS = 1440
const LIVE_CARDS = 30
const RECENT_MERGES = 10
const PAGE_LIMIT_BYTES = 300_000
const FIRST_CARD = 3000
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Seeded {
  busPath: string
  db: DatabaseSync
  live: number[]
  recent: number[]
  old: number[]
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString()
}

function seedCard(db: DatabaseSync, card: number, state: string | null, ts: string): void {
  const line = `#${card} task-${card} [implement/construct/S/cheap/auto] · depends — · blocks —`
  const text = `card: ${line}\nbranch: feat/${card}\ntouches: scripts/${card}/**\nwho: shift\n\ndo ${card}\n`
  appendEvent(db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}`, payload: {}, legacy: false })
  const eventId = (db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`${CARD_ADMITTED}:${card}`) as { id: number }).id
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(card, eventId, text, 'a'.repeat(40), 'lane-1', 'shift', null, '[]')
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, state, eventId)
}

function seededBus(): Seeded {
  const root = mkdtempSync(path.join(tmpdir(), 'board-live-only-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  const ids = Array.from({ length: ALL_CARDS }, (_, at) => FIRST_CARD + at)
  const live = ids.slice(0, LIVE_CARDS)
  const recent = ids.slice(LIVE_CARDS, LIVE_CARDS + RECENT_MERGES)
  const old = ids.slice(LIVE_CARDS + RECENT_MERGES)
  db.exec('BEGIN')
  for (const card of live)
    seedCard(db, card, null, hoursAgo(1))
  for (const card of recent)
    seedCard(db, card, 'merged', hoursAgo(MERGED_SHOWN_HOURS / 2))
  for (const card of old)
    seedCard(db, card, 'merged', hoursAgo(MERGED_SHOWN_HOURS * 3))
  db.exec('COMMIT')
  return { busPath, db, live, recent, old }
}

class MemoryFiles implements BoardFiles {
  readonly texts = new Map<string, string>()
  readonly renamed: string[] = []

  write = (file: string, text: string): void => {
    this.texts.set(file, text)
  }

  rename = (from: string, to: string): void => {
    this.texts.set(to, this.texts.get(from)!)
    this.texts.delete(from)
    this.renamed.push(to)
  }
}

function boardOf(data: string): BoardData {
  const window: { BOARD?: BoardData } = {}
  vm.runInNewContext(data, { window })
  return window.BOARD!
}

function dialogCards(html: string): number[] {
  return [...html.matchAll(/<template id="dialog-card-(\d+)">/g)].map(match => Number(match[1])).sort((a, b) => a - b)
}

function handoffOf(busPath: string): string {
  return path.join(path.dirname(busPath), 'handoff.md')
}

describe('the board carries only live cards and the last day of merges', () => {
  it('with 1440 cards of which 30 are live board-data holds the 30 live cards plus the last 24 h of merges and stays under 300 KB', () => {
    const { busPath, db, live, recent } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, handoffOf(busPath))
    projection.project(NOW)
    const data = files.texts.get(projection.dataFile)!
    expect(Buffer.byteLength(data)).toBeLessThan(PAGE_LIMIT_BYTES)
    expect(dialogCards(boardOf(data).slots.dialogs)).toEqual([...live, ...recent])
    db.close()
  })

  it('a merged card older than 24 h is absent from the page and present in the board --all history page', () => {
    const { busPath, db, old } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, handoffOf(busPath))
    projection.project(NOW)
    const oldest = old[0]!
    expect(dialogCards(boardOf(files.texts.get(projection.dataFile)!).slots.dialogs)).not.toContain(oldest)
    db.close()
    const printed: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      printed.push(String(text))
      return true
    })
    const history = path.join(path.dirname(busPath), BOARD_HISTORY_FILE)
    expect(runBoardCli(busPath, ['--all'])).toBe(0)
    expect(printed.join('')).toBe(`${history}\n`)
    expect(dialogCards(readFileSync(history, 'utf8'))).toContain(oldest)
    expect(files.renamed).not.toContain(history)
  })

  it('board.html is not rewritten on a tick when its template did not change', () => {
    const { busPath, db } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, handoffOf(busPath))
    projection.project(NOW)
    projection.project(new Date(NOW.getTime() + TICK_MS))
    expect(files.renamed.filter(file => file === projection.file)).toHaveLength(1)
    expect(files.renamed.filter(file => file === projection.dataFile)).toHaveLength(1)
    const shell = files.texts.get(projection.file)!
    expect(shell).toBe(renderShell(currentVersion(), TICK_MS))
    expect(shell).toContain('<body data-written="" ')
    expect(shell).not.toContain(`task-${FIRST_CARD}`)
    db.close()
  })

  it('a board.html left by another template is rewritten once and a current one is kept', () => {
    const { busPath, db } = seededBus()
    const file = path.join(path.dirname(busPath), 'board.html')
    writeFileSync(file, '<p>an older template</p>')
    const stale = new MemoryFiles()
    boardProjection(db, busPath, TICK_MS, stale, handoffOf(busPath)).project(NOW)
    expect(stale.renamed).toContain(file)
    DISK_FILES.write(file, renderShell(currentVersion(), TICK_MS))
    const current = new MemoryFiles()
    boardProjection(db, busPath, TICK_MS, current, handoffOf(busPath)).project(NOW)
    expect(current.renamed).not.toContain(file)
    db.close()
  })

  it('liveCardsOf keeps an unsettled card, a merge of the last day and the slices of a task with a slice on the page', () => {
    const card = { stage: 'merged', closed: false, closedAt: null, since: hoursAgo(1) }
    const cards = [
      { ...card, id: 1, stage: 'planned', since: hoursAgo(500) },
      { ...card, id: 2 },
      { ...card, id: 3, since: hoursAgo(MERGED_SHOWN_HOURS + 1) },
      { ...card, id: 4, stage: 'dropped' },
      { ...card, id: 5, since: hoursAgo(MERGED_SHOWN_HOURS + 1), parent: { card: 9 } },
      { ...card, id: 6, stage: 'in work', parent: { card: 9 } },
      { ...card, id: 7, stage: 'in work', closed: true },
    ] as unknown as Parameters<typeof liveCardsOf>[0]
    expect(liveCardsOf(cards, NOW.toISOString()).map(each => each.id)).toEqual([1, 2, 5, 6])
  })
})

describe('the board timer', () => {
  it('a board timer run projects at the clock and returns the time it took', () => {
    const seen: Date[] = []
    const marks = [5, 1205]
    const timer = new BoardTimer(now => seen.push(now), () => NOW, () => marks.shift()!)
    expect(timer.run()).toBe(1200)
    expect(seen).toEqual([NOW])
    expect(boardTimerLine(1200)).toBe('[bus:board-timer] board projected in 1.20 s')
  })

  it('runBoardTimer writes the board from a read-only connection and logs one line per run', async () => {
    const { busPath, db } = seededBus()
    db.close()
    const lines: string[] = []
    let runs = 0
    await runBoardTimer(busPath, 1, () => runs++ < 2, line => lines.push(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[bus:board-timer\] board projected in \d+\.\d\d s$/)
    expect(existsSync(path.join(path.dirname(busPath), 'board-data.js'))).toBe(true)
    expect(readFileSync(path.join(path.dirname(busPath), 'board.html'), 'utf8')).toContain('<body data-written="" ')
  })
})
