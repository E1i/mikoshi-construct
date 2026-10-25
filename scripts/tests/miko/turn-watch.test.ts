import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { RAISED_VARIABLE } from '../../nodes/restart/role.js'
import { recordWindowHeartbeat, WINDOW_BEAT_MS } from '../../window/window-heartbeat.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../window/tab.js'
import { lastWindowBeat, LIVE_WATCH, NO_LIVE_WATCH, NOT_A_WINDOW, realTurnWatchDeps, runTurnWatch, TAB_CONTINUE, TAB_STOPS, watchIsLive } from '../../window/turn-watch.js'
import { WINDOW_MARK, WINDOW_VARIABLE, withoutCard } from '../../ports/session.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const TURN_WATCH = path.join(REPO_ROOT, 'scripts', 'miko', 'turn-watch.ts')
const NOW = Date.parse('2026-10-21T10:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'turn-watch-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function beat(bus: string, session: string, at: number): void {
  const db = openBus(bus)
  try {
    recordWindowHeartbeat(db, new Date(at).toISOString(), session)
  }
  finally {
    db.close()
  }
}

function lastBeatIn(bus: string, session: string): string | null {
  const db = openBus(bus)
  try {
    return lastWindowBeat(db, session)
  }
  finally {
    db.close()
  }
}

function run(session: string | null, lastBeat: string | null): { code: number, lines: string[] } {
  const lines: string[] = []
  const code = runTurnWatch({ session, mode: 'loop', status: () => null, lastBeat: () => lastBeat, now: () => NOW, err: line => lines.push(line) })
  return { code, lines }
}

describe('a window turn ends only while a miko:watch beats for its session', () => {
  it('a window turn without a window.heartbeat newer than the beat interval is refused', () => {
    expect(run('s-window', null)).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
    expect(run('s-window', new Date(NOW - WINDOW_BEAT_MS - 1).toISOString())).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
    expect(run('s-window', 'not a time')).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
  })

  it('a window turn with a window.heartbeat within the beat interval passes', () => {
    expect(run('s-window', new Date(NOW - WINDOW_BEAT_MS).toISOString())).toEqual({ code: 0, lines: [LIVE_WATCH] })
    expect(run('s-window', new Date(NOW - 1000).toISOString())).toEqual({ code: 0, lines: [LIVE_WATCH] })
  })

  it('a session that is not a window is not asked for a watch', () => {
    expect(run(null, null)).toEqual({ code: 0, lines: [NOT_A_WINDOW] })
  })

  it('the beat interval is the boundary', () => {
    expect(watchIsLive(new Date(NOW - WINDOW_BEAT_MS).toISOString(), NOW)).toBe(true)
    expect(watchIsLive(new Date(NOW - WINDOW_BEAT_MS - 1).toISOString(), NOW)).toBe(false)
  })

  it('the last beat is the newest of this session, not of another window session, and not a legacy row', () => {
    const bus = busFile()
    beat(bus, 's-window', NOW - 3 * WINDOW_BEAT_MS)
    beat(bus, 's-window', NOW - 2 * WINDOW_BEAT_MS)
    beat(bus, 's-other', NOW)
    const db = openBus(bus)
    try {
      appendEvent(db, { ts: new Date(NOW).toISOString(), type: WINDOW_HEARTBEAT, actor: 'window:s-window', cardId: null, pr: null, head: null, dedupeKey: 'legacy-beat', payload: { session: 's-window' }, legacy: true })
    }
    finally {
      db.close()
    }
    expect(lastBeatIn(bus, 's-window')).toBe(new Date(NOW - 2 * WINDOW_BEAT_MS).toISOString())
    expect(lastBeatIn(bus, 's-none')).toBeNull()
  })

  it('the CLI exits 1 for a window session with no live watch and 0 once its watch beats', () => {
    const bus = busFile()
    const cli = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ['--import', 'tsx', TURN_WATCH], {
      cwd: REPO_ROOT,
      env: { ...process.env, CONSTRUCT_BUS_DB: bus, CLAUDE_CODE_SESSION_ID: 's-cli', CONSTRUCT_CARD: '', [WINDOW_VARIABLE]: WINDOW_MARK },
      encoding: 'utf8',
    })
    const refused = cli()
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(NO_LIVE_WATCH)
    beat(bus, 's-cli', Date.now())
    const passed = cli()
    expect(passed.status).toBe(0)
    expect(passed.stderr).toContain(LIVE_WATCH)
  }, 20_000)
})

describe('the loop window waits on a watch, a tab window on the STATUS of its handoff', () => {
  function hook(env: NodeJS.ProcessEnv): { code: number, lines: string[] } {
    const lines: string[] = []
    const code = runTurnWatch({ ...realTurnWatchDeps(env), lastBeat: () => null, now: () => NOW, err: line => lines.push(line) })
    return { code, lines }
  }

  function handoffDir(status: string | null): NodeJS.ProcessEnv {
    const dir = mkdtempSync(path.join(tmpdir(), 'turn-watch-handoff-'))
    roots.push(dir)
    if (status !== null)
      writeFileSync(path.join(dir, MIKO_HANDOFF_NAME), `# Handoff\n\nSTATUS: CONTINUE\n\nSTATUS: ${status}\n`)
    return { [HANDOFF_DIR_VARIABLE]: dir }
  }

  const marked = { [WINDOW_VARIABLE]: WINDOW_MARK }
  const headless = { [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }

  it('a headless reviewer session started withoutCard is not a window and its stop is not blocked, whatever the handoff says', () => {
    const continuing = handoffDir('CONTINUE')
    expect(hook(withoutCard({ ...continuing, ...headless, CLAUDE_CODE_SESSION_ID: 's-reviewer', CONSTRUCT_CARD: '1197' }))).toEqual({ code: 0, lines: [NOT_A_WINDOW] })
    expect(hook(withoutCard({ ...continuing, ...headless, ...marked, CLAUDE_CODE_SESSION_ID: 's-reviewer', CONSTRUCT_CARD: '1197' }))).toEqual({ code: 0, lines: [NOT_A_WINDOW] })
    expect(hook({ ...continuing, CLAUDE_CODE_SESSION_ID: 's-raised', [RAISED_VARIABLE]: '1' })).toEqual({ code: 0, lines: [NOT_A_WINDOW] })
  })

  it('a tab window whose handoff ends STATUS: CONTINUE is blocked with the watch to run, and stops at any other STATUS or without a handoff', () => {
    expect(hook({ ...handoffDir('CONTINUE'), CLAUDE_CODE_SESSION_ID: 's-tab', [WINDOW_VARIABLE]: '' })).toEqual({ code: 1, lines: [TAB_CONTINUE] })
    expect(TAB_CONTINUE).toContain('pnpm miko:watch --once')
    for (const status of ['OWNER', 'DONE', null])
      expect(hook({ ...handoffDir(status), CLAUDE_CODE_SESSION_ID: 's-tab' })).toEqual({ code: 0, lines: [TAB_STOPS] })
  })

  it('a window session with the marker and no live watch is blocked', () => {
    expect(hook({ ...marked, CLAUDE_CODE_SESSION_ID: 's-window' })).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
  })

  it('a card session is not blocked', () => {
    expect(hook({ ...marked, CLAUDE_CODE_SESSION_ID: 's-card', CONSTRUCT_CARD: '1197' })).toEqual({ code: 0, lines: [NOT_A_WINDOW] })
  })
})
