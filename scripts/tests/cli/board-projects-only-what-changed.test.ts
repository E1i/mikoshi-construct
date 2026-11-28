import type { DatabaseSync } from 'node:sqlite'
import type { BoardFiles } from '../../cli/board-page.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { BOARD_STAMP_FILE, boardProjection, SECTION_FILE_PREFIX, sectionFileOf } from '../../cli/board-page.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'

const NOW = new Date('2026-11-28T12:00:00.000Z')
const TICK_MS = 10_000
const MINUTE_MS = 60_000
const CARDS = [4100, 4101, 4102]
const ADDED = 4103
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

function stampOf(text: string): { written: string, hashes: Record<string, string> } {
  const window: { BOARD_STAMP?: { written: string, hashes: Record<string, string> } } = {}
  vm.runInNewContext(text, { window })
  return window.BOARD_STAMP!
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

    admit(db, ADDED)
    const beforeEvent = files.renamed.length
    projection.project(at(2 * TICK_MS))
    const rewritten = new Set(files.renamed.slice(beforeEvent))
    const dir = path.dirname(busPath)
    expect(files.writesOf(projection.dataFile)).toBe(2)
    expect(rewritten).toContain(sectionFileOf(dir, `dialog-card-${ADDED}`))
    const untouched = [...CARDS.map(card => `dialog-card-${card}`), 'dialog-handoff', 'dialog-decisions'].map(name => sectionFileOf(dir, name))
    for (const file of untouched) {
      expect(rewritten.has(file), file).toBe(false)
      expect(files.texts.get(file), file).toBe(firstSections.get(file))
    }
    const changedBytes = [...rewritten].filter(file => files.sections().has(file)).reduce((sum, file) => sum + Buffer.byteLength(files.texts.get(file)!), 0)
    expect(changedBytes).toBeLessThan(Buffer.byteLength(files.texts.get(projection.dataFile)!))
    expect(Object.keys(stampOf(files.texts.get(stampFile)!).hashes)).toContain(`dialog-card-${ADDED}`)
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
})
