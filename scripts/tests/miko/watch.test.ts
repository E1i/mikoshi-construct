import type { BusEvent, CardActivity, WatchDeps } from '../../miko/watch.js'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { CARD_STOPPED, POLICY_DENIED } from '../../bus/inbox.js'
import { CARD_CLOSED } from '../../bus/launch-candidates.js'
import { PR_CLOSED, prClosed } from '../../bus/observations.js'
import { PR_OBSERVED } from '../../bus/operator-work.js'
import { REVIEW_ROUNDS_SPENT } from '../../bus/review-executor.js'
import { ANOTHER_CONSUMER, ONCE_STORE, OnceStore } from '../../miko/watch-store.js'
import { BUS_ALIVE_MS, deliverOnce, LEGACY_CURSOR, ONCE, parseWatchArgs, selectOnce, skippedLine, STALL_MS, stalledOf, tick, USER_SETTINGS, WATCHING, WATCHING_FROM_CURSOR, watchState } from '../../miko/watch.js'
import { RELAUNCH_ACTOR, STOP_EVENT } from '../../shift/relaunch.js'
import { waitFor } from '../wait-for.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WATCH = path.join(REPO_ROOT, 'scripts', 'miko', 'watch.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const DEADLINE_MS = 15_000

const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []

async function exitOf(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill()
  await exited
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(exitOf))
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

function fileDeps(file: string, alive: (pid: number) => boolean = () => true, events: BusEvent[] = [], stalls: CardActivity[] = []): WatchDeps {
  return {
    journal: file,
    bus: path.join(path.dirname(file), 'bus.db'),
    observedUpTo: id => [...new Map(events.filter(event => event.type === PR_OBSERVED && event.id <= id).map(event => [event.pr, event])).values()],
    deniedUpTo: id => events.filter(event => event.type === POLICY_DENIED && event.id <= id),
    stalls: () => [...stalls],
    emit: async () => {},
    beforeCommit: async () => {},
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

function writeBusEvent(bus: string, type: string, actor: string, dedupeKey: string, payload: string, pr: number | null = null, head: string | null = null, cardId: number | null = null): string {
  const db = openBus(bus)
  try {
    appendEvent(db, { ts: '2026-10-12T06:00:00.000Z', type, actor, cardId, pr, head, dedupeKey, payload, legacy: false })
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
  { name: 'a pr.closed with a merge', type: PR_CLOSED, payload: { merged: true, commit: 'c0ffee' }, wakes: true },
  { name: 'a card.closed', type: CARD_CLOSED, payload: { verification: 'run' }, wakes: true },
  { name: 'a relaunch-stop', type: STOP_EVENT, payload: { event: STOP_EVENT, reason: 'max' }, wakes: true },
  { name: 'a card.stopped', type: CARD_STOPPED, payload: { reason: 'fault', detail: 'the session died' }, wakes: true },
  { name: 'a first policy.denied of a task', type: POLICY_DENIED, payload: { command: 'record_verdict', kind: 'technical', reason: 'no_isolation' }, wakes: false },
  { name: 'a pr.observed with green CI', type: PR_OBSERVED, payload: { ci: 'green' }, wakes: false },
  { name: 'a pr.observed with pending CI', type: PR_OBSERVED, payload: { ci: 'pending' }, wakes: false },
  { name: 'a chain pulse', type: 'chain.observed', payload: { alive: true }, wakes: false },
  { name: 'a task.enqueued', type: 'task.enqueued', payload: { queue: 'review' }, wakes: false },
]

interface Watch {
  child: ReturnType<typeof spawn>
  stdout: () => string
  stderr: () => string
  watching: () => Promise<void>
  exited: Promise<number | null>
}

function startWatch(file: string, args: string[] = [], bus = path.join(path.dirname(file), 'bus.db')): Watch {
  const child = spawn(TSX, [WATCH, ...args], {
    env: { ...process.env, CONSTRUCT_HANDOFF_DIR: path.dirname(file), CONSTRUCT_BUS_DB: bus },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return observe(child, args.includes(ONCE) ? WATCHING_FROM_CURSOR : WATCHING)
}

function startNode(file: string, nodeArgs: string[], bus = path.join(path.dirname(file), 'bus.db')): Watch {
  const child = spawn(process.execPath, ['--import', 'tsx', ...nodeArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, CONSTRUCT_HANDOFF_DIR: path.dirname(file), CONSTRUCT_BUS_DB: bus },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return observe(child, WATCHING_FROM_CURSOR)
}

function observe(child: ReturnType<typeof spawn>, startLine: string): Watch {
  children.push(child)
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
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const watching = (): Promise<void> => waitFor(() => stderr.includes(startLine), () => `"${startLine}" on stderr (stderr so far: ${JSON.stringify(stderr)})`, DEADLINE_MS)
  return { child, stdout: () => stdout, stderr: () => stderr, watching, exited }
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
    const events: BusEvent[] = [{ id: 3, type: STOP_EVENT, cardId: null, pr: null, head: null, payload: '{"event":"relaunch-stop"}' }]
    const deps = { ...fileDeps(file, () => true, events), lastBusId: () => 3 }
    const state = watchState(deps, [])
    expect(tick(state, deps)).toEqual([])
    events.push({ id: 7, type: STOP_EVENT, cardId: null, pr: null, head: null, payload: '{"event":"relaunch-stop","reason":"max"}' })
    expect(tick(state, deps)).toEqual(['bus relaunch-stop card - pr - {"event":"relaunch-stop","reason":"max"}'])
    expect(tick(state, deps)).toEqual([])
  })

  it.each(BUS_EVENT_WAKES)('$name in the bus wakes the window: $wakes', ({ type, payload, wakes }) => {
    const file = journal()
    const events: BusEvent[] = []
    const deps = fileDeps(file, () => true, events)
    const state = watchState(deps, [])
    const text = JSON.stringify(payload)
    events.push({ id: 1, type, cardId: null, pr: 801, head: 'h1', payload: text })
    expect(tick(state, deps)).toEqual(wakes ? [`bus ${type} card - pr 801 ${text}`] : [])
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
      const fence = append(file, { event: 'merge', task: 'fence' })
      await waitFor(() => watch.stdout().includes(fence), () => 'the fence line after the second event', DEADLINE_MS)
      expect(watch.stdout()).toBe(`journal ${second}\njournal ${fence}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('a PR wakes the window once when its CI turns red, not again on later red observations of it, and again after it left red', () => {
    const file = journal()
    const events: BusEvent[] = []
    const deps = fileDeps(file, () => true, events)
    const state = watchState(deps, [])
    const observe = (id: number, pr: number, head: string, ci: string, extra: object = {}): string => {
      const text = JSON.stringify({ head, ci, ...extra })
      events.push({ id, type: PR_OBSERVED, cardId: null, pr, head, payload: text })
      return text
    }
    const red = observe(1, 801, 'a', 'red')
    expect(tick(state, deps)).toEqual([`bus ${PR_OBSERVED} card - pr 801 ${red}`])
    observe(2, 801, 'a', 'red', { verdict_on_head: 'changes' })
    observe(3, 801, 'a', 'red', { mergeable: 'clean' })
    expect(tick(state, deps)).toEqual([])
    const otherPr = observe(4, 802, 'a', 'red')
    expect(tick(state, deps)).toEqual([`bus ${PR_OBSERVED} card - pr 802 ${otherPr}`])
    observe(5, 801, 'a', 'pending')
    const again = observe(6, 801, 'a', 'red')
    expect(tick(state, deps)).toEqual([`bus ${PR_OBSERVED} card - pr 801 ${again}`])
  })

  it('red on head A, then red on head B with no pending between, wakes twice', () => {
    const file = journal()
    const events: BusEvent[] = []
    const deps = fileDeps(file, () => true, events)
    const state = watchState(deps, [])
    const onA = JSON.stringify({ head: 'a', ci: 'red' })
    const onB = JSON.stringify({ head: 'b', ci: 'red' })
    events.push({ id: 1, type: PR_OBSERVED, cardId: null, pr: 801, head: 'a', payload: onA })
    events.push({ id: 2, type: PR_OBSERVED, cardId: null, pr: 801, head: 'b', payload: onB })
    expect(tick(state, deps)).toEqual([`bus ${PR_OBSERVED} card - pr 801 ${onA}`, `bus ${PR_OBSERVED} card - pr 801 ${onB}`])
  })

  it('two red pr.observed of one pull request and head written to the bus wake miko once, with another pull request\'s red between them, and its red on a new head wakes again', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const head = 'a'.repeat(40)
    const otherHead = 'b'.repeat(40)
    const watch = startWatch(file, [], bus)
    try {
      await watch.watching()
      const first = writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:red:1', JSON.stringify({ head, ci: 'red', mergeable: 'blocked' }), 801, head)
      const other = writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:red:2', JSON.stringify({ head: otherHead, ci: 'red' }), 802, otherHead)
      writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:red:3', JSON.stringify({ head, ci: 'red', mergeable: 'clean' }), 801, head)
      const newHead = writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:red:4', JSON.stringify({ head: otherHead, ci: 'red' }), 801, otherHead)
      await waitFor(() => watch.stdout().split('\n').length > 3, () => 'the lines for the first red of each pull request and head', DEADLINE_MS)
      const fence = writeStop(bus, 2)
      await waitFor(() => watch.stdout().includes(fence), () => 'the fence line after the reds', DEADLINE_MS)
      expect(watch.stdout()).toBe(`bus ${PR_OBSERVED} card - pr 801 ${first}\nbus ${PR_OBSERVED} card - pr 802 ${other}\nbus ${PR_OBSERVED} card - pr 801 ${newHead}\nbus ${STOP_EVENT} card - pr - ${fence}\n`)
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
      const fence = writeStop(bus, 3)
      await waitFor(() => watch.stdout().split('\n').length > 2, () => `the fence line after the relaunch-stop ${fence}`, DEADLINE_MS)
      expect(watch.stdout()).toBe(`bus ${STOP_EVENT} card - pr - ${payload}\nbus ${STOP_EVENT} card - pr - ${fence}\n`)
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
      const fence = writeStop(bus, 2)
      await waitFor(() => watch.stdout().includes(fence), () => 'the fence line after the review.recorded', DEADLINE_MS)
      expect(watch.stdout()).toBe(`bus ${REVIEW_RECORDED} card - pr - ${payload}\nbus ${STOP_EVENT} card - pr - ${fence}\n`)
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
    expect(parseWatchArgs([])).toEqual({ pids: [], once: false })
    expect(parseWatchArgs(['--pid', '12', '13', '--pid', '14'])).toEqual({ pids: [12, 13, 14], once: false })
    expect(parseWatchArgs(['--once', '--pid', '12'])).toEqual({ pids: [12], once: true })
    expect(parseWatchArgs(['--pid', '--once'])).toBeUndefined()
    expect(parseWatchArgs(['--pid'])).toBeUndefined()
    expect(parseWatchArgs(['12'])).toBeUndefined()
    expect(parseWatchArgs(['--pid', 'x'])).toBeUndefined()
    expect(parseWatchArgs(['--pid', '0'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--card', '943', '--pid', '12'])).toEqual({ pids: [12], once: true, card: 943 })
    expect(parseWatchArgs(['--card', '943'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--card'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--card', 'x'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--card', '1', '--card', '2'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--pid', '--card', '943'])).toBeUndefined()
    expect(parseWatchArgs(['--once', '--pid', '12', '--card', '943', '13'])).toBeUndefined()
  })

  it('wakes on events end to end and stays silent otherwise: the script prints one line per event and nothing else', async () => {
    const file = journal()
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const sleeperGone = new Promise(resolve => sleeper.on('close', resolve))
    const fenceSleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const watch = startWatch(file, ['--pid', String(sleeper.pid), String(fenceSleeper.pid), String(process.pid)])
    try {
      await watch.watching()
      append(file, { event: 'path', task: '709' })
      const merge = append(file, { event: 'merge', task: '709' })
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the merge', DEADLINE_MS)
      sleeper.kill()
      await sleeperGone
      await waitFor(() => watch.stdout().split('\n').length > 2, () => `the line for the exit of pid ${sleeper.pid}`, DEADLINE_MS)
      fenceSleeper.kill()
      await waitFor(() => watch.stdout().split('\n').length > 3, () => `the line for the exit of pid ${fenceSleeper.pid}`, DEADLINE_MS)
      expect(watch.stdout()).toBe(`journal ${merge}\npid ${sleeper.pid} exited\npid ${fenceSleeper.pid} exited\n`)
    }
    finally {
      watch.child.kill()
      sleeper.kill()
      fenceSleeper.kill()
    }
  }, 20_000)

  it('with --once exits 0 after the first review.recorded and prints exactly one line', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const watch = startWatch(file, [ONCE], bus)
    const exited = watch.exited
    try {
      await watch.watching()
      const first = writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:first', JSON.stringify({ verdict: 'changes' }))
      writeBusEvent(bus, MERGE_DONE, 'worker:merge:s1', 'merge.done:second', JSON.stringify({ commit: 'c0ffee', rule: 'auto' }))
      expect(await exited).toBe(0)
      expect(watch.stdout()).toBe(`bus ${REVIEW_RECORDED} card - pr - ${first}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('a merge outside the merge worker wakes the window after the cutoff', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const before = readFileSync(file, 'utf8')
    const watch = startWatch(file, [ONCE], bus)
    const exited = watch.exited
    try {
      await watch.watching()
      const db = openBus(bus)
      const closed = prClosed('2026-10-13T18:00:00.000Z', { pr: 810, cardId: 937, merged: true, commit: 'c0ffee', mergedBy: 'E1i', mergedAt: '2026-10-13T17:59:00Z' })
      try {
        appendEvent(db, closed)
      }
      finally {
        db.close()
      }
      expect(await exited).toBe(0)
      expect(watch.stdout()).toBe(`bus ${PR_CLOSED} card 937 pr 810 ${typeof closed.payload === 'string' ? closed.payload : JSON.stringify(closed.payload)}\n`)
      expect(readFileSync(file, 'utf8')).toBe(before)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('without --once keeps waiting after the first waking event', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const watch = startWatch(file, [], bus)
    try {
      await watch.watching()
      writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:waits', JSON.stringify({ verdict: 'pass' }))
      await waitFor(() => watch.stdout().includes('\n'), () => 'the line for the review.recorded', DEADLINE_MS)
      writeBusEvent(bus, MERGE_DONE, 'worker:merge:s1', 'merge.done:waits', JSON.stringify({ commit: 'c0ffee', rule: 'auto' }))
      await waitFor(() => watch.stdout().split('\n').length > 2, () => 'the line for the merge.done after the first waking event', DEADLINE_MS)
      expect(watch.child.exitCode).toBeNull()
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('an event that does not wake does not end --once, and the next waking one does', async () => {
    const file = journal()
    const bus = path.join(path.dirname(file), 'bus.db')
    writeStop(bus, 1)
    const watch = startWatch(file, [ONCE], bus)
    const exited = watch.exited
    try {
      await watch.watching()
      writeBusEvent(bus, PR_OBSERVED, 'netwatch', 'pr.observed:green-once', JSON.stringify({ ci: 'green' }))
      writeBusEvent(bus, 'chain.observed', 'reducer', 'chain.observed:once', JSON.stringify({ alive: true }))
      append(file, { event: 'path', task: '930' })
      const merge = writeBusEvent(bus, MERGE_DONE, 'worker:merge:s1', 'merge.done:once', JSON.stringify({ commit: 'c0ffee', rule: 'auto' }))
      expect(await exited).toBe(0)
      expect(watch.stdout()).toBe(`bus ${MERGE_DONE} card - pr - ${merge}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)
})

const WRITES_UNTIL_EXIT = `
const { writeFileSync } = require('node:fs')
const path = require('node:path')
let n = 0
const write = () => { writeFileSync(path.join(process.argv[1], 'side-' + n++), ''); setImmediate(write) }
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300))
console.error('${WATCHING}')
write()
`

describe('the teardown waits for every child it started', () => {
  it('the teardown removes a killed child’s directory only after it exited', async () => {
    const writers = Array.from({ length: 8 }, () => observe(spawn(process.execPath, ['-e', WRITES_UNTIL_EXIT, path.dirname(journal())], { stdio: ['ignore', 'pipe', 'pipe'] }), WATCHING))
    await Promise.all(writers.map(async writer => writer.watching()))
    for (const writer of writers)
      writer.child.kill()
  })
})

describe('pnpm miko:watch --once keeps its cursor in a SQLite file that one consumer holds', () => {
  const storeOf = (file: string): string => path.join(path.dirname(file), ONCE_STORE)
  const busOf = (file: string): string => path.join(path.dirname(file), 'bus.db')

  function storedCursor(file: string): { journal_offset: number, bus_id: number } {
    const db = new DatabaseSync(storeOf(file))
    try {
      return { ...db.prepare('SELECT journal_offset, bus_id FROM cursor WHERE id = 1').get() as { journal_offset: number, bus_id: number } }
    }
    finally {
      db.close()
    }
  }

  function seed(file: string, cursor: { offset: number, busId: number }): void {
    OnceStore.open(storeOf(file), { file: path.join(path.dirname(file), LEGACY_CURSOR), text: JSON.stringify(cursor) }, () => cursor).close()
  }

  async function runOnceToEnd(file: string, extra: string[] = []): Promise<{ code: number | null, stdout: string, stderr: string }> {
    const watch = startWatch(file, [ONCE, ...extra], busOf(file))
    try {
      const code = await watch.exited
      return { code, stdout: watch.stdout(), stderr: watch.stderr() }
    }
    finally {
      watch.child.kill()
    }
  }

  it('a first --once with no cursor reports on stderr the position it fixed and delivers nothing from before it', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const watch = startWatch(file, [ONCE], busOf(file))
    try {
      await watch.watching()
      expect(watch.stderr()).toContain(`no cursor: initialized at journal offset ${statSync(file).size}, bus id 1; earlier events are not delivered`)
      const merge = append(file, { event: 'merge', task: '930' })
      expect(await watch.exited).toBe(0)
      expect(watch.stdout()).toBe(`journal ${merge}\n`)
    }
    finally {
      watch.child.kill()
    }
  }, 20_000)

  it('while one --once holds the file and waits, a second --once exits non-zero at once naming the file, and the first goes on waiting', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const first = startWatch(file, [ONCE], busOf(file))
    try {
      await first.watching()
      const second = await runOnceToEnd(file)
      expect(second.code).toBe(1)
      expect(second.stderr).toContain(`${ANOTHER_CONSUMER} on ${storeOf(file)}`)
      expect(first.child.exitCode).toBeNull()
      const merge = append(file, { event: 'merge', task: '930' })
      expect(await first.exited).toBe(0)
      expect(first.stdout()).toBe(`journal ${merge}\n`)
    }
    finally {
      first.child.kill()
    }
  }, 30_000)

  it('a --once killed by SIGKILL before any event leaves the file free, and the next --once takes it at once and gets the event', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const first = startNode(file, [WATCH, ONCE], busOf(file))
    await first.watching()
    first.child.kill('SIGKILL')
    await first.exited
    const merge = append(file, { event: 'merge', task: '930' })
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `journal ${merge}\n` })
  }, 30_000)

  it('a --once stopped after its line is written and before COMMIT leaves the cursor where it was, and the next --once delivers the event again', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    const before = storedCursor(file)
    const merge = append(file, { event: 'merge', task: '930' })
    const pausedBeforeCommit = 'paused before COMMIT'
    const script = [
      `const { productionDeps, runOnce } = await import(${JSON.stringify(pathToFileURL(WATCH).href)})`,
      'const handoff = process.env.CONSTRUCT_HANDOFF_DIR',
      `const deps = { ...productionDeps(handoff, process.env.CONSTRUCT_BUS_DB), beforeCommit: () => { process.stderr.write(${JSON.stringify(`${pausedBeforeCommit}\n`)}); return new Promise(() => {}) } }`,
      'await runOnce(handoff, deps, [])',
    ].join('\n')
    const paused = startNode(file, ['--input-type=module', '--eval', script], busOf(file))
    await waitFor(() => paused.stderr().includes(pausedBeforeCommit), () => `"${pausedBeforeCommit}" on stderr (stderr so far: ${JSON.stringify(paused.stderr())})`, DEADLINE_MS)
    expect(paused.stdout()).toBe(`journal ${merge}\n`)
    paused.child.kill('SIGKILL')
    await paused.exited
    expect(storedCursor(file)).toEqual(before)
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `journal ${merge}\n` })
    expect(storedCursor(file)).toEqual({ journal_offset: statSync(file).size, bus_id: 1 })
  }, 30_000)

  it('a --once whose stdout reader is gone exits non-zero and leaves the cursor where it was', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    const before = storedCursor(file)
    const watch = startWatch(file, [ONCE], busOf(file))
    try {
      await watch.watching()
      watch.child.stdout!.destroy()
      const merge = append(file, { event: 'merge', task: '930' })
      expect(await watch.exited).toBe(1)
      expect(watch.stderr()).toContain('could not be written to stdout')
      expect(storedCursor(file)).toEqual(before)
      expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `journal ${merge}\n` })
    }
    finally {
      watch.child.kill()
    }
  }, 30_000)

  it('a damaged cursor file makes --once exit non-zero with its path and leaves the file as it was', async () => {
    const file = journal()
    const damaged = 'not a database '.repeat(100)
    writeFileSync(storeOf(file), damaged)
    const run = await runOnceToEnd(file)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`${storeOf(file)} cannot be opened as the --once cursor`)
    expect(readFileSync(storeOf(file), 'utf8')).toBe(damaged)
  }, 20_000)

  it('a journal shorter than the cursor offset makes --once exit non-zero with the journal path and both sizes', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    seed(file, { offset: 10_000, busId: 1 })
    const run = await runOnceToEnd(file)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`the journal ${file} is ${statSync(file).size} bytes, shorter than the cursor's offset 10000`)
  }, 20_000)

  it('an existing miko-watch.json moves into the SQLite cursor without losing its position and is removed after the commit', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const legacy = path.join(path.dirname(file), LEGACY_CURSOR)
    writeFileSync(legacy, JSON.stringify({ offset: statSync(file).size, busId: 1 }))
    const merge = append(file, { event: 'merge', task: 'written-before-the-move' })
    const run = await runOnceToEnd(file)
    expect(run).toMatchObject({ code: 0, stdout: `journal ${merge}\n` })
    expect(run.stderr).toContain(`the cursor moved into ${storeOf(file)}`)
    expect(existsSync(legacy)).toBe(false)
  }, 20_000)

  it('an invalid miko-watch.json makes --once exit non-zero with its path and moves nothing', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const legacy = path.join(path.dirname(file), LEGACY_CURSOR)
    writeFileSync(legacy, '{"offset":')
    const run = await runOnceToEnd(file)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`the old cursor ${legacy} is not`)
    expect(existsSync(legacy)).toBe(true)
  }, 20_000)

  it('waking events that one pass sees together — journal and bus, then two in the bus — are delivered by successive runs one by one', async () => {
    const file = journal()
    const bus = busOf(file)
    writeStop(bus, 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    const merge = append(file, { event: 'merge', task: '930' })
    const review = writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:pass-1', JSON.stringify({ verdict: 'changes', n: 1 }))
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `journal ${merge}\n` })
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `bus ${REVIEW_RECORDED} card - pr - ${review}\n` })
    const first = writeBusEvent(bus, MERGE_DONE, 'worker:merge:s1', 'merge.done:pass-2', JSON.stringify({ commit: 'c0ffee' }))
    const second = writeBusEvent(bus, CARD_CLOSED, 'reducer', 'card.closed:pass-2', JSON.stringify({ verification: 'run' }))
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `bus ${MERGE_DONE} card - pr - ${first}\n` })
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `bus ${CARD_CLOSED} card - pr - ${second}\n` })
  }, 60_000)

  it('a bus line carries the card_id and pr of its event', async () => {
    const file = journal()
    const bus = busOf(file)
    writeStop(bus, 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    const review = writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:card', JSON.stringify({ verdict: 'pass' }), 818, null, 943)
    expect(await runOnceToEnd(file)).toMatchObject({ code: 0, stdout: `bus ${REVIEW_RECORDED} card 943 pr 818 ${review}\n` })
  }, 20_000)

  it('with --card the once run skips the events of other cards and wakes on its own', async () => {
    const file = journal()
    const bus = busOf(file)
    writeStop(bus, 1)
    const start = statSync(file).size
    seed(file, { offset: start, busId: 1 })
    append(file, { event: 'merge', task: '942' })
    writeBusEvent(bus, CARD_CLOSED, 'reducer', 'card.closed:942', JSON.stringify({ verification: 'run' }), 817, null, 942)
    writeBusEvent(bus, REVIEW_RECORDED, 'worker:review:s1', 'review.recorded:no-card', JSON.stringify({ verdict: 'pass' }), 816)
    const skipped = { offset: statSync(file).size, busId: 3 }
    const busOnly = (id: number, cardId: number): BusEvent => ({ id, type: CARD_CLOSED, cardId, pr: 817, head: null, payload: '{}' })
    expect(selectOnce({ offset: start, busId: 1 }, { ...fileDeps(file, () => true, [busOnly(2, 942), busOnly(3, 942)]), lastBusId: () => 3 }, [], 943)).toEqual({ line: null, cursor: skipped })
    const own = writeBusEvent(bus, MERGE_DONE, 'worker:merge:s1', 'merge.done:943', JSON.stringify({ commit: 'c0ffee' }), 818, null, 943)
    const watch = startWatch(file, [ONCE, '--card', '943'], bus)
    try {
      expect(await watch.exited).toBe(0)
      expect(watch.stdout()).toBe(`bus ${MERGE_DONE} card 943 pr 818 ${own}\n`)
    }
    finally {
      watch.child.kill()
    }
    expect(storedCursor(file)).toEqual({ journal_offset: skipped.offset, bus_id: 4 })
  }, 20_000)

  it('miko:watch --once --card N wakes on review.rounds_spent of its own pull request and its line names the round limit and the owner decision it needs', async () => {
    const file = journal()
    const bus = busOf(file)
    writeStop(bus, 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    const payload = writeBusEvent(bus, REVIEW_ROUNDS_SPENT, 'worker:review:s1', 'review.rounds_spent:818', JSON.stringify({ state: 'round_limit_reached', pr: 818, rounds: 3 }), 818, null, 943)
    const result = await runOnceToEnd(file, ['--card', '943'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`bus ${REVIEW_ROUNDS_SPENT} card 943 pr 818`)
    expect(result.stdout).toContain('round limit')
    expect(result.stdout).toContain('allow-merge')
    expect(result.stdout).toContain(payload)
  }, 20_000)

  it('miko:watch --once --card N does not wake on review.rounds_spent of another card', () => {
    const file = journal()
    const offset = statSync(file).size
    const events: BusEvent[] = [{ id: 2, type: REVIEW_ROUNDS_SPENT, cardId: 942, pr: 817, head: null, payload: '{}' }]
    expect(selectOnce({ offset, busId: 1 }, { ...fileDeps(file, () => true, events), lastBusId: () => 2 }, [], 943)).toEqual({ line: null, cursor: { offset, busId: 2 } })
  })

  it('with --card the once run prints a journal line of its own card and skips one of another', () => {
    const file = journal()
    const start = statSync(file).size
    append(file, { event: 'merge', task: '942' })
    const own = append(file, { event: 'merge', task: '943' })
    expect(selectOnce({ offset: start, busId: 1 }, { ...fileDeps(file), lastBusId: () => 1 }, [], 943)).toEqual({ line: `journal ${own}`, cursor: { offset: statSync(file).size, busId: 1 } })
  })

  it('with --card the skips of other cards are kept when the pass stops at an event past its end', () => {
    const file = journal()
    const offset = statSync(file).size
    const events: BusEvent[] = [
      { id: 2, type: CARD_CLOSED, cardId: 942, pr: 817, head: null, payload: '{}' },
      { id: 4, type: MERGE_DONE, cardId: 943, pr: 818, head: null, payload: '{}' },
    ]
    expect(selectOnce({ offset, busId: 1 }, { ...fileDeps(file, () => true, events), lastBusId: () => 3 }, [], 943)).toEqual({ line: null, cursor: { offset, busId: 2 } })
  })

  it('the skip line names the bus id the cursor was committed through', () => {
    expect(skippedLine(2)).toBe('skipped through bus id 2')
  })

  it('a --card once run killed while it waits leaves the cursor past the events of other cards it skipped', async () => {
    const file = journal()
    const bus = busOf(file)
    writeStop(bus, 1)
    seed(file, { offset: statSync(file).size, busId: 1 })
    append(file, { event: 'merge', task: '942' })
    writeBusEvent(bus, CARD_CLOSED, 'reducer', 'card.closed:942', JSON.stringify({ verification: 'run' }), 817, null, 942)
    const waiting = startNode(file, [WATCH, ONCE, '--card', '943'], bus)
    await waiting.watching()
    await waitFor(() => waiting.stderr().includes(skippedLine(2)), () => `"${skippedLine(2)}" on stderr (stderr so far: ${JSON.stringify(waiting.stderr())})`, DEADLINE_MS)
    waiting.child.kill('SIGKILL')
    await waiting.exited
    expect(waiting.stdout()).toBe('')
    expect(storedCursor(file)).toEqual({ journal_offset: statSync(file).size, bus_id: 2 })
  }, 30_000)

  it('two --once started together: exactly one takes the file and waits, the other refuses', async () => {
    const file = journal()
    writeStop(busOf(file), 1)
    const watches = [startWatch(file, [ONCE], busOf(file)), startWatch(file, [ONCE], busOf(file))]
    try {
      const refused = await Promise.race(watches.map(async (watch, index) => ({ index, code: await watch.exited })))
      expect(refused.code).toBe(1)
      expect(watches[refused.index]!.stderr()).toContain(`${ANOTHER_CONSUMER} on ${storeOf(file)}`)
      const winner = watches[1 - refused.index]!
      await winner.watching()
      const merge = append(file, { event: 'merge', task: '930' })
      expect(await winner.exited).toBe(0)
      expect(winner.stdout()).toBe(`journal ${merge}\n`)
    }
    finally {
      for (const watch of watches)
        watch.child.kill()
    }
  }, 30_000)

  it('a pass reads to the ends it fixed: an event after them waits for the next pass, the delivered source moves only to its event, and the other stays', () => {
    const file = journal()
    const start = statSync(file).size
    const events: BusEvent[] = [
      { id: 2, type: MERGE_DONE, cardId: null, pr: 805, head: 'h', payload: '{"commit":"c0ffee"}' },
      { id: 3, type: PR_OBSERVED, cardId: null, pr: 805, head: 'h', payload: '{"ci":"green"}' },
      { id: 5, type: REVIEW_RECORDED, cardId: null, pr: 805, head: 'h', payload: '{"verdict":"pass"}' },
    ]
    let busEnd = 3
    const deps = { ...fileDeps(file, () => true, events), lastBusId: () => busEnd }
    const merge = append(file, { event: 'merge', task: '930' })
    const afterMerge = statSync(file).size
    expect(selectOnce({ offset: start, busId: 1 }, deps, [])).toEqual({ line: `journal ${merge}`, cursor: { offset: afterMerge, busId: 1 } })
    expect(selectOnce({ offset: afterMerge, busId: 1 }, deps, [])).toEqual({ line: `bus ${MERGE_DONE} card - pr 805 {"commit":"c0ffee"}`, cursor: { offset: afterMerge, busId: 2 } })
    expect(selectOnce({ offset: afterMerge, busId: 2 }, deps, [])).toBeUndefined()
    busEnd = 5
    expect(selectOnce({ offset: afterMerge, busId: 2 }, deps, [])).toEqual({ line: `bus ${REVIEW_RECORDED} card - pr 805 {"verdict":"pass"}`, cursor: { offset: afterMerge, busId: 5 } })
    const late = append(file, { event: 'fall', task: '931' })
    const snapshotBeforeLate = { ...deps, size: () => afterMerge }
    expect(selectOnce({ offset: afterMerge, busId: 5 }, snapshotBeforeLate, [])).toBeUndefined()
    expect(selectOnce({ offset: afterMerge, busId: 5 }, deps, [])).toEqual({ line: `journal ${late}`, cursor: { offset: statSync(file).size, busId: 5 } })
  })

  it('a --once restarted after a red pr.observed does not wake on a repeat of that red', () => {
    const file = journal()
    const red = (id: number, head: string): BusEvent => ({ id, type: PR_OBSERVED, cardId: null, pr: 805, head, payload: JSON.stringify({ head, ci: 'red' }) })
    const events: BusEvent[] = [red(1, 'a'), red(2, 'a'), red(3, 'b')]
    const deps = { ...fileDeps(file, () => true, events), lastBusId: () => 3 }
    expect(selectOnce({ offset: statSync(file).size, busId: 1 }, deps, [])).toEqual({ line: `bus ${PR_OBSERVED} card - pr 805 ${red(3, 'b').payload}`, cursor: { offset: statSync(file).size, busId: 3 } })
  })
})

describe('pnpm miko:watch wakes the window where the bus is stuck, not only on a verdict and CI', () => {
  const denial = (id: number, reason: string, head = 'h1'): BusEvent => ({ id, type: POLICY_DENIED, cardId: 1064, pr: 921, head, payload: JSON.stringify({ command: 'record_verdict', kind: 'technical', reason, detail: 'sandbox.enabled is not true' }) })

  it('wakes on a second policy.denied in a row for one task with the reason and the settings file', () => {
    const file = journal()
    const events: BusEvent[] = []
    const deps = fileDeps(file, () => true, events)
    const state = watchState(deps, [])
    events.push(denial(1, 'no_isolation'))
    expect(tick(state, deps)).toEqual([])
    events.push(denial(2, 'no_isolation'))
    const lines = tick(state, deps)
    expect(lines).toEqual([`bus ${POLICY_DENIED} card 1064 pr 921 second in a row for one task: reason no_isolation; settings ${USER_SETTINGS} ${denial(2, 'no_isolation').payload}`])
    events.push(denial(3, 'no_isolation'), denial(4, 'other'), denial(5, 'no_isolation', 'h2'))
    expect(tick(state, deps)).toEqual([])
    const settings = { ...denial(6, 'no_isolation', 'h2'), payload: JSON.stringify({ command: 'record_verdict', reason: 'no_isolation', settings: '.claude/settings.local.json' }) }
    events.push(settings)
    expect(tick(state, deps)).toEqual([`bus ${POLICY_DENIED} card 1064 pr 921 second in a row for one task: reason no_isolation; settings .claude/settings.local.json ${settings.payload}`])
    const offset = statSync(file).size
    const once = { ...fileDeps(file, () => true, events.slice(0, 3)), lastBusId: () => 3 }
    expect(selectOnce({ offset, busId: 1 }, once, [], 1064)).toEqual({ line: lines[0], cursor: { offset, busId: 2 } })
    expect(selectOnce({ offset, busId: 2 }, once, [], 1064)).toBeUndefined()
  })

  it('wakes on card.stopped after a session death', () => {
    const file = journal()
    const offset = statSync(file).size
    const stopped: BusEvent = { id: 2, type: CARD_STOPPED, cardId: 1074, pr: null, head: null, payload: JSON.stringify({ reason: 'fault', detail: 'the session died a third time' }) }
    const deps = { ...fileDeps(file, () => true, [stopped]), lastBusId: () => 2 }
    expect(selectOnce({ offset, busId: 1 }, deps, [], 1074)).toEqual({ line: `bus ${CARD_STOPPED} card 1074 pr - ${stopped.payload}`, cursor: { offset, busId: 2 } })
  })

  it('wakes on a card with no new event for more than 20 minutes while the bus is alive', async () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z')
    const at = (ms: number): string => new Date(now - ms).toISOString()
    const card = (cardId: number, ms: number): CardActivity => ({ cardId, lastEventId: cardId, lastType: 'card.started', lastTs: at(ms) })
    expect(stalledOf([card(1, STALL_MS + 1), card(2, STALL_MS)], at(0), now)).toEqual([card(1, STALL_MS + 1)])
    expect(stalledOf([card(1, STALL_MS + 1)], at(BUS_ALIVE_MS + 1), now)).toEqual([])
    expect(stalledOf([card(1, STALL_MS + 1)], undefined, now)).toEqual([])

    const file = journal()
    const stalls: CardActivity[] = [card(951, 7 * 24 * 60 * 60_000)]
    const deps = { ...fileDeps(file), stalls: () => [...stalls] }
    const state = watchState(deps, [])
    expect(tick(state, deps, now)).toEqual([])
    stalls.push(card(1071, STALL_MS + 60_000))
    expect(tick(state, deps, now)).toEqual([`stall card 1071: no new event for 21 minutes since card.started at ${at(STALL_MS + 60_000)}, while the bus is alive`])
    expect(tick(state, deps, now)).toEqual([])

    let cursor = { offset: statSync(file).size, busId: 0 }
    const store = {
      cursor: () => cursor,
      write: (next: typeof cursor) => {
        cursor = next
      },
      commit: () => {},
    } as unknown as OnceStore
    const emitted: string[] = []
    let calls = 0
    const old = card(951, 7 * 24 * 60 * 60_000)
    const once = {
      ...fileDeps(file),
      emit: async (line: string) => {
        emitted.push(line)
      },
      stalls: () => calls++ < 2 ? [old] : [old, card(1086, STALL_MS + 60_000)],
    }
    await deliverOnce(store, once, [], 1086, () => now)
    expect(emitted).toEqual([`stall card 1086: no new event for 21 minutes since card.started at ${at(STALL_MS + 60_000)}, while the bus is alive`])
    expect(cursor).toEqual({ offset: statSync(file).size, busId: 0 })
  }, 10_000)

  it('the streaming watch counts a policy.denied from before its start toward a second in a row, as --once does', () => {
    const file = journal()
    const events: BusEvent[] = [denial(1, 'no_isolation')]
    const deps = { ...fileDeps(file, () => true, events), lastBusId: () => 1 }
    const state = watchState(deps, [])
    events.push(denial(2, 'no_isolation'))
    const lines = tick(state, deps)
    expect(lines).toEqual([`bus ${POLICY_DENIED} card 1064 pr 921 second in a row for one task: reason no_isolation; settings ${USER_SETTINGS} ${denial(2, 'no_isolation').payload}`])
    const offset = statSync(file).size
    const once = { ...deps, lastBusId: () => 2 }
    expect(selectOnce({ offset, busId: 1 }, once, [])).toEqual({ line: lines[0], cursor: { offset, busId: 2 } })
  })

  it('two cards that stall in the same poll both wake a --once with no --card', async () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z')
    const at = (ms: number): string => new Date(now - ms).toISOString()
    const card = (cardId: number): CardActivity => ({ cardId, lastEventId: cardId, lastType: 'card.started', lastTs: at(STALL_MS + 60_000) })
    const file = journal()
    let cursor = { offset: statSync(file).size, busId: 0 }
    const store = {
      cursor: () => cursor,
      write: (next: typeof cursor) => {
        cursor = next
      },
      commit: () => {},
    } as unknown as OnceStore
    const emitted: string[] = []
    let calls = 0
    const once = {
      ...fileDeps(file),
      emit: async (line: string) => {
        emitted.push(line)
      },
      stalls: () => calls++ < 1 ? [] : [card(1071), card(1086)],
    }
    await deliverOnce(store, once, [], undefined, () => now)
    expect(emitted).toEqual([[1071, 1086].map(id => `stall card ${id}: no new event for 21 minutes since card.started at ${at(STALL_MS + 60_000)}, while the bus is alive`).join('\n')])
  })
})
