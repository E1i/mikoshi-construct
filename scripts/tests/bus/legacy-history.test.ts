import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { legacyEventOf } from '../../bus/import.js'
import { legacyHistory } from '../../bus/legacy-history.js'

let dir: string
let db: DatabaseSync

function appendLine(entry: object, lineNumber: number): void {
  const event = legacyEventOf(JSON.stringify(entry), lineNumber)
  if (event === null)
    throw new Error('the line is not a legacy event')
  appendEvent(db, event)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'legacy-history-'))
  db = openBus(path.join(dir, 'bus.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('legacyHistory', () => {
  it('returns the journal lines of the legacy events before the cutoff in journal order', () => {
    const first = { event: 'path', task: '12', ts: '2026-10-01T10:00:00.000Z' }
    const second = { event: 'merge', task: '12', pr: 40, ts: '2026-10-02T10:00:00.000Z' }
    appendLine(first, 1)
    appendLine(second, 2)
    expect(legacyHistory(db)).toEqual([first, second])
  })

  it('returns no line written after the cutoff', () => {
    const before = { event: 'path', task: '12', ts: '2026-10-01T10:00:00.000Z' }
    appendLine(before, 1)
    appendLine({ event: 'merge', task: '12', ts: '2026-10-13T10:00:00.000Z' }, 2)
    expect(legacyHistory(db)).toEqual([before])
  })
})
