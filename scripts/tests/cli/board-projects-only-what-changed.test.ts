import type { DatabaseSync } from 'node:sqlite'
import type { BoardFiles } from '../../cli/board-page.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { boardProjection, DISK_FILES, printBoard } from '../../cli/board-page.js'
import { BOARD_STAMP_FILE, CARD_BUILD_EVENT_LIMIT, CardCache, SECTION_FILE_PREFIX, sectionFileOf } from '../../cli/board-page/sections.js'
import { appendEvent, openBus } from '../../core/db.js'
import { BUS_PULSE, CARD_ADMITTED } from '../../core/events.js'

const NOW = new Date('2026-11-28T12:00:00.000Z')
const TICK_MS = 10_000
const MINUTE_MS = 60_000
const CARDS = [4100, 4101, 4102]
const ADDED = 4103
const LEFT_WHILE_DOWN = 3999
const DROPPED_STATE = 'dropped'
const EDITED_PROSE = 'prose edited behind the bus'
const BOOKKEEPING = 'reducer.reduced'
const LINKED_PR = 77
const QUIET_TICKS = 5
const SNAPSHOT_GREEN = 'data-node="snapshot" data-health="green"'
const SNAPSHOT_META = `snapshot ${TICK_MS / 1000}s</span>`
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

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

  remove = (file: string): void => {
    this.texts.delete(file)
  }

  list = (dir: string): string[] => [...this.texts.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file))

  writesOf(file: string): number {
    return this.renamed.filter(name => name === file).length
  }

  sections(): Map<string, string> {
    return new Map([...this.texts].filter(([file]) => path.basename(file).startsWith(SECTION_FILE_PREFIX)))
  }
}

function admit(db: DatabaseSync, card: number): void {
  const line = `#${card} task-${card} [implement/construct/S/cheap/auto] · depends — · blocks —`
  const text = `card: ${line}\nbranch: feat/${card}\ntouches: scripts/${card}/**\nwho: shift\n\ndo ${card}\n`
  appendEvent(db, { ts: NOW.toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}`, payload: {}, legacy: false })
  const eventId = (db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`${CARD_ADMITTED}:${card}`) as { id: number }).id
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(card, eventId, text, 'a'.repeat(40), 'lane-1', 'shift', null, '[]')
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, NULL, NULL, ?)').run(card, eventId)
}

function seededBus(): { busPath: string, db: DatabaseSync } {
  const root = mkdtempSync(path.join(tmpdir(), 'board-only-changed-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  CARDS.forEach(card => admit(db, card))
  return { busPath, db }
}

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms)
}

function bookkeeping(db: DatabaseSync, ms: number, pr: number | null = null, key = `${BOOKKEEPING}:${ms}`): void {
  appendEvent(db, { ts: at(ms).toISOString(), type: BOOKKEEPING, actor: 'reducer', cardId: null, pr, head: null, dedupeKey: key, payload: {}, legacy: false })
}

function stampOf(text: string): { written: string, hashes: Record<string, string> } {
  const window: { BOARD_STAMP?: { written: string, hashes: Record<string, string> } } = {}
  vm.runInNewContext(text, { window })
  return window.BOARD_STAMP!
}

function sectionHtmlOf(text: string): string {
  let html = ''
  vm.runInNewContext(text, { window: { BOARD_SECTION: (_name: string, _hash: string, shown: string) => {
    html = shown
  } } })
  return html
}

describe('the board projects only what changed', () => {
  it('no projection runs on a tick with no new events, and an unchanged section is not rewritten', () => {
    const { busPath, db } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, path.join(path.dirname(busPath), 'handoff.md'))
    const stampFile = path.join(path.dirname(busPath), BOARD_STAMP_FILE)
    projection.project(NOW)
    const firstSections = files.sections()
    const firstWrites = files.renamed.length
    projection.project(at(TICK_MS))
    expect(files.writesOf(projection.dataFile)).toBe(1)
    expect(files.renamed.slice(firstWrites)).toEqual([stampFile])
    expect(stampOf(files.texts.get(stampFile)!).written).toBe(at(TICK_MS).toISOString())

    db.prepare('UPDATE card_bodies SET text = text || ? WHERE card_id = ?').run(`\n${EDITED_PROSE}\n`, CARDS[0])
    admit(db, ADDED)
    const beforeEvent = files.renamed.length
    projection.project(at(2 * TICK_MS))
    const rewritten = new Set(files.renamed.slice(beforeEvent))
    const dir = path.dirname(busPath)
    expect(files.writesOf(projection.dataFile)).toBe(1)
    expect(rewritten).toContain(sectionFileOf(dir, `dialog-card-${ADDED}`))
    const untouched = [...CARDS.map(card => `dialog-card-${card}`), 'dialog-handoff', 'dialog-decisions'].map(name => sectionFileOf(dir, name))
    for (const file of untouched) {
      expect(rewritten.has(file), file).toBe(false)
      expect(files.texts.get(file), file).toBe(firstSections.get(file))
    }
    const changedBytes = [...rewritten].filter(file => files.sections().has(file)).reduce((sum, file) => sum + Buffer.byteLength(files.texts.get(file)!), 0)
    expect(changedBytes).toBeLessThan(Buffer.byteLength(files.texts.get(projection.dataFile)!))
    expect(Object.keys(stampOf(files.texts.get(stampFile)!).hashes)).toContain(`dialog-card-${ADDED}`)
    expect(files.texts.get(sectionFileOf(dir, `dialog-card-${CARDS[0]}`))).not.toContain(EDITED_PROSE)
    projection.project(at(MINUTE_MS))
    expect(files.texts.get(sectionFileOf(dir, `dialog-card-${CARDS[0]}`))).toContain(EDITED_PROSE)
    expect(files.writesOf(projection.dataFile)).toBe(2)
    db.close()
  })

  it('a card that leaves the board takes its section file with it', () => {
    const { busPath, db } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, path.join(path.dirname(busPath), 'handoff.md'))
    const gone = sectionFileOf(path.dirname(busPath), `dialog-card-${CARDS[2]}`)
    projection.project(NOW)
    expect(files.texts.has(gone)).toBe(true)
    db.prepare('UPDATE cards SET state = ? WHERE card_id = ?').run(DROPPED_STATE, CARDS[2])
    appendEvent(db, { ts: at(TICK_MS).toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARDS[2], pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARDS[2]}:leaves`, payload: {}, legacy: false })
    projection.project(at(TICK_MS))
    expect(files.texts.has(gone)).toBe(false)
    expect(Object.keys(stampOf(files.texts.get(path.join(path.dirname(busPath), BOARD_STAMP_FILE))!).hashes)).not.toContain(`dialog-card-${CARDS[2]}`)
    db.close()
  })

  it('a projection started after a restart removes the section files of cards that left the board while it was down', () => {
    const { busPath, db } = seededBus()
    const dir = path.dirname(busPath)
    const files = new MemoryFiles()
    const leftOver = sectionFileOf(dir, `dialog-card-${LEFT_WHILE_DOWN}`)
    const other = path.join(dir, 'bus.db')
    files.write(leftOver, 'window.BOARD_SECTION("left", "0", "")\n')
    files.write(other, 'kept')
    boardProjection(db, busPath, TICK_MS, files, path.join(dir, 'handoff.md')).project(NOW)
    expect(files.texts.has(leftOver)).toBe(false)
    expect(files.texts.get(other)).toBe('kept')
    expect(files.texts.has(sectionFileOf(dir, `dialog-card-${CARDS[0]}`))).toBe(true)
    db.close()
  })

  it('a quiet bus is projected again once a minute so time readings stay current', () => {
    const { busPath, db } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, path.join(path.dirname(busPath), 'handoff.md'))
    projection.project(NOW)
    projection.project(at(MINUTE_MS - 1))
    expect(files.writesOf(projection.dataFile)).toBe(1)
    projection.project(at(MINUTE_MS))
    expect(files.writesOf(projection.dataFile)).toBe(2)
    db.close()
  })

  it('an event that names neither a card nor a PR rebuilds no card section, and one that names a PR builds the whole board', () => {
    const { busPath, db } = seededBus()
    const dir = path.dirname(busPath)
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, path.join(dir, 'handoff.md'))
    const dialog = sectionFileOf(dir, `dialog-card-${CARDS[0]}`)
    projection.project(NOW)
    db.prepare('UPDATE card_bodies SET text = text || ? WHERE card_id = ?').run(`\n${EDITED_PROSE}\n`, CARDS[0])
    bookkeeping(db, TICK_MS - 1)
    const before = files.renamed.length
    projection.project(at(TICK_MS))
    expect(files.renamed.slice(before)).not.toContain(dialog)
    expect(files.texts.get(dialog)).not.toContain(EDITED_PROSE)
    expect(files.writesOf(projection.dataFile)).toBe(1)
    bookkeeping(db, 2 * TICK_MS - 1, LINKED_PR)
    projection.project(at(2 * TICK_MS))
    expect(files.texts.get(dialog)).toContain(EDITED_PROSE)
    expect(files.writesOf(projection.dataFile)).toBe(2)
    db.close()
  })

  it('as many new events as the card-build limit build the cards, and one more builds the whole board', () => {
    const { busPath, db } = seededBus()
    const files = new MemoryFiles()
    const projection = boardProjection(db, busPath, TICK_MS, files, path.join(path.dirname(busPath), 'handoff.md'))
    projection.project(NOW)
    const burst = (ms: number, count: number): void => {
      for (let event = 0; event < count; event += 1)
        bookkeeping(db, ms, null, `${BOOKKEEPING}:${ms}:${event}`)
    }
    burst(TICK_MS - 1, CARD_BUILD_EVENT_LIMIT)
    projection.project(at(TICK_MS))
    expect(files.writesOf(projection.dataFile)).toBe(1)
    burst(2 * TICK_MS - 1, CARD_BUILD_EVENT_LIMIT + 1)
    projection.project(at(2 * TICK_MS))
    expect(files.writesOf(projection.dataFile)).toBe(2)
    db.close()
  })

  it('a board projected every tick with one pulse event a tick reads its snapshot as fresh between full builds', () => {
    const { busPath, db } = seededBus()
    const dir = path.dirname(busPath)
    const projection = boardProjection(db, busPath, TICK_MS, DISK_FILES, path.join(dir, 'handoff.md'))
    projection.project(NOW)
    for (let tick = 1; tick <= QUIET_TICKS; tick += 1) {
      const ms = tick * TICK_MS - 1
      appendEvent(db, { ts: at(ms).toISOString(), type: BUS_PULSE, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `${BUS_PULSE}:${ms}`, payload: {}, legacy: false })
      projection.project(at(tick * TICK_MS))
      const services = sectionHtmlOf(readFileSync(sectionFileOf(dir, 'services'), 'utf8'))
      expect(services, `tick ${tick}`).toContain(SNAPSHOT_GREEN)
      expect(services, `tick ${tick}`).toContain(SNAPSHOT_META)
    }
    expect(stampOf(readFileSync(path.join(dir, BOARD_STAMP_FILE), 'utf8')).written).toBe(at(QUIET_TICKS * TICK_MS).toISOString())
    db.close()
    writeFileSync(busPath, 'not a database')
    let text = ''
    expect(printBoard(busPath, at((QUIET_TICKS + 1) * TICK_MS), (chunk) => {
      text += chunk
    }, path.join(dir, 'handoff.md'), 'json')).toBe(1)
    expect(JSON.parse(text)).toMatchObject({ stoppedAt: at(QUIET_TICKS * TICK_MS - 1).toISOString(), snapshot: { written: at(QUIET_TICKS * TICK_MS).toISOString(), stale: false } })
  })

  it('a cached dialog is rebuilt when the board\'s card list changes, even for an untouched card', () => {
    const cache = new CardCache<string>()
    const untouched = { kind: 'cards' as const, cursor: 0, touched: new Set<number>() }
    cache.keep(new Map(CARDS.map(card => [card, `detail ${card}`])), new Map(CARDS.map(card => [card, `dialog ${card}`])))
    expect(cache.dialogOf(untouched, CARDS)(CARDS[0]!)).toBe(`dialog ${CARDS[0]}`)
    expect(cache.dialogOf(untouched, [...CARDS, ADDED])(CARDS[0]!)).toBeUndefined()
    expect(cache.dialogOf(untouched, CARDS.slice(1))(CARDS[1]!)).toBeUndefined()
  })

  it('the planned stall lines are reused only across a build that touched no card', () => {
    const cache = new CardCache<never>()
    let computed = 0
    const compute = (): string[] => [`line ${computed += 1}`]
    const plan = (kind: 'cards' | 'full', touched: number[]) => ({ kind, cursor: 0, touched: new Set(touched) })
    expect(cache.stallsOf(plan('full', []))(compute)).toEqual(['line 1'])
    expect(cache.stallsOf(plan('cards', []))(compute)).toEqual(['line 1'])
    expect(cache.stallsOf(plan('cards', [CARDS[0]!]))(compute)).toEqual(['line 2'])
    expect(cache.stallsOf(plan('full', []))(compute)).toEqual(['line 3'])
  })
})
