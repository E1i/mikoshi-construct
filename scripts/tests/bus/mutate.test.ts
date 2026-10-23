import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mutationJudgedLine } from '../../../src/commands/mutate/journal.js'
import { ghostJournalOf } from '../../bus/check-catalog.js'
import { openBus } from '../../bus/db.js'
import { busMutationJudged } from '../../bus/mutate.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('pnpm mutate judge --card records its verdict in the bus', () => {
  it('records a mutation-judged ghost line for the card and names the bus it wrote to', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-mutate-'))
    roots.push(root)
    const bus = path.join(root, 'bus.db')
    const line = mutationJudgedLine({ card: '616', id: 'M1', outcome: 'named-red', matched: true }, new Date('2026-10-22T10:00:00.000Z'))

    expect(busMutationJudged(bus)(line)).toBe(bus)

    const db = openBus(bus)
    try {
      expect(ghostJournalOf(db)).toBe(`${JSON.stringify(line)}\n`)
      expect(db.prepare('SELECT card_id FROM events WHERE type = \'ghost.line\'').all()).toEqual([{ card_id: 616 }])
    }
    finally {
      db.close()
    }
  })
})
