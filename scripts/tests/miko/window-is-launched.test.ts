import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { WINDOW_HEARTBEAT } from '../../core/events.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, sessionEnv, WINDOW_MARK, WINDOW_VARIABLE, windowModeOf, withoutCard } from '../../ports/session.js'
import { CLAUDE_VARIABLE, TAB_WORD as LOOP_TAB_WORD, MIKO_HANDOFF_NAME, TAB_MODE } from '../../window/loop.js'
import { LOOP_SCRIPT_NAME, mikoHelp, mikoRoute, TAB_WORD } from '../../window/miko.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT, misaddressedPromptRefusal, NO_WINDOW, noWindowRefusal, PROMPT_REFUSED_EXIT, tabWindowOf } from '../../window/tab.js'
import { windowBeat, windowOf } from '../../window/window-heartbeat.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WINDOW_DIR = path.join(REPO_ROOT, 'scripts', 'window')
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const SESSION = 's-launched'
const FOREIGN_REMOTE = 'git@github.com:acme/other-factory.git'
const FOREIGN_ID = 'acme--other-factory'
const BARE = { CLAUDE_CODE_SESSION_ID: SESSION, [ENTRYPOINT_VARIABLE]: 'cli' }
const TAB = { ...BARE, [WINDOW_VARIABLE]: TAB_MODE }
const LOOP = { ...BARE, [WINDOW_VARIABLE]: WINDOW_MARK }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'window-launched-')))
  roots.push(dir)
  return dir
}

function foreignRepository(): string {
  const repo = scratch()
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', FOREIGN_REMOTE])
  return repo
}

function cleanSessionEnv(dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, HOME: dir, NODE_NO_WARNINGS: '1', CONSTRUCT_HANDOFF_DIR: dir, CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), CONSTRUCT_BUS_RAISED: '', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...env }
}

function script(name: string, args: readonly string[], dir: string, env: NodeJS.ProcessEnv, input = ''): { status: number | null, stderr: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(WINDOW_DIR, `${name}.ts`), ...args], { cwd: REPO_ROOT, env: cleanSessionEnv(dir, env), input, encoding: 'utf8', timeout: 25_000 })
  return { status: run.status, stderr: run.stderr }
}

function heartbeats(bus: string): number {
  const db = openBus(bus)
  try {
    return (db.prepare('SELECT count(*) AS beats FROM events WHERE type = ?').get(WINDOW_HEARTBEAT) as { beats: number }).beats
  }
  finally {
    db.close()
  }
}

describe('a window is what miko started, not what a hook read', () => {
  it('a session miko did not start writes no window heartbeat and no handoff', () => {
    const dir = scratch()
    const bus = path.join(dir, 'bus.db')
    const draft = path.join(dir, 'draft.md')
    const handoff = path.join(dir, MIKO_HANDOFF_NAME)
    writeFileSync(draft, '# Handoff\n\nSTATUS: CONTINUE\n')

    expect(windowOf(BARE)).toBeNull()
    expect(tabWindowOf(BARE)).toBeNull()
    windowBeat(bus, windowOf(BARE), Date.now, () => ({}), () => {})()
    expect(heartbeats(bus)).toBe(0)
    windowBeat(bus, windowOf(TAB), Date.now, () => ({}), () => {})()
    expect(heartbeats(bus)).toBe(1)

    const write = script('handoff-write', [handoff, draft], dir, BARE)
    expect(write.status).toBe(1)
    expect(write.stderr).toContain(NO_WINDOW)
    expect(existsSync(handoff)).toBe(false)

    const watch = script('watch', ['--once'], dir, BARE)
    expect(watch.status).toBe(1)
    expect(watch.stderr).toContain(NO_WINDOW)
    expect(heartbeats(bus)).toBe(1)

    const help = script('watch', ['--help'], dir, BARE)
    expect(help.status).toBe(2)
    expect(help.stderr).toContain('usage:')
    expect(help.stderr).not.toContain(NO_WINDOW)
  }, 60_000)

  it('a session the launcher marked, a loop session and a card session are not told they are no window', () => {
    expect(noWindowRefusal(TAB)).toBeNull()
    expect(noWindowRefusal(LOOP)).toBeNull()
    expect(noWindowRefusal({ ...BARE, [CARD_VARIABLE]: '1669' })).toBeNull()
    expect(noWindowRefusal({ ...BARE, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT })).toBeNull()
    expect(noWindowRefusal({ ...BARE, CONSTRUCT_BUS_RAISED: '1' })).toBeNull()
    expect(noWindowRefusal({})).toBeNull()
    expect(noWindowRefusal(BARE)).toBe(NO_WINDOW)
  })

  it('the mark is the launcher\'s: a card or a bus session started from a tab window does not inherit it', () => {
    expect(windowModeOf(TAB)).toBe('tab')
    expect(windowModeOf(BARE)).toBeNull()
    expect(windowModeOf({ ...TAB, [CARD_VARIABLE]: '1669' })).toBeNull()
    expect(withoutCard(TAB)[WINDOW_VARIABLE]).toBeUndefined()
    expect(sessionEnv(TAB)[WINDOW_VARIABLE]).toBeUndefined()
  })

  it('pnpm miko --tab starts one session with the launcher\'s mark and no loop mark', () => {
    const dir = scratch()
    const seen = path.join(dir, 'seen')
    const stub = path.join(dir, 'claude-stub')
    writeFileSync(stub, `#!/bin/sh\nprintf '%s|%s|%s' "$${WINDOW_VARIABLE}" "$${LOOP_PID_VARIABLE}" "$*" > ${seen}\n`)
    chmodSync(stub, 0o755)

    const run = script('miko', [TAB_WORD, '--name', 'x'], dir, { [CLAUDE_VARIABLE]: stub, [LOOP_PID_VARIABLE]: '4242', [EXIT_REQUEST_VARIABLE]: '/h/miko-exit.4242.request' })

    expect(run.status).toBe(0)
    expect(readFileSync(seen, 'utf8')).toBe(`${TAB_MODE}||--name x`)
  }, 30_000)

  it('the tab word routes to the loop script and is listed by the help', () => {
    expect(LOOP_TAB_WORD).toBe(TAB_WORD)
    expect(mikoRoute([TAB_WORD], '/x/scripts/window/miko.ts')).toEqual({ script: path.join('/x/scripts/window', `${LOOP_SCRIPT_NAME}.ts`), args: [TAB_WORD] })
    expect(mikoHelp()).toContain(`miko ${TAB_WORD}`)
  })
})

describe('a prompt reaches only the window of its factory', () => {
  const ownerHandoff = '~/.construct/handoff/miko.md'
  const foreignHandoff = `/Users/someone/.construct/${FOREIGN_ID}/handoff/miko.md`

  it('a prompt addressed to another factory is refused naming the right window', () => {
    const dir = scratch()
    const repo = foreignRepository()

    const toOwner = script('tab', [], dir, LOOP, `прочитай ${ownerHandoff}; продолжай`)
    expect(toOwner.status).toBe(0)

    const inForeign = spawnSync(process.execPath, ['--import', TSX_LOADER, path.join(WINDOW_DIR, 'tab.ts')], { cwd: repo, env: cleanSessionEnv(dir, LOOP), input: `прочитай ${ownerHandoff}; продолжай`, encoding: 'utf8', timeout: 25_000 })
    expect(inForeign.status).toBe(PROMPT_REFUSED_EXIT)
    expect(inForeign.stderr).toContain('addressed to the window of the owner checkout')
    expect(inForeign.stderr).toContain('started in that repository with miko')

    expect(misaddressedPromptRefusal(`прочитай ${foreignHandoff}; продолжай`, LOOP, REPO_ROOT)).toContain('addressed to the window of acme/other-factory')
    expect(misaddressedPromptRefusal(`прочитай ${foreignHandoff}; продолжай`, TAB, REPO_ROOT)).toContain('started in that repository with miko')
  }, 60_000)

  it('the window\'s own prompt, a prompt naming no handoff and a mention below the first line go through', () => {
    const repo = foreignRepository()
    expect(misaddressedPromptRefusal(`прочитай ${foreignHandoff}; продолжай`, LOOP, repo)).toBeNull()
    expect(misaddressedPromptRefusal('почини тест', LOOP, repo)).toBeNull()
    expect(misaddressedPromptRefusal(`сравни\n${ownerHandoff}`, LOOP, repo)).toBeNull()
  })

  it('a card session and a headless session are not held to a factory address', () => {
    const repo = foreignRepository()
    expect(misaddressedPromptRefusal(ownerHandoff, { ...BARE, [CARD_VARIABLE]: '1669' }, repo)).toBeNull()
    expect(misaddressedPromptRefusal(ownerHandoff, { ...BARE, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }, repo)).toBeNull()
    expect(misaddressedPromptRefusal(ownerHandoff, BARE, repo)).toContain('the owner checkout')
  })
})
