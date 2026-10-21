import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { recordWindowHeartbeat, WINDOW_BEAT_MS, windowBeat, windowSessionOf } from '../../bus/window-heartbeat.js'
import { WINDOW_ACTOR } from '../../bus/window-requests.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'

const START = Date.parse('2026-10-20T10:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'window-beat-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function beats(file: string): { ts: string, actor: string }[] {
  const db = openBus(file)
  try {
    return db.prepare('SELECT ts, actor FROM events WHERE type = ? ORDER BY id').all(WINDOW_HEARTBEAT) as { ts: string, actor: string }[]
  }
  finally {
    db.close()
  }
}

describe('the window heartbeat', () => {
  it('a window is a session with no card: a card session, a missing session and a session id with a colon beat nothing', () => {
    expect(windowSessionOf({ CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBe('abc-1')
    expect(windowSessionOf({ CLAUDE_CODE_SESSION_ID: 'abc-1', CONSTRUCT_CARD: '' })).toBe('abc-1')
    expect(windowSessionOf({ CLAUDE_CODE_SESSION_ID: 'abc-1', CONSTRUCT_CARD: '1137' })).toBeNull()
    expect(windowSessionOf({})).toBeNull()
    expect(windowSessionOf({ CLAUDE_CODE_SESSION_ID: 'a:b' })).toBeNull()
  })

  it('a beat is a window sign: written once per ts under the window actor of its session', () => {
    const db = openBus(':memory:')
    const ts = new Date(START).toISOString()
    expect(recordWindowHeartbeat(db, ts, 'abc-1')).toBe(true)
    expect(recordWindowHeartbeat(db, ts, 'abc-1')).toBe(false)
    expect(db.prepare('SELECT actor, card_id FROM events WHERE type = ?').all(WINDOW_HEARTBEAT)).toEqual([{ actor: `${WINDOW_ACTOR}abc-1`, card_id: null }])
  })

  it('beats at most once per beat interval, and not at all without a window session', () => {
    const file = busFile()
    let now = START
    const beat = windowBeat(file, 'abc-1', () => now)
    beat()
    now += WINDOW_BEAT_MS - 1
    beat()
    now += 1
    beat()
    expect(beats(file)).toEqual([START, START + WINDOW_BEAT_MS].map(ms => ({ ts: new Date(ms).toISOString(), actor: `${WINDOW_ACTOR}abc-1` })))

    const silent = busFile()
    windowBeat(silent, null, () => START)()
    expect(beats(silent)).toEqual([])
  })
})
