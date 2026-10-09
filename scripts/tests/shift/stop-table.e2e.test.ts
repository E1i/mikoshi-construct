import type { ParkedCard } from './fixtures/autopilot-world.js'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, newWorld } from './fixtures/autopilot-world.js'

interface Row {
  card: ParkedCard
  at: string | null
  why: string | RegExp | null
  worktree: boolean
}

const PROBE = 'probe/runner/S/cheap/none'
const OWNER = 'implement/runner/S/cheap/owner'

const ROWS: Record<string, Row> = {
  'a session that asks the owner a question stops at question with the question as its reason': { card: { id: 1, body: 'do 1 STUB-QUESTION STUB-NO-PR' }, at: 'question', why: 'which way, owner?', worktree: true },
  'a boundary under continue: stop stops at boundary naming the card line': { card: { id: 1, body: 'do 1 STUB-BOUNDARY STUB-NO-PR' }, at: 'boundary', why: /continue: stop/, worktree: true },
  'a boundary that outlives the restart limit stops at boundary naming the restarts': { card: { id: 1, header: 'continue: auto\n', body: 'do 1 STUB-BOUNDARY-ALWAYS STUB-NO-PR' }, at: 'boundary', why: /3 of 3 restarts used/, worktree: true },
  'an eddies warn under continue: stop stops at boundary': { card: { id: 1, body: 'do 1 STUB-WARN STUB-NO-PR' }, at: 'boundary', why: /eddies warn.*continue: stop/, worktree: true },
  'a session that exits 1 stops at fault': { card: { id: 1, body: 'do 1 STUB-FAIL' }, at: 'fault', why: 'exit 1', worktree: true },
  'a session that exits 0 with no report stops at fault': { card: { id: 1, body: 'do 1 STUB-SILENT' }, at: 'fault', why: 'exited 0 without a report', worktree: true },
  'a report that names no pull request stops at fault': { card: { id: 1, body: 'do 1 STUB-NO-PR' }, at: 'fault', why: 'the report names no pull request', worktree: true },
  'an eddies budget stop stops at fault': { card: { id: 1, body: 'do 1 STUB-STOP STUB-NO-PR' }, at: 'fault', why: 'eddies stop', worktree: true },
  'a card task:start refuses leaves no stop and no tree': { card: { id: 1, intake: false }, at: null, why: null, worktree: false },
  'a question beside an armed pull request still stops at question': { card: { id: 1, body: 'do 1 STUB-QUESTION STUB-VERIFIED-run STUB-PR-101' }, at: 'question', why: 'which way, owner?', worktree: true },
  'an owner card stops at merge naming the owner': { card: { id: 1, kind: OWNER, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, at: 'merge', why: /merge is Eli's/, worktree: true },
  'an auto card whose pull request is armed leaves no stop': { card: { id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, at: null, why: null, worktree: true },
  'a probe closed by its report leaves no stop': { card: { id: 1, kind: PROBE, body: 'do 1 STUB-PROBE-CLOSE' }, at: null, why: null, worktree: true },
  'a question card the probe closed writes no stop line': { card: { id: 1, kind: PROBE, body: 'do 1 STUB-QUESTION STUB-PROBE-CLOSE' }, at: null, why: null, worktree: true },
  'a probe whose report closes nothing stops at fault': { card: { id: 1, kind: PROBE, body: 'do 1' }, at: 'fault', why: 'the probe report closed no task', worktree: true },
}

describe('the stop table: where a card ends decides the stop line it leaves', () => {
  it.each(Object.entries(ROWS))('%s', async (_name, row) => {
    const world = newWorld([row.card])
    const { gh } = fakeGh({ 101: cardLine(1, row.card.kind) })
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured()))
    const stops = eventsOf(world, 'stop')
    if (row.at === null) {
      expect(stops).toEqual([])
      expect(existsSync(path.join(world.root, 'mc-1'))).toBe(row.worktree)
      return
    }
    expect(stops).toHaveLength(1)
    const [stop] = stops
    expect(stop).toMatchObject({ task: '1', at: row.at, shift: world.shift })
    expect(row.why instanceof RegExp ? row.why.test(String(stop!.why)) : String(stop!.why).includes(row.why as string)).toBe(true)
    expect(stop!.worktree).toBe(row.worktree ? path.join(world.root, 'mc-1') : null)
    expect(String(stop!.why)).not.toContain('\n')
    if (row.worktree)
      expect(existsSync(String(stop!.worktree))).toBe(true)
  })

  it('the stop line keeps its key order', async () => {
    const card = { id: 1, kind: OWNER, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }
    const world = newWorld([card])
    const { gh } = fakeGh({ 101: cardLine(1, card.kind) })
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured()))
    expect(eventsOf(world, 'stop').map(stop => Object.keys(stop))).toEqual([['event', 'task', 'at', 'why', 'worktree', 'shift', 'session', 'ts', 'pr']])
  })

  it('a claude that cannot be spawned stops at fault naming the error', async () => {
    const world = newWorld([{ id: 1 }])
    const { gh } = fakeGh({})
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured(), { run: async () => ({ kind: 'unspawnable', error: 'spawn claude ENOENT' }) }))
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: 'claude not spawned: spawn claude ENOENT', worktree: path.join(world.root, 'mc-1') }])
  })

  it('a standing stop leaves its card as waits <at> and a stop whose tree is gone does not', async () => {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-QUESTION STUB-NO-PR' }])
    const { gh } = fakeGh({})
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured()))
    const standing = captured()
    await runShift([path.join(world.root, 'check-1'), '--parking', world.parking, '--check', '--queue'], depsOf(world, gh, standing))
    expect(standing.out).toContain('[shift] parking: takes none')
    expect(standing.out).toContain('[shift] parking: leaves #1 (waits question)')
    rmSync(path.join(world.root, 'mc-1'), { recursive: true, force: true })
    const gone = captured()
    await runShift([path.join(world.root, 'check-2'), '--parking', world.parking, '--check'], depsOf(world, gh, gone))
    expect(gone.out).toContain('[shift] parking: takes #1')
  })
})
