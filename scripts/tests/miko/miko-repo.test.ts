import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_FILE, constructHome, isOwnerCheckout, machineBusPath, OWNER_AGENT_FILE, repoHome, repoIdOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { PROCESS_HEARTBEAT, WINDOW_REQUEST } from '../../core/events.js'
import { HANDOFF_DIR, HANDOFF_DIR_VARIABLE, handoffDirOf } from '../../core/handoff-dir.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { compactContextOf } from '../../window/compact-start.js'
import { CONTINUE_PROMPT, continuePrompt, MIKO_HANDOFF_NAME, mikoHandoff, PACKAGE_COMMANDS } from '../../window/loop.js'
import { LOOP_SCRIPT_NAME, mikoRoute } from '../../window/miko.js'
import { ONCE_STORE } from '../../window/watch-store.js'

const MIKO = fileURLToPath(new URL('../../window/miko.ts', import.meta.url))
const TSX_LOADER = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
const DECISIONS = fileURLToPath(import.meta.url)
const FOREIGN_REMOTE = 'git@github.com:someone/foreign.git'
const WATCHING_DEADLINE_MS = 15_000
const STUB_CLAUDE = '#!/bin/sh\nprintf \'%s\' "$1" > "$STUB_DIR/prompt"\nexit 0\n'

interface World {
  home: string
  repo: string
  own: string
  machineBus: string
}

const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function world(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'miko-repo-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', FOREIGN_REMOTE])
  const machineBus = machineBusPath(home)
  mkdirSync(path.dirname(machineBus), { recursive: true })
  const db = openBus(machineBus)
  appendEvent(db, { ts: new Date().toISOString(), type: PROCESS_HEARTBEAT, actor: 'worker:world:1', cardId: null, pr: null, head: null, dedupeKey: 'world', payload: {}, legacy: false })
  db.close()
  writeFileSync(path.join(home, 'claude'), STUB_CLAUDE, { mode: 0o755 })
  return { home, repo, own: repoHome(home, repoIdOf(repo)), machineBus }
}

function envOf(w: World): NodeJS.ProcessEnv {
  const { CONSTRUCT_BUS_DB: _bus, CONSTRUCT_HANDOFF: _handoff, CONSTRUCT_HANDOFF_DIR: _dir, CONSTRUCT_CARD: _card, MIKO_LOOP_PID: _loop, MIKO_EXIT_REQUEST: _request, MIKO_WINDOW: _window, CLAUDE_PROJECT_DIR: _project, ...env } = process.env
  return { ...env, HOME: w.home, STUB_DIR: w.home, MIKO_CLAUDE: path.join(w.home, 'claude'), NODE_NO_WARNINGS: '1' }
}

function miko(w: World, args: string[]): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync(process.execPath, ['--import', TSX_LOADER, MIKO, ...args], { cwd: w.repo, env: envOf(w), encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function eventsOf(bus: string, type?: string): number {
  const db = openBus(bus)
  try {
    const row = type === undefined ? db.prepare('SELECT count(*) AS n FROM events').get() : db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type)
    return (row as { n: number }).n
  }
  finally {
    db.close()
  }
}

function machineEvents(w: World): number {
  return eventsOf(w.machineBus)
}

function draft(): string {
  const values = Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`]))
  return `# Handoff\n\nrole: window\nsession: 1\n${Object.entries({ ...values, 'queue': 'none', 'in-flight': 'none', 'next task': '#1 brief', 'owner waits': 'none' }).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function watchUntilWatching(w: World): Promise<string> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, MIKO, 'watch', '--once'], { cwd: w.repo, env: envOf(w), stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  groups.push(child.pid!)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, WATCHING_DEADLINE_MS, stderr)
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.includes('watching')) {
        clearTimeout(deadline)
        resolve(stderr)
      }
    })
    child.on('close', () => {
      clearTimeout(deadline)
      resolve(stderr)
    })
  })
}

describe('miko runs the window of the repository it is started in', () => {
  it('miko handoff write writes the handoff under the repository\'s own construct home', () => {
    const w = world()
    const handoff = mikoHandoff(path.join(w.own, 'handoff'))
    mkdirSync(path.dirname(handoff), { recursive: true })
    const file = path.join(w.home, 'draft.md')
    writeFileSync(file, draft())
    const run = miko(w, ['handoff', 'write', handoff, file])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('STATUS: CONTINUE')
    expect(existsSync(mikoHandoff(path.join(w.home, '.construct', 'handoff')))).toBe(false)
  }, 30_000)

  it('miko watch --once opens the repository\'s own bus and never the machine bus', async () => {
    const w = world()
    const before = machineEvents(w)
    const stderr = await watchUntilWatching(w)
    expect(stderr).toContain('bus id 0')
    expect(existsSync(path.join(w.own, 'handoff', ONCE_STORE))).toBe(true)
    expect(existsSync(path.join(w.home, '.construct', 'handoff', ONCE_STORE))).toBe(false)
    expect(machineEvents(w)).toBe(before)
  }, 30_000)

  it('the continue prompt of a foreign repository names its own handoff and no pnpm command', () => {
    const w = world()
    const handoff = mikoHandoff(path.join(w.own, 'handoff'))
    mkdirSync(path.dirname(handoff), { recursive: true })
    writeFileSync(handoff, 'STATUS: CONTINUE\n')
    const before = machineEvents(w)
    const run = miko(w, [])
    expect(run.status).toBe(0)
    const prompt = readFileSync(path.join(w.home, 'prompt'), 'utf8')
    expect(prompt).toContain(`прочитай ${handoff};`)
    expect(prompt).not.toContain('pnpm ')
    expect(prompt).not.toContain(`~/.construct/handoff/${MIKO_HANDOFF_NAME}`)
    expect(prompt).not.toContain(mikoHandoff(path.join(w.home, '.construct', 'handoff')))
    expect(machineEvents(w)).toBe(before)
  }, 30_000)

  it('miko request writes its window request into the repository\'s own bus and never the machine bus', () => {
    const w = world()
    const before = machineEvents(w)
    const run = miko(w, ['request', 'mode', '--set', 'window'])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(eventsOf(path.join(w.own, BUS_FILE), WINDOW_REQUEST)).toBe(1)
    expect(machineEvents(w)).toBe(before)
  }, 30_000)

  it('miko handoff check reads the handoff miko handoff write wrote under the repository\'s own construct home', () => {
    const w = world()
    const handoff = mikoHandoff(path.join(w.own, 'handoff'))
    mkdirSync(path.dirname(handoff), { recursive: true })
    const file = path.join(w.home, 'draft.md')
    writeFileSync(file, draft())
    expect(miko(w, ['handoff', 'write', handoff, file]).status).toBe(0)
    const run = miko(w, ['handoff', 'check', handoff])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  }, 30_000)

  it('miko exit runs the window exit, refuses with no handoff of the repository and leaves the machine bus untouched', () => {
    const w = world()
    const before = machineEvents(w)
    const run = miko(w, ['exit'])
    expect(run.stderr).not.toContain('Unknown command')
    expect(run.stderr).toContain(`${MIKO_HANDOFF_NAME} does not exist`)
    expect(run.stderr).toContain('nothing ended')
    expect(run.status).toBe(1)
    expect(machineEvents(w)).toBe(before)
  }, 30_000)

  it('a compacted tab window of a foreign repository is handed that repository\'s continue prompt', () => {
    const w = world()
    const handoffDir = path.join(w.own, HANDOFF_DIR)
    const env = { CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: handoffDir }
    const handoff = mikoHandoff(handoffDir)
    const context = compactContextOf('compact', env, file => file === handoff, w.repo)
    expect(context).toBe(continuePrompt(handoff, PACKAGE_COMMANDS))
    expect(context).not.toBe(CONTINUE_PROMPT)
    expect(context).not.toContain('pnpm ')
  })
})

describe('the miko entry and the repository context it reads', () => {
  const source = path.join('/pkg', 'scripts', 'window', 'miko.ts')
  const built = path.join('/pkg', 'dist', 'scripts', 'window', 'miko.js')

  it('routes no arguments to the loop and the window words to their scripts, beside the entry', () => {
    expect(mikoRoute([], source)).toEqual({ script: path.join('/pkg', 'scripts', 'window', `${LOOP_SCRIPT_NAME}.ts`), args: [] })
    expect(mikoRoute(['handoff', 'write', 'a', 'b'], source)).toEqual({ script: path.join('/pkg', 'scripts', 'window', 'handoff-write.ts'), args: ['a', 'b'] })
    expect(mikoRoute(['handoff', 'check', 'a'], built)).toEqual({ script: path.join('/pkg', 'dist', 'scripts', 'window', 'handoff-check.js'), args: ['a'] })
    expect(mikoRoute(['request', 'mode'], source)).toEqual({ script: path.join('/pkg', 'scripts', 'window', 'window-requests.ts'), args: ['mode'] })
    expect(mikoRoute(['watch', '--once'], built)).toEqual({ script: path.join('/pkg', 'dist', 'scripts', 'window', 'watch.js'), args: ['--once'] })
    expect(mikoRoute(['exit'], source)).toEqual({ script: path.join('/pkg', 'scripts', 'window', 'exit.ts'), args: [] })
  })

  it('hands every other word to the product CLI, from source beside a .ts entry and built beside a .js one', () => {
    expect(mikoRoute(['doctor', '--json'], source)).toEqual({ script: path.join('/pkg', 'src', 'cli.ts'), args: ['doctor', '--json'] })
    expect(mikoRoute(['handoff'], built)).toEqual({ script: path.join('/pkg', 'dist', 'cli.js'), args: ['handoff'] })
  })

  it('is the owner checkout only where the owner launchd agent file is in the repository', () => {
    const w = world()
    expect(isOwnerCheckout(w.repo)).toBe(false)
    mkdirSync(path.dirname(path.join(w.repo, OWNER_AGENT_FILE)), { recursive: true })
    writeFileSync(path.join(w.repo, OWNER_AGENT_FILE), '')
    expect(isOwnerCheckout(w.repo)).toBe(true)
    expect(handoffDirOf({}, w.home, w.repo)).toBe(path.join(constructHome(w.home), HANDOFF_DIR))
  })

  it('an empty CONSTRUCT_HANDOFF_DIR names no directory, so the handoff stays under the repository\'s own home', () => {
    const w = world()
    expect(handoffDirOf({ [HANDOFF_DIR_VARIABLE]: '' }, w.home, w.repo)).toBe(path.join(w.own, HANDOFF_DIR))
    expect(handoffDirOf({ [HANDOFF_DIR_VARIABLE]: '/named' }, w.home, w.repo)).toBe('/named')
  })
})
