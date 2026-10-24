import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../bus/db.js'
import { openDatabase } from '../../bus/sqlite.js'
import { recordWindowHeartbeat, WINDOW_BEAT_MS, windowBeat, windowOf, windowSessionOf } from '../../bus/window-heartbeat.js'
import { WINDOW_ACTOR } from '../../bus/window-requests.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'
import { NO_TRANSCRIPT, sessionGauges } from '../../miko/eddies-measure.js'
import { productionDeps } from '../../miko/watch.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'

const START = Date.parse('2026-10-20T10:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
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

function sqliteErrorOf(run: () => void): unknown {
  try {
    run()
  }
  catch (error) {
    return error
  }
  throw new Error('the statement did not fail')
}

function lockedBusError(file: string): unknown {
  const holder = openBus(file)
  const waiter = openDatabase(file, { timeout: 0 })
  try {
    holder.exec('BEGIN IMMEDIATE')
    return sqliteErrorOf(() => waiter.exec('BEGIN IMMEDIATE'))
  }
  finally {
    holder.exec('ROLLBACK')
    waiter.close()
    holder.close()
  }
}

describe('the window heartbeat', () => {
  it('a window session without MIKO_WINDOW records a window.heartbeat carrying mode tab', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tab-tree-'))
    roots.push(root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('CLAUDE_PROJECT_DIR', root)
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'tab-1')
    vi.stubEnv(WINDOW_VARIABLE, undefined)
    vi.stubEnv(LOOP_PID_VARIABLE, undefined)
    vi.stubEnv(EXIT_REQUEST_VARIABLE, undefined)
    vi.stubEnv(CARD_VARIABLE, '')
    const file = busFile()
    productionDeps(root, file).beat()
    const db = openBus(file)
    const row = db.prepare('SELECT actor, payload FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { actor: string, payload: string }
    db.close()
    expect(row.actor).toBe(`${WINDOW_ACTOR}tab-1`)
    expect(JSON.parse(row.payload)).toMatchObject({ session: 'tab-1', mode: 'tab' })
    expect(windowOf({ CLAUDE_CODE_SESSION_ID: 'tab-1', CONSTRUCT_CARD: '1265' })).toBeNull()
  })

  it('a window is a session the loop marked and no card: an unmarked session, a card session, a missing session and a session id with a colon beat nothing', () => {
    const marked = { [WINDOW_VARIABLE]: WINDOW_MARK }
    expect(windowSessionOf({ ...marked, CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBe('abc-1')
    expect(windowSessionOf({ ...marked, CLAUDE_CODE_SESSION_ID: 'abc-1', CONSTRUCT_CARD: '' })).toBe('abc-1')
    expect(windowSessionOf({ CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBeNull()
    expect(windowSessionOf({ [WINDOW_VARIABLE]: '', CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBeNull()
    expect(windowSessionOf({ ...marked, CLAUDE_CODE_SESSION_ID: 'abc-1', CONSTRUCT_CARD: '1137' })).toBeNull()
    expect(windowSessionOf(marked)).toBeNull()
    expect(windowSessionOf({ ...marked, CLAUDE_CODE_SESSION_ID: 'a:b' })).toBeNull()
    expect(windowSessionOf({ [LOOP_PID_VARIABLE]: '4242', CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBe('abc-1')
    expect(windowSessionOf({ [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request', CLAUDE_CODE_SESSION_ID: 'abc-1' })).toBe('abc-1')
  })

  it('a beat is a window sign: written once per ts under the window actor of its session', () => {
    const db = openBus(':memory:')
    const ts = new Date(START).toISOString()
    expect(recordWindowHeartbeat(db, ts, 'abc-1')).toBe(true)
    expect(recordWindowHeartbeat(db, ts, 'abc-1')).toBe(false)
    expect(db.prepare('SELECT actor, card_id FROM events WHERE type = ?').all(WINDOW_HEARTBEAT)).toEqual([{ actor: `${WINDOW_ACTOR}abc-1`, card_id: null }])
  })

  it('a written beat waits the full interval before the next', () => {
    const file = busFile()
    let now = START
    let measures = 0
    const beat = windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => now, () => {
      measures += 1
      return {}
    })
    beat()
    now += WINDOW_BEAT_MS - 1
    beat()
    expect(measures).toBe(1)
    now += 1
    beat()
    expect(beats(file)).toEqual([START, START + WINDOW_BEAT_MS].map(ms => ({ ts: new Date(ms).toISOString(), actor: `${WINDOW_ACTOR}abc-1` })))
  })

  it('a session that is not a window beats nothing', () => {
    const silent = busFile()
    windowBeat(silent, null, () => START, () => ({}))()
    expect(beats(silent)).toEqual([])
  })

  it('a locked bus skips one window beat without throwing', () => {
    const file = busFile()
    const locked = lockedBusError(file)
    expect(locked).toMatchObject({ errcode: 5 })
    const beat = windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => START, () => {
      throw locked
    })
    expect(() => beat()).not.toThrow()
    expect(beats(file)).toEqual([])
  })

  it('a beat lost to a locked bus is retried at the next tick', () => {
    const file = busFile()
    const locked = lockedBusError(file)
    let now = START
    let measures = 0
    const beat = windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => now, () => {
      measures += 1
      if (measures === 1)
        throw locked
      return {}
    })
    beat()
    now += 1
    beat()
    expect(measures).toBe(2)
    expect(beats(file)).toEqual([{ ts: new Date(START + 1).toISOString(), actor: `${WINDOW_ACTOR}abc-1` }])
    now += WINDOW_BEAT_MS - 1
    beat()
    expect(measures).toBe(2)
  })

  it('an error other than a locked bus still throws from the window beat', () => {
    const file = busFile()
    const malformed = sqliteErrorOf(() => openDatabase(':memory:').exec('SELEKT 1'))
    expect(malformed).toMatchObject({ errcode: 1 })
    expect(() => windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => START, () => {
      throw malformed
    })()).toThrow(malformed as Error)
    const broken = new Error('the transcript cannot be read')
    expect(() => windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => START, () => {
      throw broken
    })()).toThrow(broken)
  })

  it('the window heartbeat carries the gauges of the window session transcript', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'window-home-'))
    const root = mkdtempSync(path.join(tmpdir(), 'window-tree-'))
    roots.push(home, root)
    const transcript = path.join(home, '.claude', 'projects', '-repo', 'abc-1.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: 2_000, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 10_000 } } })}\n`)
    const file = busFile()
    windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => START, session => sessionGauges(home, root, session))()
    const db = openBus(file)
    const row = db.prepare('SELECT payload FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { payload: string }
    db.close()
    expect(JSON.parse(row.payload)).toEqual({ session: 'abc-1', mode: 'loop', context: 42_000, spent: 2_000 + 30_000 * 1.25 + 10_000 * 0.1 })

    const unread = busFile()
    windowBeat(unread, { session: 'abc-2', mode: 'tab' }, () => START, session => sessionGauges(home, root, session))()
    const quiet = openBus(unread)
    expect(quiet.prepare('SELECT payload FROM events WHERE type = ?').all(WINDOW_HEARTBEAT)).toEqual([{ payload: JSON.stringify({ session: 'abc-2', mode: 'tab', reason: NO_TRANSCRIPT }) }])
    quiet.close()
  })

  it('the beat of miko:watch, measured the way the watch measures, writes a window.heartbeat with the context and spend of the window transcript', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'watch-home-'))
    const root = mkdtempSync(path.join(tmpdir(), 'watch-tree-'))
    roots.push(home, root)
    const transcript = path.join(home, '.claude', 'projects', '-repo', 'window-1.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, [
      { requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: 1_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0 } } },
      { requestId: 'r2', message: { role: 'assistant', usage: { input_tokens: 500, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 21_000 } } },
    ].map(line => `${JSON.stringify(line)}\n`).join(''))
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_PROJECT_DIR', root)
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'window-1')
    vi.stubEnv(WINDOW_VARIABLE, WINDOW_MARK)
    vi.stubEnv(CARD_VARIABLE, '')
    const file = busFile()
    productionDeps(root, file).beat()
    const db = openBus(file)
    const row = db.prepare('SELECT actor, payload FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { actor: string, payload: string }
    db.close()
    expect(row.actor).toBe(`${WINDOW_ACTOR}window-1`)
    expect(JSON.parse(row.payload)).toEqual({ session: 'window-1', mode: 'loop', context: 25_500, spent: 1_500 + 24_000 * 1.25 + 21_000 * 0.1 })
  })
})
