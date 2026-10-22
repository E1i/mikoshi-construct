import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { prClosed } from '../../bus/observations.js'
import { busMerges } from '../../ghosts/task-merged.js'

describe('the merge fact in the bus', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  function busWith(closings: { ts: string, pr: number, cardId: number | null, merged: boolean, legacy?: boolean }[]): string {
    const root = mkdtempSync(path.join(tmpdir(), 'task-merged-bus-'))
    roots.push(root)
    const file = path.join(root, 'bus.db')
    const db = openBus(file)
    for (const closing of closings) {
      const event = prClosed(closing.ts, { pr: closing.pr, cardId: closing.cardId, merged: closing.merged, commit: closing.merged ? 'c0ffee' : null, mergedBy: closing.merged ? 'E1i' : null, mergedAt: closing.merged ? '2026-10-13T08:30:00Z' : null })
      appendEvent(db, closing.legacy === true ? { ...event, actor: null, legacy: true } : event)
    }
    db.close()
    return file
  }

  it('reads a merged pr.closed with a card as a merge, and leaves out one closed without merge', () => {
    const bus = busWith([
      { ts: '2026-10-13T08:31:00.000Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:32:00.000Z', pr: 701, cardId: 574, merged: false },
    ])
    expect(busMerges(bus)).toEqual([{ task: '570', pr: 700, by: 'E1i', commit: 'c0ffee', merged: '2026-10-13T08:30:00Z', event: 1 }])
  })

  it('reads no pr.closed written before the journal half of history ended, nor one without a card', () => {
    const bus = busWith([
      { ts: '2026-10-12T17:03:59.999Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:31:00.000Z', pr: 702, cardId: null, merged: true },
    ])
    expect(busMerges(bus)).toEqual([])
  })

  it('reads no merge fact from a bus that does not exist', () => {
    expect(busMerges(path.join(tmpdir(), 'no-such-dir-934', 'bus.db'))).toEqual([])
  })

  it('holds a merged pr.closed written at the very instant the journal half of history ends, and leaves out a legacy one', () => {
    const bus = busWith([
      { ts: '2026-10-12T17:04:00.000Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:31:00.000Z', pr: 701, cardId: 574, merged: true, legacy: true },
    ])
    expect(busMerges(bus).map(merge => merge.pr)).toEqual([700])
  })
})
