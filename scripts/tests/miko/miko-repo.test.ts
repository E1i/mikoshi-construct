import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { machineBusPath, repoHome, repoIdOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { PROCESS_HEARTBEAT } from '../../core/events.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { MIKO_HANDOFF_NAME, mikoHandoff } from '../../window/loop.js'
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

function machineEvents(w: World): number {
  const db = openBus(w.machineBus)
  try {
    return (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n
  }
  finally {
    db.close()
  }
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
})
