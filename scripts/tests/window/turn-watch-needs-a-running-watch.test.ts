import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { LIVE_WATCH, NO_LIVE_WATCH, realTurnWatchDeps, runTurnWatch } from '../../window/turn-watch.js'
import { ONCE_STORE, OnceStore, ownerFile } from '../../window/watch-store.js'
import { recordWindowHeartbeat } from '../../window/window-heartbeat.js'
import { claudeClient } from '../client/claude-client.js'

const SESSION = 's-window-watch'
const BEAT_AGE_MS = 60_000
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function windowWithFreshBeat(): { handoff: string, env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(tmpdir(), 'turn-watch-running-'))
  roots.push(root)
  const bus = path.join(root, 'bus.db')
  const db = openBus(bus)
  try {
    recordWindowHeartbeat(db, new Date(Date.now() - BEAT_AGE_MS).toISOString(), SESSION)
  }
  finally {
    db.close()
  }
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  const handoff = root
  return { handoff, env: { [HANDOFF_DIR_VARIABLE]: handoff, CLAUDE_CODE_SESSION_ID: SESSION, CONSTRUCT_CARD: '', [WINDOW_VARIABLE]: WINDOW_MARK } }
}

function turnEnd(env: NodeJS.ProcessEnv): { code: number, lines: string[] } {
  const lines: string[] = []
  const code = runTurnWatch({ ...realTurnWatchDeps(claudeClient, env, tmpdir()), err: line => lines.push(line) })
  return { code, lines }
}

function holdCursor(handoff: string): OnceStore {
  return OnceStore.open(path.join(handoff, ONCE_STORE), { file: path.join(handoff, 'legacy.json'), text: undefined }, () => ({ offset: 0, busId: 0 }))
}

describe('a live watch is a miko:watch that holds the --once cursor now, not a recent beat', () => {
  it('a window turn whose last watch exited a minute ago is refused although its heartbeat is fresh', () => {
    const { handoff, env } = windowWithFreshBeat()
    holdCursor(handoff).close()
    expect(existsSync(ownerFile(path.join(handoff, ONCE_STORE)))).toBe(false)
    expect(turnEnd(env)).toEqual({ code: 1, lines: [NO_LIVE_WATCH] })
  })

  it('a window turn passes while a miko:watch --once holds the cursor store', () => {
    const { handoff, env } = windowWithFreshBeat()
    const store = holdCursor(handoff)
    try {
      expect(turnEnd(env)).toEqual({ code: 0, lines: [LIVE_WATCH] })
    }
    finally {
      store.close()
    }
  })
})
