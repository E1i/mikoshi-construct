import type { WindowLook, WindowSession } from '../../window/window-heartbeat.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../core/db.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'
import { WINDOW_ACTOR } from '../../core/node.js'
import { openDatabase } from '../../core/sqlite.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { LOADED_CORE_VARIABLE, NO_TRANSCRIPT, sessionGauges } from '../../window/eddies-measure.js'
import { productionDeps } from '../../window/watch.js'
import { lookAtWindow, recordWindowHeartbeat, WINDOW_BEAT_MS, windowBeat, windowOf, windowSessionOf } from '../../window/window-heartbeat.js'

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
  it('a session the tab launcher marked records a window.heartbeat carrying mode tab', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tab-tree-'))
    roots.push(root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('CLAUDE_PROJECT_DIR', root)
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'tab-1')
    vi.stubEnv(WINDOW_VARIABLE, 'tab')
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

  it('a beat lost to a locked bus is retried on the next poll', () => {
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
    const look = (window: WindowSession): WindowLook => lookAtWindow({ ...window, root }, {}, home)
    windowBeat(file, { session: 'abc-1', mode: 'loop' }, () => START, session => sessionGauges(home, root, session), () => {}, look)()
    const db = openBus(file)
    const row = db.prepare('SELECT payload FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { payload: string }
    db.close()
    expect(JSON.parse(row.payload)).toEqual({ session: 'abc-1', mode: 'loop', context: 42_000, spent: 2_000 + 30_000 * 1.25 + 10_000 * 0.1, crawlers: [], skills: [] })

    const unread = busFile()
    windowBeat(unread, { session: 'abc-2', mode: 'tab' }, () => START, session => sessionGauges(home, root, session), () => {}, look)()
    const quiet = openBus(unread)
    expect(quiet.prepare('SELECT payload FROM events WHERE type = ?').all(WINDOW_HEARTBEAT)).toEqual([{ payload: JSON.stringify({ session: 'abc-2', mode: 'tab', reason: NO_TRANSCRIPT, crawlers: [], skills: [] }) }])
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
    vi.stubEnv(LOADED_CORE_VARIABLE, '7')
    const file = busFile()
    productionDeps(root, file).beat()
    const db = openBus(file)
    const row = db.prepare('SELECT actor, payload FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { actor: string, payload: string }
    db.close()
    expect(row.actor).toBe(`${WINDOW_ACTOR}window-1`)
    expect(JSON.parse(row.payload)).toEqual({ session: 'window-1', mode: 'loop', root, context: 25_500, spent: 1_500 + 24_000 * 1.25 + 21_000 * 0.1, core: 7, crawlers: [], skills: [] })
  })
})

describe('what the window beat sees of the window session', () => {
  function windowTree(): { home: string, root: string, transcript: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'look-home-'))
    const root = mkdtempSync(path.join(tmpdir(), 'look-tree-'))
    roots.push(home, root)
    const transcript = path.join(home, '.claude', 'projects', '-repo', 'w-1.jsonl')
    mkdirSync(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents'), { recursive: true })
    mkdirSync(path.join(root, '.construct'), { recursive: true })
    return { home, root, transcript }
  }

  function subagent(transcript: string, id: string, meta: object, lines: object[]): void {
    const base = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}`)
    writeFileSync(`${base}.meta.json`, JSON.stringify(meta))
    writeFileSync(`${base}.jsonl`, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  }

  it('a started subagent with an open tool call is CRAWLING, a closed turn is IDLE, a stopped one leaves the list', () => {
    const { home, root, transcript } = windowTree()
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'intake' } }, { type: 'tool_use', name: 'Skill', input: { skill: 'intake' } }] } })}\n`)
    writeFileSync(path.join(root, '.construct', 'window-agents.jsonl'), [
      { event: 'start', id: 'a1', type: 'general-purpose', session: 'w-1', at: '2026-10-20T09:58:00.000Z' },
      { event: 'start', id: 'a2', type: 'explore', session: 'w-1', at: '2026-10-20T09:59:00.000Z' },
      { event: 'start', id: 'a3', type: 'explore', session: 'w-1', at: '2026-10-20T09:59:00.000Z' },
      { event: 'stop', id: 'a3', session: 'w-1' },
      { event: 'start', id: 'b1', type: 'explore', session: 'other', at: '2026-10-20T09:59:00.000Z' },
    ].map(line => JSON.stringify(line)).join('\n'))
    const usage = { input_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
    subagent(transcript, 'a1', { agentType: 'general-purpose', description: 'reads the diff' }, [{ type: 'assistant', requestId: 'r1', message: { role: 'assistant', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }])
    subagent(transcript, 'a2', { agentType: 'explore' }, [{ type: 'assistant', requestId: 'r1', message: { role: 'assistant', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] } }])
    const look = lookAtWindow({ session: 'w-1', mode: 'loop', root }, { [LOADED_CORE_VARIABLE]: '9' }, home)
    expect(look.core).toBe(9)
    expect(look.skills).toEqual(['intake'])
    expect(look.crawlers.map(({ id, kind, description, state }) => ({ id, kind, description, state }))).toEqual([
      { id: 'a1', kind: 'general-purpose', description: 'reads the diff', state: 'CRAWLING' },
      { id: 'a2', kind: 'explore', description: null, state: 'IDLE' },
    ])
    expect(look.crawlers[0]!.ctx).toBeGreaterThan(0)
  })

  it('a subagent the window transcript stopped with TaskStop leaves the list though the hook record never wrote its stop', () => {
    const { home, root, transcript } = windowTree()
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskStop', input: { task_id: 'a2' } }] } })}\n`)
    writeFileSync(path.join(root, '.construct', 'window-agents.jsonl'), [
      { event: 'start', id: 'a1', type: 'general-purpose', session: 'w-1', at: '2026-10-20T09:58:00.000Z' },
      { event: 'start', id: 'a2', type: 'explore', session: 'w-1', at: '2026-10-20T09:59:00.000Z' },
    ].map(line => JSON.stringify(line)).join('\n'))
    const look = lookAtWindow({ session: 'w-1', mode: 'loop', root }, {}, home)
    expect(look.crawlers.map(({ id }) => id)).toEqual(['a1'])
  })

  it('a window with no transcript sees no crawler and no skill, and an unset core is left out', () => {
    const { home, root } = windowTree()
    expect(lookAtWindow({ session: 'w-2', mode: 'loop', root }, {}, home)).toEqual({ crawlers: [], skills: [] })
  })
})
