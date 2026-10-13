import type { BusEvent, WatchDeps } from '../../miko/watch.js'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { CARD_CLOSED } from '../../bus/launch-candidates.js'
import { PR_OBSERVED } from '../../bus/operator-work.js'
import { parseWatchArgs, tick, WATCHING, watchState } from '../../miko/watch.js'
import { RELAUNCH_ACTOR, STOP_EVENT } from '../../shift/relaunch.js'
import { waitFor } from '../wait-for.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WATCH = path.join(REPO_ROOT, 'scripts', 'miko', 'watch.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const DEADLINE_MS = 15_000
const QUIET_MS = 1000

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

function fileDeps(file: string, alive: (pid: number) => boolean = () => true, events: BusEvent[] = []): WatchDeps {
  return {
    lastBusId: () => 0,
    busEventsAfter: id => events.filter(event => event.id > id),
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

function writeBusEvent(bus: string, type: string, actor: string, dedupeKey: string, payload: string): string {
  const db = openBus(bus)
  try {
    appendEvent(db, { ts: '2026-10-12T06:00:00.000Z', type, actor, cardId: null, pr: null, head: null, dedupeKey, payload, legacy: false })
  }
  finally {
    db.close()
  }
  return payload
}

function writeStop(bus: string, pid: number): string {
  const payload = JSON.stringify({ event: STOP_EVENT, reason: 'max', ts: '2026-10-12T06:00:00.000Z' })
  return writeBusEvent(bus, STOP_EVENT, `${RELAUNCH_ACTOR}${pid}`, `${STOP_EVENT}:${pid}`, payload)
}

const BUS_EVENT_WAKES: Array<{ name: string, type: string, payload: object, wakes: boolean }> = [
  { name: 'a review.recorded changes verdict', type: REVIEW_RECORDED, payload: { verdict: 'changes', findings: ['x'] }, wakes: true },
  { name: 'a review.recorded pass verdict', type: REVIEW_RECORDED, payload: { verdict: 'pass', findings: [] }, wakes: true },
  { name: 'a pr.observed with a failed check', type: PR_OBSERVED, payload: { ci: 'red', failed_checks: ['vitest 2/2'] }, wakes: true },
  { name: 'a merge.done', type: MERGE_DONE, payload: { commit: '99225d31', rule: 'auto' }, wakes: true },
  { name: 'a card.closed', type: CARD_CLOSED, payload: { verification: 'run' }, wakes: true },
  { name: 'a relaunch-stop', type: STOP_EVENT, payload: { event: STOP_EVENT, reason: 'max' }, wakes: true },
  { name: 'a pr.observed with green CI', type: PR_OBSERVED, payload: { ci: 'green' }, wakes: false },
  { name: 'a pr.observed with pending CI', type: PR_OBSERVED, payload: { ci: 'pending' }, wakes: false },
  { name: 'a chain pulse', type: 'chain.observed', payload: { alive: true }, wakes: false },
  { name: 'a task.enqueued', type: 'task.enqueued', payload: { queue: 'review' }, wakes: false },
]

function startWatch(file: string, args: string[] = [], bus = path.join(path.dirname(file), 'bus.db')): { child: ReturnType<typeof spawn>, stdout: () => string, watching: () => Promise<void> } {
  const child = spawn(TSX, [WATCH, ...args], {
    env: { ...process.env, CONSTRUCT_HANDOFF_DIR: path.dirname(file), CONSTRUCT_BUS_DB: bus },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk
  })
  const watching = (): Promise<void> => waitFor(() => stderr.includes(WATCHING), () => `"${WATCHING}" on stderr (stderr so far: ${JSON.stringify(stderr)})`, DEADLINE_MS)
  return { child, stdout: () => stdout, watching }
}

function append(file: string, event: object): string {
  const line = JSON.stringify(event)
  appendFileSync(file, `${line}\n`)
  return line
}

describe('pnpm miko:watch wakes the foreman on an event and on nothing else', () => {
  it.each(['merge', 'fall', 'relaunch-stop', 'stop', 'STOP'])('wakes on an appended %s line with one line, and never on a line already in the journal', (event) => {
    const file = journal()
    const deps = fileDeps(file)
    const state = watchState(deps, [])
    const line = append(file, { event, task: '709' })
    expect(tick(state, deps)).toEqual([`journal ${line}`])
    expect(tick(state, deps)).toEqual([])
  })

  it('wakes once on each relaunch-stop the bus holds after the watch started, and never on one before it', () => {
    const file = journal()
    const events: BusEvent[] = [{ id: 3, type: STOP_EVENT, payload: '{"event":"relaunch-stop"}' }]
    const deps = { ...fileDeps(file, () => true, events), lastBusId: () => 3 }
    const state = watchState(deps, [])
    expect(tick(state, deps)).toEqual([])
    events.push({ id: 7, type: STOP_EVENT, payload: '{"event":"relaunch-stop","reason":"max"}' })
    expect(tick(state, deps)).toEqual(['bus relaunch-stop {"event":"relaunch-stop","reason":"max"}'])
    expect(tick(state, deps)).toEqual([])
  })

  it.each(BUS_EVENT_WAKES)('$name in the bus wakes the window: $wakes', ({ type, payload, wakes }) => {
    const file = journal()
    const events: BusEvent[] = []
    const deps = fileDeps(file, () => true, events)
    const state = watchState(deps, [])
    const text = JSON.stringify(payload)
    events.push({ id: 1, type, payload: text })
    expect(tick(state, deps)).toEqual(wakes ? [`bus ${type} ${text}`] : [])
    expect(tick(state, deps)).toEqual([])
  })

  it('the second event is written only after the watcher says it is watching', async () => {
    const file = journal()
    append(file, { event: 'fall', task: '903' })
    const watch = startWatch(file)
    try {
      await watch.watching()
      const second = append(file, { event: 'merge', task: '904' })
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the second event, written after the watcher said it is watching', DEADLINE_MS)
      await new Promise(resolve => setTimeout(resolve, QUIET_MS))
      expect(watch.stdout()).toBe(`journal ${second}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('a relaunch-stop written to the bus wakes miko', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const watch = startWatch(file, [], bus)
    try {
      await watch.watching()
      const payload = writeStop(bus, 2)
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the relaunch-stop', DEADLINE_MS)
      await new Promise(resolve => setTimeout(resolve, QUIET_MS))
      expect(watch.stdout()).toBe(`bus ${STOP_EVENT} ${payload}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('a review.recorded written to the bus wakes miko, and a pr.observed with green CI before it does not', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const watch = startWatch(file, [], bus)
    try {
      await watch.watching()
      writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:green', JSON.stringify({ ci: 'green' }))
      const payload = writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:changes', JSON.stringify({ verdict: 'changes' }))
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the review.recorded', DEADLINE_MS)
      await new Promise(resolve => setTimeout(resolve, QUIET_MS))
      expect(watch.stdout()).toBe(`bus ${REVIEW_RECORDED} ${payload}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

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
    const line = JSON.stringify({ event: 'fall', task: '7' })
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
    const watch = startWatch(file, ['--pid', String(sleeper.pid), String(process.pid)])
    try {
      await watch.watching()
      append(file, { event: 'path', task: '709' })
      const merge = append(file, { event: 'merge', task: '709' })
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the merge', DEADLINE_MS)
      sleeper.kill()
      await sleeperGone
      await waitFor(() => watch.stdout().split('\n').length > 2, () => `the line for the exit of pid ${sleeper.pid}`, DEADLINE_MS)
      await new Promise(resolve => setTimeout(resolve, QUIET_MS))
      expect(watch.stdout()).toBe(`journal ${merge}\npid ${sleeper.pid} exited\n`)
    }
    finally {
      watch.child.kill()
      sleeper.kill()
    }
  }, 20_000)
})
