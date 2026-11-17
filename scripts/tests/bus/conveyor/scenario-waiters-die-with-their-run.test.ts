import type { ChildProcess } from 'node:child_process'
import type { Exit } from './scenario-processes.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from '../../wait-for.js'
import { scenarioProcesses, SPAWNER_VARIABLE, WAITER_ORPHANED, WAITER_OUT_OF_TIME, WAITER_POLL_S, waiterScript } from './scenario-processes.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const HELPER = path.join(import.meta.dirname, 'scenario-processes.ts')
const READY_MS = 20_000
const ONE_POLL_AND_A_MARGIN_MS = WAITER_POLL_S * 1000 + 2_000
const NESTED_SPAWNER = `require('node:child_process').spawn('sh', ['-c', process.argv[1], process.argv[2]], { stdio: 'ignore' }); setInterval(() => {}, 1000)`

const RUN = `
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { scenarioProcesses, waiterScript } from '${HELPER}'

const [out, never] = process.argv.slice(2)
const group = scenarioProcesses.open()
const waiters = [
  await group.spawn('sh', ['-c', waiterScript('exit 0'), never]),
  await group.spawn('sh', ['-c', waiterScript('exit 0'), never]),
  await group.spawn(process.execPath, ['-e', ${JSON.stringify(NESTED_SPAWNER)}, waiterScript('exit 0'), never]),
]
writeFileSync(out, JSON.stringify({ pgid: group.pgid, pids: waiters.map(waiter => waiter.pid) }))
setInterval(() => {}, 1000)
`

interface Started {
  pgid: number
  pids: number[]
}

const roots: string[] = []
const runs: ChildProcess[] = []
const groups: number[] = []

afterEach(() => {
  for (const run of runs.splice(0))
    run.kill('SIGKILL')
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {}
  }
  scenarioProcesses.killAll()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'scenario-waiters-'))
  roots.push(root)
  return root
}

function signalled(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function survivors(started: Started): number[] {
  return [-started.pgid, ...started.pids].filter(signalled)
}

async function scenarioRun(): Promise<{ run: ChildProcess, exited: Promise<Exit>, started: Started }> {
  const root = scratch()
  const script = path.join(root, 'run.mts')
  const out = path.join(root, 'started.json')
  writeFileSync(script, RUN)
  const run = spawn(process.execPath, ['--import', 'tsx', script, out, path.join(root, 'never-released')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  runs.push(run)
  const exited = new Promise<Exit>(resolve => run.once('exit', (code, signal) => resolve({ code, signal })))
  await waitFor(() => existsSync(out) && readFileSync(out, 'utf8') !== '', () => 'the scenario run to start its waiters', READY_MS)
  const started = JSON.parse(readFileSync(out, 'utf8')) as Started
  groups.push(started.pgid)
  return { run, exited, started }
}

async function waiterExit(script: string, env: NodeJS.ProcessEnv): Promise<Exit> {
  const waiter = spawn('sh', ['-c', script, path.join(scratch(), 'never-released')], { env, stdio: 'ignore' })
  return new Promise<Exit>(resolve => waiter.once('exit', (code, signal) => resolve({ code, signal })))
}

describe('scenario waiters die with their run', () => {
  it('a scenario run killed by SIGKILL leaves no waiter alive', async () => {
    const { run, exited, started } = await scenarioRun()
    expect(survivors(started), 'the group and its waiters run before the kill').toEqual([-started.pgid, ...started.pids])

    run.kill('SIGKILL')
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })

    await waitFor(() => survivors(started).length === 0, () => `the scenario group to empty, still alive: ${survivors(started).join(', ')}`, ONE_POLL_AND_A_MARGIN_MS)
  }, 30_000)

  it('a scenario run interrupted by SIGTERM kills its waiter group', async () => {
    const { run, exited, started } = await scenarioRun()
    expect(survivors(started)).toEqual([-started.pgid, ...started.pids])

    run.kill('SIGTERM')
    expect(await exited, 'the run still ends on the signal it was sent').toEqual({ code: null, signal: 'SIGTERM' })

    await waitFor(() => survivors(started).length === 0, () => `the scenario group to empty, still alive: ${survivors(started).join(', ')}`, ONE_POLL_AND_A_MARGIN_MS)
  }, 30_000)

  it('killing every open group in afterEach ends each group a scenario opened', async () => {
    const group = scenarioProcesses.open()
    const waiter = await group.spawn('sh', ['-c', waiterScript('exit 0'), path.join(scratch(), 'never-released')])
    expect(signalled(-group.pgid)).toBe(true)

    scenarioProcesses.killAll()

    await waitFor(() => !signalled(-group.pgid) && !signalled(waiter.pid), () => 'the killed group to empty', ONE_POLL_AND_A_MARGIN_MS)
  }, 30_000)

  it('a waiter ends by itself past its bound, and at once when its spawner is gone', async () => {
    expect(await waiterExit(waiterScript('exit 0', 0.2), { ...process.env, [SPAWNER_VARIABLE]: String(process.pid) })).toEqual({ code: WAITER_OUT_OF_TIME, signal: null })
    expect(await waiterExit(waiterScript('exit 0'), { ...process.env, [SPAWNER_VARIABLE]: '' })).toEqual({ code: WAITER_ORPHANED, signal: null })
  }, 30_000)

  it('a released waiter runs what follows it, with the scenario spawner in its environment', async () => {
    const group = scenarioProcesses.open()
    const root = scratch()
    const release = path.join(root, 'release')
    const seen = path.join(root, 'spawner')
    writeFileSync(release, '')
    const waiter = await group.spawn('sh', ['-c', waiterScript(`printf %s "$${SPAWNER_VARIABLE}" > "$1"`), release, seen])
    expect(await waiter.exited).toEqual({ code: 0, signal: null })
    expect(readFileSync(seen, 'utf8')).toBe(String(process.pid))
  }, 30_000)
})
