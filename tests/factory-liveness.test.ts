import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../scripts/core/db.js'
import { WINDOW_HEARTBEAT } from '../scripts/core/events.js'
import { factoryLiveness, WINDOW_SILENT_MS } from '../src/commands/liveness.js'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')

function busFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'factory-liveness-')), 'bus.db')
}

function beat(file: string, session: string, ageMs: number): string {
  const ts = new Date(NOW - ageMs).toISOString()
  const db = openBus(file)
  try {
    appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `worker:window:${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session, mode: 'tab' }, legacy: false })
  }
  finally {
    db.close()
  }
  return ts
}

describe('the factory is live while its newest window.heartbeat is fresh', () => {
  it('a fresh window.heartbeat reads live and names the beat', () => {
    const file = busFile()
    beat(file, 'old', WINDOW_SILENT_MS * 3)
    const newest = beat(file, 'new', 60_000)
    expect(factoryLiveness(file, NOW)).toEqual({ state: 'live', lastBeat: newest })
  })

  it('a window.heartbeat older than the silence reads offline', () => {
    const file = busFile()
    const stale = beat(file, 'tab-1', WINDOW_SILENT_MS + 1)
    expect(factoryLiveness(file, NOW)).toEqual({ state: 'offline', lastBeat: stale })
  })

  it('a bus with no window.heartbeat reads offline', () => {
    const file = busFile()
    openBus(file).close()
    expect(factoryLiveness(file, NOW)).toEqual({ state: 'offline', lastBeat: null })
  })

  it('an absent bus, or the empty bus attach leaves, reads offline', () => {
    const file = busFile()
    expect(factoryLiveness(file, NOW)).toEqual({ state: 'offline', lastBeat: null })
    writeFileSync(file, '')
    expect(factoryLiveness(file, NOW)).toEqual({ state: 'offline', lastBeat: null })
  })
})
