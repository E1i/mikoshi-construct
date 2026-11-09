import type { SeedEvent } from './bus-fixture.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printBoard } from '../../scripts/cli/board-page.js'
import { CARD_STARTED, PROCESS_HEARTBEAT, SESSION_HEARTBEAT } from '../../scripts/core/events.js'
import { SUPERVISOR_PROCESS } from '../../scripts/supervisor/supervisor.js'
import { SESSION_SHOWN_MINUTES } from '../../src/commands/board/bus.js'
import { WINDOW_SILENT_MS } from '../../src/commands/liveness.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-09T15:40:00.000Z')
const MINUTE = 60_000
const STALE_SUPERVISE = '2026-11-07T14:39:00.000Z'
const LIVE_HEADER = '<span class="live" id="bus-live">bus live</span>'
const OFFLINE_HEADER = '<span class="live" id="bus-live" data-stale>bus offline</span>'
const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('BUS_RERUN', '')
})

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

function busWithStaleSupervise(events: SeedEvent[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-liveness-'))
  roots.push(root)
  const file = writeBus(path.join(root, 'bus.db'), {
    events,
    beats: [{ process: SUPERVISOR_PROCESS, type: PROCESS_HEARTBEAT, ts: STALE_SUPERVISE, payload: JSON.stringify({ process: SUPERVISOR_PROCESS }) }],
  })
  const db = new DatabaseSync(file)
  try {
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  }
  finally {
    db.close()
  }
  return file
}

function headerOf(busPath: string): string {
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(path.dirname(busPath), 'miko.md'), 'html')).toBe(0)
  return html
}

describe('the factory status does not follow one stale supervise signal', () => {
  it('a live launch worker writing events with a stale supervise signal does not give the status factory not running', () => {
    const html = headerOf(busWithStaleSupervise([
      { ts: ago(7 * MINUTE), type: CARD_STARTED, card: 45, payload: JSON.stringify({ session: 's-45' }) },
      { ts: ago(MINUTE), type: SESSION_HEARTBEAT, card: 45, payload: JSON.stringify({ session: 's-45', step: 'launch' }) },
    ]))
    expect(html).toContain(LIVE_HEADER)
    expect(html).not.toContain(OFFLINE_HEADER)
  })

  it('a launch worker silent past the limit beside the stale supervise signal still reads offline', () => {
    const html = headerOf(busWithStaleSupervise([
      { ts: ago(WINDOW_SILENT_MS + MINUTE), type: CARD_STARTED, card: 45, payload: JSON.stringify({ session: 's-45' }) },
      { ts: ago((SESSION_SHOWN_MINUTES + 1) * MINUTE), type: SESSION_HEARTBEAT, card: 45, payload: JSON.stringify({ session: 's-45', step: 'launch' }) },
    ]))
    expect(html).toContain(OFFLINE_HEADER)
    expect(html).not.toContain(LIVE_HEADER)
  })
})
