import type { DatabaseSync } from 'node:sqlite'
import type { GateRun } from '../../ci/gate-runs.js'
import type { Poll } from '../../ports/netwatch.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_RUN_SPOOL, gateRunEvent } from '../../ci/gate-runs.js'
import { openBus } from '../../core/db.js'
import { GATE_RUN } from '../../core/events.js'
import { REQUIRED_CHECK } from '../../ports/gh.js'
import { NetWatch } from '../../ports/netwatch.js'
import { cardTreeRoots } from '../../ports/worktree-home.js'
import { RUN_SCRIPT } from '../../supervisor/bg.js'
import { busPrFolds, gateRunSpoolPlaces } from '../../supervisor/composition.js'
import { GateRunSpool } from '../../supervisor/gate-run-spool.js'
import { BusTick, PREFIX, TICK_STEPS, tickLines } from '../../supervisor/run.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const TS = '2026-11-18T00:00:00.000Z'
const RUN: GateRun = { source: 'prepush', mode: 'layered', reason: 'touched layers', seconds: 42, round: null, card: 2011, moduleFiles: false, tests: 3 }

class NetWatchThatTicks extends NetWatch {
  override poll(): Poll {
    return { kind: 'ticked', reason: 'interval', calls: 0, remaining: null, written: 0, unsettled: [] }
  }
}

const buses: DatabaseSync[] = []
const dirs: string[] = []

afterEach(() => {
  for (const bus of buses.splice(0))
    bus.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-run-spool-'))
  dirs.push(dir)
  return dir
}

function spoolIn(root: string, tree: string, lines: readonly string[]): string {
  const file = path.join(root, tree, GATE_RUN_SPOOL)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.map(line => `${line}\n`).join(''))
  return file
}

function spooledLine(run: GateRun = RUN, ts: string = TS): string {
  return JSON.stringify(gateRunEvent(run, ts))
}

function tickOver(root: string): { db: DatabaseSync, tick: () => string[] } {
  const db = openBus(':memory:')
  buses.push(db)
  const clock = new Clock()
  const spool = new GateRunSpool(db, { homes: [root], spool: GATE_RUN_SPOOL }, PREFIX)
  const busTick = new BusTick(db, { folds: [busPrFolds()], incremental: [] }, new NetWatchThatTicks(db, new FakeGitHub().client, clock.now, RUN_SCRIPT, () => REQUIRED_CHECK), clock.now, () => {}, () => {}, () => {}, () => spool.step())
  return { db, tick: () => tickLines(busTick.run()!) }
}

function gateRuns(db: DatabaseSync): { dedupe_key: string, card_id: number | null, payload: string }[] {
  return db.prepare('SELECT dedupe_key, card_id, payload FROM events WHERE type = ?').all(GATE_RUN).map(row => ({ ...row })) as { dedupe_key: string, card_id: number | null, payload: string }[]
}

describe('the bus tick imports the gate-run spools of the card trees', () => {
  it('a spooled gate-run line becomes one gate.run event on the tick', () => {
    const root = home()
    const file = spoolIn(root, '2011', [spooledLine()])
    const { db, tick } = tickOver(root)
    const lines = tick()
    const runs = gateRuns(db)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.dedupe_key).toBe(gateRunEvent(RUN, TS).dedupeKey)
    expect(runs[0]!.card_id).toBe(2011)
    expect(JSON.parse(runs[0]!.payload)).toMatchObject({ source: 'prepush', seconds: 42 })
    expect(existsSync(file)).toBe(false)
    expect(lines).toContain(`${PREFIX}${GATE_RUN} spool ${file}: imported 1, already on the bus 0`)
  })

  it('a second tick does not duplicate an imported gate run', () => {
    const root = home()
    const file = spoolIn(root, '2011', [spooledLine()])
    const { db, tick } = tickOver(root)
    tick()
    expect(tick().some(line => line.includes(GATE_RUN))).toBe(false)
    spoolIn(root, '2011', [spooledLine()])
    const lines = tick()
    expect(gateRuns(db)).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
    expect(lines).toContain(`${PREFIX}${GATE_RUN} spool ${file}: imported 0, already on the bus 1`)
  })

  it('a spool line that does not parse stays in the spool and is named in the tick lines', () => {
    const root = home()
    const second = spooledLine({ ...RUN, seconds: 7 }, '2026-11-18T00:01:00.000Z')
    const file = spoolIn(root, '2011', ['{not json', spooledLine(), JSON.stringify({ type: 'card.started' }), second])
    const { db, tick } = tickOver(root)
    const lines = tick()
    expect(gateRuns(db)).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).toBe(`{not json\n${JSON.stringify({ type: 'card.started' })}\n`)
    expect(lines.filter(line => line.includes('left in place'))).toEqual([
      expect.stringContaining(`${file}: line 1 left in place, not JSON`),
      expect.stringContaining(`${file}: line 3 left in place, not a ${GATE_RUN} event`),
    ])
    tick()
    expect(gateRuns(db)).toHaveLength(2)
    expect(existsSync(file)).toBe(true)
  })

  it('the spools of every tree under every root are read, and a line still being written waits for the next tick', () => {
    const [one, two] = [home(), home()]
    const first = spoolIn(one, 'a', [spooledLine()])
    const later = spooledLine({ ...RUN, card: 12 }, '2026-11-18T00:02:00.000Z')
    const partial = path.join(two, 'b', GATE_RUN_SPOOL)
    mkdirSync(path.dirname(partial), { recursive: true })
    writeFileSync(partial, `${spooledLine({ ...RUN, card: 11 }, '2026-11-18T00:03:00.000Z')}\n${later.slice(0, 10)}`)
    const db = openBus(':memory:')
    buses.push(db)
    new GateRunSpool(db, { homes: [one, two, path.join(two, 'missing')], spool: GATE_RUN_SPOOL }, PREFIX).step()
    expect(gateRuns(db).map(run => run.card_id).sort()).toEqual([11, 2011])
    expect(existsSync(first)).toBe(false)
    expect(readFileSync(partial, 'utf8')).toBe(later.slice(0, 10))
  })

  it('a spool that cannot be read is named in the tick lines and the tick goes on', () => {
    const root = home()
    const unreadable = path.join(root, 'c', GATE_RUN_SPOOL)
    mkdirSync(unreadable, { recursive: true })
    const { db, tick } = tickOver(root)
    expect(tick()).toContainEqual(expect.stringContaining(`${GATE_RUN} spool ${unreadable}: not imported this tick, it stays in place`))
    expect(gateRuns(db)).toHaveLength(0)
    expect(existsSync(unreadable)).toBe(true)
  })

  it('the spool step is timed with the others and the bus tick reads the roots cardTreeRoots names', () => {
    expect(TICK_STEPS).toContain('GateRunSpool')
    const bus = path.join(home(), 'bus', 'bus.db')
    const repo = path.join(home(), 'repo')
    expect(gateRunSpoolPlaces({}, bus, repo)).toEqual({ homes: cardTreeRoots({}, bus, repo).homes, spool: GATE_RUN_SPOOL })
  })
})
