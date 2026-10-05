import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ghostRowState } from '../../ghosts/status.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const ROW_APPEARS_MS = 20_000
const FREE_ROW_MS = 30_000
const POLL_MS = 100
const IDS = ['g1', 'g2']

const WINDOW_SCRIPT = `
const { spawn } = require('node:child_process')
const { openSync, writeFileSync } = require('node:fs')
const [tsx, launch, tasks, outPath, pidPath] = process.argv.slice(1)
const out = openSync(outPath, 'w')
const launcher = spawn(process.execPath, [tsx, launch, '--tasks', tasks], { stdio: ['pipe', out, out] })
writeFileSync(pidPath, String(launcher.pid))
launcher.stdin.end('yes\\n')
`

const created: string[] = []
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

afterEach(() => {
  while (survivors.length > 0) {
    const pid = survivors.pop()!
    if (isAlive(pid))
      process.kill(-pid, 'SIGKILL')
  }
  while (created.length > 0)
    world('clean', created.pop()!)
})

function statusOf(w: string): string {
  return readFileSync(path.join(w, 'handoff', 'status.md'), 'utf8')
}

function allInState(w: string, state: string): boolean {
  const text = statusOf(w)
  return IDS.every(id => ghostRowState(text, id) === state)
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition())
      return true
    await sleep(POLL_MS)
  }
  return condition()
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

describe('ghosts:launch outlives the window that started it', () => {
  it('w1: after SIGKILL of the window process group, the supervisor writes the free rows and the journal task lines', async () => {
    const w = world('new', 'slow')
    const pidPath = path.join(w, '.world', 'launcher.pid')
    const window = spawn(process.execPath, ['-e', WINDOW_SCRIPT, TSX, LAUNCH, path.join(w, 'tasks.json'), path.join(w, 'launch.out'), pidPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}` },
    })
    const windowPgid = window.pid!
    survivors.push(windowPgid)

    expect(await waitFor(() => allInState(w, 'writing'), ROW_APPEARS_MS), statusOf(w)).toBe(true)
    const supervisors = [...new Set(supervisorPidsOf(statusOf(w)))]
    survivors.push(...supervisors)
    const launcherPid = Number(readFileSync(pidPath, 'utf8'))

    process.kill(-windowPgid, 'SIGKILL')
    const aliveAfterKill = supervisors.map(isAlive)

    expect(await waitFor(() => allInState(w, 'free'), FREE_ROW_MS), statusOf(w)).toBe(true)
    expect(await waitFor(() => journalTasks(w).length === IDS.length, FREE_ROW_MS)).toBe(true)
    expect(journalTasks(w).sort()).toEqual(IDS)
    expect(supervisors).toHaveLength(1)
    expect(supervisors[0]).not.toBe(launcherPid)
    expect(supervisors[0]).not.toBe(windowPgid)
    expect(aliveAfterKill).toEqual([true])
  }, 70_000)
})
