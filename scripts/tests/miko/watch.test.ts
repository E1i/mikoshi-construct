import type { WatchDeps } from '../../miko/watch.js'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWatchArgs, tick, watchState } from '../../miko/watch.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WATCH = path.join(REPO_ROOT, 'scripts', 'miko', 'watch.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function journal(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-watch-'))
  roots.push(dir)
  const file = path.join(dir, 'ghosts.jsonl')
  writeFileSync(file, `${JSON.stringify({ event: 'merge', task: '1' })}\n`)
  return file
}

function fileDeps(file: string, alive: (pid: number) => boolean = () => true): WatchDeps {
  return {
    size: () => statSync(file).size,
    readFrom: (offset, end) => {
      const buffer = Buffer.alloc(end - offset)
      const fd = openSync(file, 'r')
      readSync(fd, buffer, 0, end - offset, offset)
      closeSync(fd)
      return buffer.toString('utf8')
    },
    alive,
  }
}

function append(file: string, event: object): string {
  const line = JSON.stringify(event)
  appendFileSync(file, `${line}\n`)
  return line
}

describe('pnpm miko:watch wakes the foreman on an event and on nothing else', () => {
  it.each(['merge', 'failed', 'relaunch-stop', 'stop', 'STOP'])('wakes on an appended %s line with one line, and never on a line already in the journal', (event) => {
    const file = journal()
    const deps = fileDeps(file)
    const state = watchState(deps, [])
    const line = append(file, { event, task: '709' })
    expect(tick(state, deps)).toEqual([`journal ${line}`])
    expect(tick(state, deps)).toEqual([])
  })

  it('wakes on a watched PID that exits with one line, once', () => {
    const file = journal()
    const dead = new Set<number>()
    const deps = fileDeps(file, pid => !dead.has(pid))
    const state = watchState(deps, [41, 42])
    expect(tick(state, deps)).toEqual([])
    dead.add(42)
    expect(tick(state, deps)).toEqual(['pid 42 exited'])
    expect(tick(state, deps)).toEqual([])
  })

  it('wakes on a line only once it is whole, when it arrives in two writes', () => {
    const file = journal()
    const deps = fileDeps(file)
    const state = watchState(deps, [])
    const line = JSON.stringify({ event: 'failed', task: '7' })
    appendFileSync(file, line.slice(0, 10))
    expect(tick(state, deps)).toEqual([])
    appendFileSync(file, `${line.slice(10)}\n`)
    expect(tick(state, deps)).toEqual([`journal ${line}`])
  })

  it('stays silent on journal lines of other events, on lines that are not JSON, and on live PIDs', () => {
    const file = journal()
    const deps = fileDeps(file)
    const state = watchState(deps, [process.pid])
    for (const event of ['path', 'start', 'chain', 'review', 'merge-skip', 'budget-stop'])
      append(file, { event, task: '709' })
    appendFileSync(file, 'not json\n{"task":"709"}\n')
    expect(tick(state, deps)).toEqual([])
  })

  it('reads --pid followed by one or more PIDs, and refuses anything else', () => {
    expect(parseWatchArgs([])).toEqual([])
    expect(parseWatchArgs(['--pid', '12', '13', '--pid', '14'])).toEqual([12, 13, 14])
    expect(parseWatchArgs(['--pid'])).toBeUndefined()
    expect(parseWatchArgs(['12'])).toBeUndefined()
    expect(parseWatchArgs(['--pid', 'x'])).toBeUndefined()
    expect(parseWatchArgs(['--pid', '0'])).toBeUndefined()
  })

  it('wakes on events end to end and stays silent otherwise: the script prints one line per event and nothing else', async () => {
    const file = journal()
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const sleeperGone = new Promise(resolve => sleeper.on('close', resolve))
    const child = spawn(TSX, [WATCH, '--pid', String(sleeper.pid), String(process.pid)], {
      env: { ...process.env, CONSTRUCT_HANDOFF_DIR: path.dirname(file) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    const until = async (condition: () => boolean): Promise<void> => {
      for (let tries = 0; tries < 200 && !condition(); tries++)
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 1500))
      append(file, { event: 'path', task: '709' })
      const merge = append(file, { event: 'merge', task: '709' })
      await until(() => stdout.includes('\n'))
      sleeper.kill()
      await sleeperGone
      await until(() => stdout.split('\n').length > 2)
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(stdout).toBe(`journal ${merge}\npid ${sleeper.pid} exited\n`)
    }
    finally {
      child.kill()
      sleeper.kill()
    }
  }, 20_000)
})
