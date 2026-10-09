import type { LockDeps, LockEvent } from '../../quality/lock.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { HELD_VARIABLE, LOCK_DIR_VARIABLE, LOG_FILE, withQualityLock } from '../../quality/lock.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const LOCK = path.join(REPO_ROOT, 'scripts/quality/lock.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const HOLD_UNTIL_THE_OTHER_RUN_WAITS = `
const { readFileSync } = require('node:fs')
const log = () => readFileSync(process.env.${LOCK_DIR_VARIABLE} + '/${LOG_FILE}', 'utf8')
const settled = () => log().includes('"event":"wait"') || log().split('"event":"start"').length > 2
const poll = () => settled() || setTimeout(poll, 20)
poll()
`
const EXIT_AT_ONCE = ''

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quality-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function events(dir: string): LockEvent[] {
  return readFileSync(path.join(dir, LOG_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line) as LockEvent)
}

function lockedRun(dir: string, cwd: string, script: string, env: NodeJS.ProcessEnv = {}): Promise<number | null> {
  const { [HELD_VARIABLE]: _held, ...outsideARun } = process.env
  const child = spawn(process.execPath, [TSX_CLI, LOCK, process.execPath, '-e', script], { cwd, env: { ...outsideARun, [LOCK_DIR_VARIABLE]: dir, ...env }, stdio: 'ignore' })
  return new Promise(resolve => child.on('exit', resolve))
}

function deps(dir: string, over: Partial<LockDeps>): LockDeps {
  return {
    dir,
    pid: 101,
    cwd: '/tree/b',
    now: () => new Date('2026-10-09T12:00:00Z'),
    isAlive: () => true,
    sleep: async () => {},
    say: () => {},
    run: async () => 0,
    ...over,
  }
}

describe('quality lock', () => {
  it('two concurrent quality runs run one after the other', async () => {
    const dir = scratch()
    const [first, second] = [scratch(), scratch()]
    const codes = await Promise.all([lockedRun(dir, first, HOLD_UNTIL_THE_OTHER_RUN_WAITS), lockedRun(dir, second, HOLD_UNTIL_THE_OTHER_RUN_WAITS)])
    expect(codes).toEqual([0, 0])
    const log = events(dir)
    const starts = log.filter(entry => entry.event === 'start')
    const ends = log.filter(entry => entry.event === 'end')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    const [earlier, later] = starts
    expect(log.indexOf(ends.find(entry => entry.pid === earlier!.pid)!)).toBeLessThan(log.indexOf(later!))
    expect(Date.parse(later!.at)).toBeGreaterThanOrEqual(Date.parse(ends.find(entry => entry.pid === earlier!.pid)!.at))
    expect(log.find(entry => entry.event === 'wait')).toMatchObject({ pid: later!.pid, holder: { pid: earlier!.pid } })
    expect(existsSync(path.join(dir, 'held'))).toBe(false)
  })

  it('a run inside a run does not wait on the lock its parent holds', async () => {
    const dir = scratch()
    expect(await lockedRun(dir, scratch(), EXIT_AT_ONCE, { [HELD_VARIABLE]: '1' })).toBe(0)
    expect(existsSync(path.join(dir, LOG_FILE))).toBe(false)
  })

  it('logs who waits on whom, and runs once the holder lets go', async () => {
    const dir = scratch()
    mkdirSync(path.join(dir, 'held'), { recursive: true })
    writeFileSync(path.join(dir, 'held', 'holder.json'), JSON.stringify({ pid: 7, cwd: '/tree/a', at: '2026-10-09T11:59:00.000Z' }))
    const said: string[] = []
    let polls = 0
    const code = await withQualityLock(deps(dir, {
      say: line => said.push(line),
      sleep: async () => {
        polls += 1
        if (polls === 3)
          rmSync(path.join(dir, 'held'), { recursive: true })
      },
      run: async () => 4,
    }))
    expect(code).toBe(4)
    expect(said).toEqual(['[quality-lock] waiting for pid 7 in /tree/a, holding since 2026-10-09T11:59:00.000Z'])
    expect(events(dir).map(entry => entry.event)).toEqual(['wait', 'start', 'end'])
    expect(events(dir).at(-1)).toMatchObject({ pid: 101, cwd: '/tree/b', exitCode: 4 })
  })

  it('takes over a lock whose holder is no longer running, and says so in the log', async () => {
    const dir = scratch()
    mkdirSync(path.join(dir, 'held'), { recursive: true })
    writeFileSync(path.join(dir, 'held', 'holder.json'), JSON.stringify({ pid: 7, cwd: '/tree/a', at: '2026-10-09T11:00:00.000Z' }))
    let slept = false
    const code = await withQualityLock(deps(dir, {
      isAlive: pid => pid !== 7,
      sleep: async () => {
        slept = true
      },
    }))
    expect(code).toBe(0)
    expect(slept).toBe(false)
    expect(events(dir).map(entry => entry.event)).toEqual(['stale', 'start', 'end'])
  })

  it('lets go of the lock when the run throws', async () => {
    const dir = scratch()
    await expect(withQualityLock(deps(dir, { run: async () => {
      throw new Error('boom')
    } }))).rejects.toThrow('boom')
    expect(existsSync(path.join(dir, 'held'))).toBe(false)
    expect(events(dir).at(-1)).toMatchObject({ event: 'end', exitCode: 1 })
  })
})
