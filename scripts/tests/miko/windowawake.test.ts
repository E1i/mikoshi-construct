import type { WindowMode } from '../../ports/session.js'
import type { Status } from '../../window/loop.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { WINDOW_VARIABLE } from '../../ports/session.js'
import { MIKO_HANDOFF_NAME, TAB_MODE } from '../../window/loop.js'
import { LIVE_WATCH, NO_LIVE_WATCH, OWNER_QUESTION_WAITS, realTurnWatchDeps, runTurnWatch } from '../../window/turn-watch.js'
import { ONCE_STORE, OnceStore } from '../../window/watch-store.js'
import { WINDOW_BEAT_MS } from '../../window/window-heartbeat.js'

const NOW = Date.parse('2026-11-03T03:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function ownerQuestionHandoff(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'windowawake-'))
  roots.push(dir)
  writeFileSync(path.join(dir, MIKO_HANDOFF_NAME), '# Handoff\n\nSTATUS: CONTINUE\n\nSTATUS: OWNER — boundary: owner-question\n')
  return dir
}

function stopTabIn(dir: string, lastBeat: string | null): { code: number, lines: string[] } {
  const lines: string[] = []
  const env = { [HANDOFF_DIR_VARIABLE]: dir, CLAUDE_CODE_SESSION_ID: 's-window', [WINDOW_VARIABLE]: TAB_MODE }
  const code = runTurnWatch({ ...realTurnWatchDeps(env, tmpdir()), lastBeat: () => lastBeat, ownCard: () => null, now: () => NOW, err: line => lines.push(line) })
  return { code, lines }
}

function stopTabHeld(lastBeat: string | null): { code: number, lines: string[] } {
  const dir = ownerQuestionHandoff()
  const store = OnceStore.open(path.join(dir, ONCE_STORE), { file: path.join(dir, 'legacy.json'), text: undefined }, () => ({ offset: 0, busId: 0 }))
  try {
    return stopTabIn(dir, lastBeat)
  }
  finally {
    store.close()
  }
}

function stopIn(mode: WindowMode, lastBeat: string | null, running = true): { code: number, lines: string[] } {
  const lines: string[] = []
  const owner: Status = 'OWNER'
  const code = runTurnWatch({ session: 's-window', mode, status: () => owner, lastBeat: () => lastBeat, watchRunning: () => running, ownCard: () => null, now: () => NOW, err: line => lines.push(line) })
  return { code, lines }
}

describe('an owner question is an owner wait, not the end of the window turn', () => {
  it('a window session with an open owner question keeps receiving other cards events', () => {
    const fresh = new Date(NOW - 1000).toISOString()
    expect(stopTabHeld(null)).toEqual({ code: 1, lines: [OWNER_QUESTION_WAITS] })
    expect(stopTabIn(ownerQuestionHandoff(), fresh)).toEqual({ code: 1, lines: [OWNER_QUESTION_WAITS] })
    expect(OWNER_QUESTION_WAITS).toContain('pnpm miko:watch --once in the background')
    expect(OWNER_QUESTION_WAITS).toContain('owner wait on the board')
    expect(stopTabHeld(fresh)).toEqual({ code: 0, lines: [LIVE_WATCH] })
  })

  it('a turn end without a live watch is refused even on an owner question', () => {
    const stale = new Date(NOW - WINDOW_BEAT_MS - 1).toISOString()
    for (const lastBeat of [null, stale]) {
      expect(stopIn('tab', lastBeat)).toEqual({ code: 1, lines: [OWNER_QUESTION_WAITS] })
      expect(stopIn('loop', lastBeat)).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
    }
    const fresh = new Date(NOW - WINDOW_BEAT_MS).toISOString()
    expect(stopIn('tab', fresh, false)).toEqual({ code: 1, lines: [OWNER_QUESTION_WAITS] })
    expect(stopIn('loop', fresh, false)).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
    expect(stopIn('tab', fresh)).toEqual({ code: 0, lines: [LIVE_WATCH] })
  })
})
