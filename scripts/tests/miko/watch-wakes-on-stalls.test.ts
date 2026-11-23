import type { WatchDeps } from '../../window/watch.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, BOARD_STALE_TICKS, BOARD_TIMER_PERIOD_MS, openBus, recordBoardBeat } from '../../core/db.js'
import { SESSION_HEARTBEAT, SESSION_STALLED, TASK_COMPLETED, TASK_RELEASED, WINDOW_HEARTBEAT } from '../../core/events.js'
import { recordProcessHeartbeat } from '../../supervisor/heartbeat.js'
import { RELEASES_IN_A_ROW } from '../../window/release-loop.js'
import { ONCE_STORE, OnceStore } from '../../window/watch-store.js'
import { BOARD_STALE, CATCHUP_LAG, caughtUpLine, deliverOnce, FACTORY_DOWN, FACTORY_DOWN_MS, FACTORY_START, productionDeps, selectOnce, tick, watchState } from '../../window/watch.js'
import { LOOP_PROCESS } from '../../window/window-heartbeat.js'

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

const NOW = Date.parse('2026-11-19T08:50:00.000Z')
const MINUTE_MS = 60_000
const WORKER = 'worker:launch:4242'

function beat(bus: Bus, process: string, at: number): void {
  const db = openBus(bus.file)
  try {
    recordProcessHeartbeat(db, new Date(at).toISOString(), process)
  }
  finally {
    db.close()
  }
}

async function onceLines(bus: Bus): Promise<string[]> {
  const emitted: string[] = []
  const store = OnceStore.open(path.join(bus.dir, ONCE_STORE), { file: path.join(bus.dir, 'legacy.json'), text: undefined }, () => FROM_START)
  try {
    await deliverOnce(store, depsOf(bus, emitted), undefined, () => NOW)
  }
  finally {
    store.close()
  }
  return emitted.flatMap(line => line.split('\n'))
}

function downLines(lines: readonly string[], kind: string): string[] {
  return lines.filter(line => line.startsWith(`${kind}:`))
}

describe('miko:watch wakes the window on a factory that stopped', () => {
  it('a bus with no pulse for N minutes wakes the window with factory down', async () => {
    const bus = aBus()
    beat(bus, WORKER, NOW - FACTORY_DOWN_MS - MINUTE_MS)
    const lines = downLines(await onceLines(bus), FACTORY_DOWN)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`the last at ${new Date(NOW - FACTORY_DOWN_MS - MINUTE_MS).toISOString()}`)
    const deps = depsOf(bus)
    expect(downLines(tick(watchState(deps), deps, NOW), FACTORY_DOWN)).toEqual([])
  })

  it('a bus whose workers wrote no heartbeat for 10 minutes wakes the window with factory down and names miko start', () => {
    expect(FACTORY_DOWN_MS).toBe(10 * MINUTE_MS)
    const alive = aBus()
    beat(alive, WORKER, NOW - FACTORY_DOWN_MS + MINUTE_MS)
    const aliveDeps = depsOf(alive)
    expect(downLines(tick(watchState(aliveDeps), aliveDeps, NOW), FACTORY_DOWN)).toEqual([])
    const down = aBus()
    beat(down, WORKER, NOW - FACTORY_DOWN_MS - MINUTE_MS)
    beat(down, `${LOOP_PROCESS}window-loop`, NOW)
    const deps = depsOf(down)
    const state = watchState(deps)
    const woken = downLines(tick(state, deps, NOW), FACTORY_DOWN)
    expect(woken).toHaveLength(1)
    expect(woken[0]).toContain(`no bus worker wrote a heartbeat for 11 minutes`)
    expect(woken[0]).toContain(FACTORY_START)
    expect(downLines(tick(state, deps, NOW), FACTORY_DOWN)).toEqual([])
    const never = aBus()
    const neverDeps = depsOf(never)
    expect(downLines(tick(watchState(neverDeps), neverDeps, NOW), FACTORY_DOWN)).toEqual([])
  })

  it('a factory that came back and stopped again wakes the window again', () => {
    const bus = aBus()
    beat(bus, WORKER, NOW - FACTORY_DOWN_MS - MINUTE_MS)
    const deps = depsOf(bus)
    const state = watchState(deps)
    expect(downLines(tick(state, deps, NOW), FACTORY_DOWN)).toHaveLength(1)
    const later = NOW + 30 * MINUTE_MS
    beat(bus, WORKER, later - FACTORY_DOWN_MS - MINUTE_MS)
    expect(downLines(tick(state, deps, later), FACTORY_DOWN)).toHaveLength(1)
  })

  it('a live window session heartbeat does not mask a factory whose workers stopped', () => {
    const bus = aBus()
    beat(bus, WORKER, NOW - FACTORY_DOWN_MS - MINUTE_MS)
    write(bus, WINDOW_HEARTBEAT, { session: 'w-1' }, new Date(NOW).toISOString())
    const deps = depsOf(bus)
    expect(downLines(tick(watchState(deps), deps, NOW), FACTORY_DOWN)).toHaveLength(1)
  })

  it('a card session heartbeat does not count as a bus worker heartbeat', () => {
    const bus = aBus()
    beat(bus, WORKER, NOW - FACTORY_DOWN_MS - MINUTE_MS)
    write(bus, SESSION_HEARTBEAT, { session: 's1' }, new Date(NOW).toISOString())
    const deps = depsOf(bus)
    expect(downLines(tick(watchState(deps), deps, NOW), FACTORY_DOWN)).toHaveLength(1)
  })

  it('one long-dead worker beside a live worker does not wake the window', () => {
    const bus = aBus()
    beat(bus, 'worker:review:4243', NOW - FACTORY_DOWN_MS - 30 * MINUTE_MS)
    beat(bus, WORKER, NOW - MINUTE_MS)
    const deps = depsOf(bus)
    expect(downLines(tick(watchState(deps), deps, NOW), FACTORY_DOWN)).toEqual([])
  })

  it('a worker beat exactly N minutes old is still alive, and one a millisecond older is down', () => {
    const edge = aBus()
    beat(edge, WORKER, NOW - FACTORY_DOWN_MS)
    const edgeDeps = depsOf(edge)
    expect(downLines(tick(watchState(edgeDeps), edgeDeps, NOW), FACTORY_DOWN)).toEqual([])
    const past = aBus()
    beat(past, WORKER, NOW - FACTORY_DOWN_MS - 1)
    const pastDeps = depsOf(past)
    expect(downLines(tick(watchState(pastDeps), pastDeps, NOW), FACTORY_DOWN)).toHaveLength(1)
  })
})

function boardBeat(bus: Bus, at: number): void {
  const db = openBus(bus.file)
  try {
    recordBoardBeat(db, new Date(at).toISOString())
  }
  finally {
    db.close()
  }
}

describe('miko:watch wakes the window on a board timer that stopped beating', () => {
  it('a board page not rewritten for 3 board ticks wakes the window with board stale', async () => {
    expect(BOARD_STALE_TICKS).toBe(3)
    const fresh = aBus()
    boardBeat(fresh, NOW - BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS)
    const freshDeps = depsOf(fresh)
    expect(downLines(tick(watchState(freshDeps), freshDeps, NOW), BOARD_STALE)).toEqual([])
    const stale = aBus()
    beat(stale, WORKER, NOW)
    boardBeat(stale, NOW - BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS - 1)
    const deps = depsOf(stale)
    const state = watchState(deps)
    const woken = downLines(tick(state, deps, NOW), BOARD_STALE)
    expect(woken).toHaveLength(1)
    expect(woken[0]).toContain(`no beat for ${BOARD_STALE_TICKS} board ticks of 10 s, the last at ${new Date(NOW - BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS - 1).toISOString()}`)
    expect(downLines(tick(state, deps, NOW), FACTORY_DOWN)).toEqual([])
    expect(downLines(tick(state, deps, NOW), BOARD_STALE)).toEqual([])
    expect(downLines(await onceLines(stale), BOARD_STALE)).toHaveLength(1)
  })

  it('a board timer that beat again and stopped again wakes the window again, and a bus with no board beat does not', () => {
    const bus = aBus()
    boardBeat(bus, NOW - MINUTE_MS)
    const deps = depsOf(bus)
    const state = watchState(deps)
    expect(downLines(tick(state, deps, NOW), BOARD_STALE)).toHaveLength(1)
    const later = NOW + 30 * MINUTE_MS
    boardBeat(bus, later - MINUTE_MS)
    expect(downLines(tick(state, deps, later), BOARD_STALE)).toHaveLength(1)
    const never = aBus()
    const neverDeps = depsOf(never)
    expect(downLines(tick(watchState(neverDeps), neverDeps, NOW), BOARD_STALE)).toEqual([])
  })
})

function signalsOf(bus: Bus): (now: number) => readonly { kind: string }[] {
  const signals = productionDeps(bus.dir, bus.file).signals
  if (signals === undefined)
    throw new Error('productionDeps reads no signals')
  return signals
}

function boardStaleKinds(signals: readonly { kind: string }[]): string[] {
  return signals.map(signal => signal.kind).filter(kind => kind === BOARD_STALE)
}

const HEALTHY_BOARD_BEAT_AGE_MS = 14_500
const SECOND_MS = 1000

describe('miko:watch judges the board beat against the time it read it', () => {
  it('a beat fresh when read is not stale when the cached read is judged 29 s later', () => {
    const bus = aBus()
    boardBeat(bus, NOW - HEALTHY_BOARD_BEAT_AGE_MS)
    const signals = signalsOf(bus)
    expect(boardStaleKinds(signals(NOW))).toEqual([])
    expect(boardStaleKinds(signals(NOW + 29 * SECOND_MS))).toEqual([])
  })

  it('a board timer silent for more than three ticks still reads as stale', () => {
    const silent = aBus()
    boardBeat(silent, NOW - BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS - 1)
    expect(boardStaleKinds(signalsOf(silent)(NOW))).toEqual([BOARD_STALE])
    const fell = aBus()
    boardBeat(fell, NOW - HEALTHY_BOARD_BEAT_AGE_MS)
    const signals = signalsOf(fell)
    expect(boardStaleKinds(signals(NOW))).toEqual([])
    expect(boardStaleKinds(signals(NOW + 30 * SECOND_MS))).toEqual([BOARD_STALE])
  })
})

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
