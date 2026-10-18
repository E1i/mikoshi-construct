import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, watch } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { GHOST_ROW } from '../../bus/card-automaton.js'
import { BUS_DB_VARIABLE } from '../../bus/db.js'
import { openDatabase } from '../../bus/sqlite.js'
import { ghostRowState } from '../../ghosts/status.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const TSX_LOADER = 'tsx'
const ROW_APPEARS_MS = 20_000
const FREE_ROW_MS = 30_000
const IDS = ['g1', 'g2']

const WINDOW_SCRIPT = `
const { spawn } = require('node:child_process')
const { openSync, writeFileSync } = require('node:fs')
const [tsx, launch, tasks, outPath, pidPath] = process.argv.slice(1)
const out = openSync(outPath, 'w')
const launcher = spawn(process.execPath, ['--import', tsx, launch, '--tasks', tasks], { stdio: ['pipe', out, out] })
writeFileSync(pidPath, String(launcher.pid))
launcher.stdin.end('yes\\n')
`

const created: string[] = []
const windows: ChildProcess[] = []
const survivors: number[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  if (args[0] === 'new')
    created.push(result.stdout.trim())
  return result.stdout.trim()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

const NOTHING_LEFT_TO_SIGNAL = new Set(['ESRCH', 'EPERM'])

function killGroupUnlessNothingLeftToSignal(leader: number, kill: typeof process.kill = process.kill): void {
  try {
    kill(-leader, 'SIGKILL')
  }
  catch (error) {
    if (!NOTHING_LEFT_TO_SIGNAL.has((error as NodeJS.ErrnoException).code ?? ''))
      throw error
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

afterEach(() => {
  while (windows.length > 0) {
    const window = windows.pop()!
    if (!hasExited(window))
      process.kill(-window.pid!, 'SIGKILL')
  }
  while (survivors.length > 0)
    killGroupUnlessNothingLeftToSignal(survivors.pop()!)
  while (created.length > 0)
    world('clean', created.pop()!)
})

function statusOf(w: string): string {
  const busPath = path.join(w, 'bus.db')
  if (!existsSync(busPath))
    return ''
  const db = openDatabase(busPath, { readOnly: true })
  try {
    const events = db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(GHOST_ROW) as { payload: string }[]
    const latest = new Map(events.map((event) => {
      const payload = JSON.parse(event.payload) as { id: string, row: string }
      return [payload.id, payload.row]
    }))
    return [...latest.values()].join('\n')
  }
  catch {
    return ''
  }
  finally {
    db.close()
  }
}

function allInState(w: string, state: string): boolean {
  const text = statusOf(w)
  return IDS.every(id => ghostRowState(text, id) === state)
}

function waitFor(condition: () => boolean, directory: string, guardMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const watcher = watch(directory, { signal: AbortSignal.timeout(guardMs) })
    const closeWhenMet = (): void => {
      if (condition())
        watcher.close()
    }
    watcher.on('change', closeWhenMet)
    watcher.on('error', () => watcher.close())
    watcher.on('close', () => resolve(condition()))
    closeWhenMet()
  })
}

function supervisorPidsOf(statusText: string): number[] {
  return IDS.flatMap((id) => {
    const row = statusText.split('\n').find(line => line.startsWith(`| ghost-${id} |`)) ?? ''
    const match = /, supervisor (\d+), session \S+ \|/.exec(row)
    return match === null ? [] : [Number(match[1])]
  })
}

function journalTasks(w: string): string[] {
  const journal = path.join(w, 'handoff', 'ghosts.jsonl')
  if (!existsSync(journal))
    return []
  return readFileSync(journal, 'utf8').split('\n').filter(line => line !== '').flatMap((line) => {
    const entry = JSON.parse(line) as { event?: unknown, task?: unknown }
    return entry.event === 'task' && typeof entry.task === 'string' ? [entry.task] : []
  })
}

function killFailingWith(code: string): typeof process.kill {
  return () => {
    throw Object.assign(new Error(`kill ${code}`), { code })
  }
}

describe('the survivors cleanup', () => {
  it('signals the whole group of the survivor', () => {
    const calls: unknown[][] = []
    killGroupUnlessNothingLeftToSignal(4242, ((...args: unknown[]) => calls.push(args) > 0) as typeof process.kill)
    expect(calls).toEqual([[-4242, 'SIGKILL']])
  })

  it.each(['ESRCH', 'EPERM'])('treats %s as a group with nothing left to signal', (code) => {
    expect(() => killGroupUnlessNothingLeftToSignal(4242, killFailingWith(code))).not.toThrow()
  })

  it('throws any other kill error', () => {
    expect(() => killGroupUnlessNothingLeftToSignal(4242, killFailingWith('EINVAL'))).toThrow('kill EINVAL')
  })
})

describe('ghosts:launch outlives the window that started it', () => {
  it.each(['SIGHUP', 'SIGKILL'] as const)('w1: after %s to the window process group, the supervisor writes the free rows and the journal task lines', async (signal) => {
    const w = world('new', 'slow')
    const pidPath = path.join(w, '.world', 'launcher.pid')
    const window = spawn(process.execPath, ['-e', WINDOW_SCRIPT, TSX_LOADER, LAUNCH, path.join(w, 'tasks.json'), path.join(w, 'launch.out'), pidPath], {
      detached: true,
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}`, [BUS_DB_VARIABLE]: path.join(w, 'bus.db') },
    })
    const windowPgid = window.pid!
    windows.push(window)
    const windowExited = once(window, 'exit')
    const handoff = path.join(w, 'handoff')

    expect(await waitFor(() => allInState(w, 'writing'), w, ROW_APPEARS_MS), statusOf(w)).toBe(true)
    const supervisors = [...new Set(supervisorPidsOf(statusOf(w)))]
    survivors.push(...supervisors)
    const launcherPid = Number(readFileSync(pidPath, 'utf8'))

    process.kill(-windowPgid, signal)
    const aliveAfterKill = supervisors.map(isAlive)
    await windowExited

    expect(await waitFor(() => allInState(w, 'free'), w, FREE_ROW_MS), statusOf(w)).toBe(true)
    expect(await waitFor(() => journalTasks(w).length === IDS.length, handoff, FREE_ROW_MS)).toBe(true)
    expect(journalTasks(w).sort()).toEqual(IDS)
    expect(supervisors).toHaveLength(1)
    expect(supervisors[0]).not.toBe(launcherPid)
    expect(supervisors[0]).not.toBe(windowPgid)
    expect(aliveAfterKill).toEqual([true])
  }, 70_000)
})
