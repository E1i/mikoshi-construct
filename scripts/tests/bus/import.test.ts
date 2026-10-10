import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { importJournal } from '../../bus/import.js'

const HEAD = '29342d7559e14412b73d1d5d6dd216363cfc07c0'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-import-'))
  roots.push(root)
  return root
}

const JOURNAL = [
  { event: 'path', task: '681', path: 'cheap', ts: '2026-10-01T10:00:00.000Z' },
  { event: 'merge', task: '681', pr: 690, commit: 'c0ffee', ts: '2026-10-01T11:00:00.000Z' },
  { event: 'intake', card: '#753 owner-merges-narrows [implement/runner/S/cheap/owner] · depends — · blocks —', ts: '2026-10-02T09:00:00.000Z' },
  { event: 'stop', card: 656, at: 'merge' },
  { event: 'review', card: { id: 729, name: 'x', line: '#729 x' }, pr: 731, head: HEAD, ts: '2026-10-03T09:00:00.000Z' },
  { event: 'note', text: 'prose' },
].map(entry => JSON.stringify(entry)).join('\n').concat('\nnot json\n')

function rows(db: ReturnType<typeof openBus>): Record<string, unknown>[] {
  return db.prepare('SELECT type, actor, card_id, pr, head, legacy FROM events ORDER BY id').all() as Record<string, unknown>[]
}

describe('the one-time journal import', () => {
  it('the journal imports once as legacy events and a second import adds nothing', () => {
    const db = openBus(path.join(newRoot(), 'bus.db'))
    expect(importJournal(db, JOURNAL)).toEqual({ imported: 6, present: 0, unreadable: [7], admitted: 0 })
    const first = db.prepare('SELECT * FROM events ORDER BY id').all()
    expect(first.every(row => row.legacy === 1 && row.actor === null)).toBe(true)
    expect(importJournal(db, JOURNAL)).toEqual({ imported: 0, present: 6, unreadable: [7], admitted: 0 })
    expect(db.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(first)
    db.close()
  })

  it('imports a journal that grew since the last import by its new lines only', () => {
    const db = openBus(path.join(newRoot(), 'bus.db'))
    importJournal(db, JOURNAL)
    const grown = `${JOURNAL}${JSON.stringify({ event: 'note', text: 'prose' })}\n`
    expect(importJournal(db, grown)).toEqual({ imported: 1, present: 6, unreadable: [7], admitted: 0 })
    db.close()
  })

  it('the import leaves ghosts.jsonl byte-identical', () => {
    const root = newRoot()
    const journal = path.join(root, 'ghosts.jsonl')
    writeFileSync(journal, JOURNAL)
    const before = readFileSync(journal)
    const db = openBus(path.join(root, 'bus.db'))
    importJournal(db, readFileSync(journal, 'utf8'))
    importJournal(db, readFileSync(journal, 'utf8'))
    db.close()
    expect(readFileSync(journal).equals(before)).toBe(true)
  })

  it('a card given as slug, number or object imports as one integer card_id', () => {
    const db = openBus(path.join(newRoot(), 'bus.db'))
    importJournal(db, JOURNAL)
    expect(rows(db)).toEqual([
      { type: 'path', actor: null, card_id: 681, pr: null, head: null, legacy: 1 },
      { type: 'merge', actor: null, card_id: 681, pr: 690, head: null, legacy: 1 },
      { type: 'intake', actor: null, card_id: 753, pr: null, head: null, legacy: 1 },
      { type: 'stop', actor: null, card_id: 656, pr: null, head: null, legacy: 1 },
      { type: 'review', actor: null, card_id: 729, pr: 731, head: HEAD, legacy: 1 },
      { type: 'note', actor: null, card_id: null, pr: null, head: null, legacy: 1 },
    ])
    db.close()
  })

  it('keeps each journal line verbatim as the payload', () => {
    const db = openBus(path.join(newRoot(), 'bus.db'))
    importJournal(db, JOURNAL)
    const payloads = db.prepare('SELECT payload FROM events ORDER BY id').all().map(row => row.payload)
    expect(payloads).toEqual(JOURNAL.split('\n').slice(0, 6))
    db.close()
  })
})
