import type { WatchDeps } from '../../window/watch.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { SESSION_STALLED, TASK_COMPLETED, TASK_RELEASED } from '../../core/events.js'
import { RELEASES_IN_A_ROW } from '../../window/release-loop.js'
import { ONCE_STORE, OnceStore } from '../../window/watch-store.js'
import { CATCHUP_LAG, caughtUpLine, deliverOnce, productionDeps, selectOnce, tick, watchState } from '../../window/watch.js'

const OUTSIDE_TOUCHES = 'outside-touches'
const CARD = 1903
const QUEUE = 'launch'
const TASK = 'launch:1903'
const FIRST_TS = '2026-11-15T17:05:00.000Z'
const LOOP_WORDING = `released ${RELEASES_IN_A_ROW} times in a row with reason ${OUTSIDE_TOUCHES}, first at ${FIRST_TS}`
const FROM_START = { offset: 0, busId: 0 }

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

interface Bus {
  dir: string
  file: string
  next: number
}

function aBus(): Bus {
  const dir = mkdtempSync(path.join(tmpdir(), 'watch-wakes-'))
  dirs.push(dir)
  return { dir, file: path.join(dir, 'bus.db'), next: 0 }
}

function write(bus: Bus, type: string, payload: Record<string, unknown>, ts = FIRST_TS): void {
  bus.next += 1
  const db = openBus(bus.file)
  try {
    appendEvent(db, { ts, type, actor: 'worker:test:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${bus.next}`, payload: JSON.stringify(payload), legacy: false })
  }
  finally {
    db.close()
  }
}

function release(bus: Bus, reason = OUTSIDE_TOUCHES, task = TASK, ts = FIRST_TS): void {
  write(bus, TASK_RELEASED, { task_key: task, queue: QUEUE, lease_gen: bus.next + 1, reason }, ts)
}

function complete(bus: Bus, task = TASK): void {
  write(bus, TASK_COMPLETED, { task_key: task, queue: QUEUE, lease_gen: bus.next + 1 })
}

function depsOf(bus: Bus, emitted: string[] = []): WatchDeps {
  return { ...productionDeps(bus.dir, bus.file), beat: () => {}, emit: async (line) => {
    emitted.push(line)
  } }
}

function loopLines(lines: readonly string[]): string[] {
  return lines.filter(line => line.startsWith(`bus ${TASK_RELEASED}`))
}

describe('miko:watch wakes on a stalled session and on a release loop', () => {
  it('a session.stalled event wakes miko:watch --once', async () => {
    const bus = aBus()
    write(bus, SESSION_STALLED, { task_key: TASK, queue: QUEUE, lease_gen: 1, reason: 'silent', session: 's1', since: FIRST_TS, life: 'live' })
    const emitted: string[] = []
    const store = OnceStore.open(path.join(bus.dir, ONCE_STORE), { file: path.join(bus.dir, 'legacy.json'), text: undefined }, () => ({ offset: 0, busId: 0 }))
    try {
      await deliverOnce(store, depsOf(bus, emitted))
    }
    finally {
      store.close()
    }
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatch(new RegExp(`^bus ${SESSION_STALLED.replace('.', '\\.')} card ${CARD} pr - `))
  })

  it('three releases of one task with the same reason wake the watch once', () => {
    const bus = aBus()
    const deps = depsOf(bus)
    const state = watchState(deps)
    release(bus, OUTSIDE_TOUCHES, TASK, FIRST_TS)
    release(bus, OUTSIDE_TOUCHES, TASK, '2026-11-15T17:06:00.000Z')
    expect(loopLines(tick(state, deps))).toEqual([])
    release(bus, OUTSIDE_TOUCHES, TASK, '2026-11-15T17:07:00.000Z')
    const woken = loopLines(tick(state, deps))
    expect(woken).toHaveLength(1)
    expect(woken[0]).toContain(`card ${CARD} queue ${QUEUE} released ${RELEASES_IN_A_ROW} times in a row with reason ${OUTSIDE_TOUCHES}, first at ${FIRST_TS}`)
    expect(woken[0]).toMatch(new RegExp(`^bus ${TASK_RELEASED.replace('.', '\\.')} card ${CARD} pr - `))
    release(bus)
    expect(loopLines(tick(state, deps))).toEqual([])
  })

  it('a different reason between releases resets the count', () => {
    const bus = aBus()
    const deps = depsOf(bus)
    const state = watchState(deps)
    release(bus)
    release(bus)
    release(bus, 'busy')
    release(bus)
    expect(loopLines(tick(state, deps))).toEqual([])
    release(bus)
    expect(loopLines(tick(state, deps))).toEqual([])
    release(bus)
    expect(loopLines(tick(state, deps))).toHaveLength(1)
  })

  it('a completed lease between releases resets the count', () => {
    const bus = aBus()
    const deps = depsOf(bus)
    const state = watchState(deps)
    release(bus)
    release(bus)
    complete(bus)
    release(bus)
    release(bus)
    expect(loopLines(tick(state, deps))).toEqual([])
  })

  it('releases of another task do not count toward a task\'s run', () => {
    const bus = aBus()
    const deps = depsOf(bus)
    const state = watchState(deps)
    release(bus)
    release(bus, OUTSIDE_TOUCHES, 'launch:1958')
    release(bus)
    expect(loopLines(tick(state, deps))).toEqual([])
  })

  it('two releases before the watch started and a third after it wake the watch, and a completed lease before it starts clears them', () => {
    const bus = aBus()
    release(bus)
    release(bus)
    const deps = depsOf(bus)
    const state = watchState(deps)
    release(bus)
    expect(loopLines(tick(state, deps))).toHaveLength(1)
    const other = aBus()
    release(other)
    release(other)
    complete(other)
    const otherDeps = depsOf(other)
    const otherState = watchState(otherDeps)
    release(other)
    expect(loopLines(tick(otherState, otherDeps))).toEqual([])
  })

  it('a --once watch wakes on a release loop with the loop line', async () => {
    const bus = aBus()
    release(bus)
    release(bus)
    release(bus)
    const emitted: string[] = []
    const store = OnceStore.open(path.join(bus.dir, ONCE_STORE), { file: path.join(bus.dir, 'legacy.json'), text: undefined }, () => FROM_START)
    try {
      await deliverOnce(store, depsOf(bus, emitted))
    }
    finally {
      store.close()
    }
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain(LOOP_WORDING)
  })

  it('selectOnce carries the loop line with and without a card filter, and a filter on another card leaves it out', () => {
    const bus = aBus()
    release(bus)
    release(bus)
    release(bus)
    const deps = depsOf(bus)
    expect(selectOnce(FROM_START, deps)?.line).toContain(LOOP_WORDING)
    expect(selectOnce(FROM_START, deps, CARD)?.line).toContain(LOOP_WORDING)
    expect(selectOnce(FROM_START, deps, CARD + 1)?.line ?? null).toBeNull()
  })

  it('a cursor more than the catch-up lag behind carries the loop line after the caught-up line', () => {
    const bus = aBus()
    for (let filler = 0; filler <= CATCHUP_LAG; filler++)
      write(bus, 'test.filler', {})
    release(bus)
    release(bus)
    release(bus)
    const deps = depsOf(bus)
    const end = deps.lastBusId()
    const lines = selectOnce(FROM_START, deps)?.line?.split('\n') ?? []
    expect(lines[0]).toBe(caughtUpLine(0, end))
    expect(lines.filter(line => line.includes(LOOP_WORDING))).toHaveLength(1)
    expect(selectOnce(FROM_START, deps, CARD)?.line).toContain(LOOP_WORDING)
    expect(selectOnce(FROM_START, deps, CARD + 1)?.line ?? null).toBeNull()
  })
})
