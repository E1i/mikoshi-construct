import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE, withoutCard } from '../../ports/session.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT, tabWindowOf } from '../../window/tab.js'
import { LIVE_WATCH, NO_LIVE_WATCH, TAB_CONTINUE } from '../../window/turn-watch.js'
import { recordWindowHeartbeat, windowSessionOf } from '../../window/window-heartbeat.js'

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

function emptyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stop-hook-root-'))
  roots.push(root)
  return root
}

function handoffEnv(status: string | null): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-hook-handoff-'))
  roots.push(dir)
  if (status !== null)
    writeFileSync(path.join(dir, MIKO_HANDOFF_NAME), `# Handoff\n\nSTATUS: ${status}\n`)
  return { [HANDOFF_DIR_VARIABLE]: dir }
}

const HEADLESS = { [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }

function stopRun(bus: string, input: object, env: NodeJS.ProcessEnv = {}): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync(process.execPath, [HOOK], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ hook_event_name: 'Stop', ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, CONSTRUCT_BUS_DB: bus, CONSTRUCT_CARD: '', [WINDOW_VARIABLE]: '', [ENTRYPOINT_VARIABLE]: 'cli', CONSTRUCT_BUS_RAISED: '', CONSTRUCT_HANDOFF: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...handoffEnv(null), ...env },
    encoding: 'utf8',
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function stop(bus: string, input: object, env: NodeJS.ProcessEnv = {}): { status: number | null, stdout: string } {
  const { status, stdout } = stopRun(bus, input, env)
  return { status, stdout }
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
    const reviewer = withoutCard({ ...process.env, ...WINDOW_ENV, ...HEADLESS, ...handoffEnv('CONTINUE'), CONSTRUCT_CARD: '1183' })
    expect(reviewer[WINDOW_VARIABLE]).toBeUndefined()
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: false }, reviewer)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets an owner tab session with no handoff end without a watch', () => {
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: false })).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook refuses once per stop, not again while Claude continues from its refusal', () => {
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: true }, WINDOW_ENV)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets a turn end whose input names no session', () => {
    expect(stop(busFile(), {}, WINDOW_ENV)).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the Stop hook lets a window turn end when the turn-watch child crashes, and says so on stderr', () => {
    const run = stopRun(busFile(), { session_id: SESSION, stop_hook_active: false }, { ...WINDOW_ENV, CLAUDE_PROJECT_DIR: emptyRoot() })
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: '' })
    expect(run.stderr).toContain('without a turn-watch line; the turn ends')
  }, 20_000)

  it('the Stop hook starts no turn-watch child for a session that is not a window', () => {
    for (const env of [HEADLESS, { CONSTRUCT_BUS_RAISED: '1' }, { ...WINDOW_ENV, CONSTRUCT_CARD: '1183' }])
      expect(stopRun(busFile(), { session_id: SESSION, stop_hook_active: false }, { ...env, CLAUDE_PROJECT_DIR: emptyRoot() })).toEqual({ status: 0, stdout: '', stderr: '' })
  }, 20_000)

  it('the hook marks a window exactly when windowSessionOf or tabWindowOf names one', async () => {
    const { windowMarked } = await import(pathToFileURL(HOOK).href) as { windowMarked: (env: NodeJS.ProcessEnv) => boolean }
    const bases: NodeJS.ProcessEnv[] = [{}, WINDOW_ENV, { [WINDOW_VARIABLE]: '0' }, { ...WINDOW_ENV, CONSTRUCT_CARD: '' }, { ...WINDOW_ENV, CONSTRUCT_CARD: '1183' }, { CONSTRUCT_CARD: '1183' }, { [LOOP_PID_VARIABLE]: '42' }, { [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.1.request' }]
    for (const base of bases) {
      for (const env of [base, { ...base, ...HEADLESS }, { ...base, CONSTRUCT_BUS_RAISED: '1' }, { ...base, [ENTRYPOINT_VARIABLE]: 'cli' }]) {
        const session = { ...env, CLAUDE_CODE_SESSION_ID: SESSION }
        expect(windowMarked(env)).toBe(windowSessionOf(session) !== null || tabWindowOf(session) !== null)
      }
    }
  })

  it('a tab session whose handoff ends STATUS: CONTINUE is blocked at Stop with a reason naming pnpm miko:watch --once', () => {
    const run = stop(busFile(), { session_id: SESSION, stop_hook_active: false }, handoffEnv('CONTINUE'))
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining(TAB_CONTINUE) })
    expect(TAB_CONTINUE).toContain('pnpm miko:watch --once')
  }, 20_000)

  it('a tab session whose handoff ends STATUS: OWNER stops, and so does one ending STATUS: DONE', () => {
    for (const status of ['OWNER', 'DONE']) {
      const run = stopRun(busFile(), { session_id: SESSION, stop_hook_active: false }, handoffEnv(status))
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: '' })
      expect(run.stderr).toBe('')
    }
  }, 30_000)

  it('a tab session blocked once at CONTINUE stops on the next stop while Claude continues from the block', () => {
    expect(stop(busFile(), { session_id: SESSION, stop_hook_active: true }, handoffEnv('CONTINUE'))).toEqual({ status: 0, stdout: '' })
  }, 20_000)

  it('the repository settings run the hook on Stop', () => {
    const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect((settings.hooks.Stop ?? []).some(group => group.hooks.some(hook => hook.command.includes('hooks/turn-watch.mjs')))).toBe(true)
  })
})
