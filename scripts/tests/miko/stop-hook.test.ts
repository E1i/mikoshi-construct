import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { recordWindowHeartbeat } from '../../bus/window-heartbeat.js'
import { LIVE_WATCH, NO_LIVE_WATCH } from '../../miko/turn-watch.js'
import { WINDOW_MARK, WINDOW_VARIABLE, withoutCard } from '../../ports/session.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'turn-watch.mjs')
const SESSION = 's-stop-hook'
const WINDOW_ENV = { [WINDOW_VARIABLE]: WINDOW_MARK }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stop-hook-'))
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

function stop(bus: string, input: object, env: NodeJS.ProcessEnv = {}): { status: number | null, stdout: string } {
  const run = spawnSync(process.execPath, [HOOK], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ hook_event_name: 'Stop', ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, CONSTRUCT_BUS_DB: bus, CONSTRUCT_CARD: '', [WINDOW_VARIABLE]: '', ...env },
    encoding: 'utf8',
  })
  return { status: run.status, stdout: run.stdout }
}

describe('the Stop hook asks turn-watch whether a window turn may end', () => {
  it('the Stop hook refuses a window turn with no live miko:watch and names the turn-watch reason', () => {
    const run = stop(busFile(), { session_id: SESSION, stop_hook_active: false }, WINDOW_ENV)
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining(NO_LIVE_WATCH) })
  }, 20_000)

  it('the Stop hook lets a window turn end under a live miko:watch', () => {
    const bus = busFile()
    beat(bus, SESSION, Date.now())
    const run = stop(bus, { session_id: SESSION, stop_hook_active: false }, WINDOW_ENV)
    expect(run).toEqual({ status: 0, stdout: '' })
    expect(LIVE_WATCH).toContain('live pnpm miko:watch')
  }, 20_000)

  it('the Stop hook lets a card session end without a watch', () => {
    expect(stop(busFile(), { session_id: SESSION }, { ...WINDOW_ENV, CONSTRUCT_CARD: '1183' })).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets a bus reviewer end without a watch: withoutCard drops the window mark', () => {
    const reviewer = withoutCard({ ...process.env, ...WINDOW_ENV, CONSTRUCT_CARD: '1183' })
    expect(reviewer[WINDOW_VARIABLE]).toBeUndefined()
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: false }, reviewer)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets an ordinary owner session in the repository end without a watch', () => {
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: false })).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook refuses once per stop, not again while Claude continues from its refusal', () => {
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: true }, WINDOW_ENV)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets a turn end whose input names no session', () => {
    expect(stop(busFile(), {}, WINDOW_ENV)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the repository settings run the hook on Stop', () => {
    const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect((settings.hooks.Stop ?? []).some(group => group.hooks.some(hook => hook.command.includes('hooks/turn-watch.mjs')))).toBe(true)
  })
})
