import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, lines, newWorld, stubRuns } from './fixtures/autopilot-world.js'

const LADDER = 'implement/runner/M/ladder/owner'
const CHEAP_OWNER = 'implement/runner/S/cheap/owner'
const THREE = [
  { id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' },
  { id: 2, kind: CHEAP_OWNER, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' },
  { id: 3, kind: LADDER, who: 'window', body: 'do 3 STUB-VERIFIED-run STUB-PR-103' },
]
const PR_CARDS = { 101: cardLine(1), 102: cardLine(2, CHEAP_OWNER), 103: cardLine(3, LADDER) }

async function threeCardShift(): Promise<{ world: ReturnType<typeof newWorld>, calls: string[][], io: ReturnType<typeof captured>, code: number }> {
  const world = newWorld(THREE)
  const { gh, calls } = fakeGh(PR_CARDS)
  const io = captured()
  const code = await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io))
  return { world, calls, io, code }
}

describe('the autopilot on a parking of three cards', () => {
  it('the cheap auto card reaches its merge on its own', async () => {
    const { world, calls, code } = await threeCardShift()
    expect(code).toBe(0)
    expect(calls.find(args => args[1] === 'merge')?.slice(0, 4)).toEqual(['pr', 'merge', '101', '--auto'])
    expect(eventsOf(world, 'merge').map(line => [line.task, line.pr])).toEqual([['1', 101]])
    expect(eventsOf(world, 'stop').filter(line => line.task === '1')).toEqual([])
  })

  it('the cheap owner card opens its pull request and stops at merge', async () => {
    const { world, calls } = await threeCardShift()
    expect(calls.filter(args => args[1] === 'merge').map(args => args[2])).toEqual(['101'])
    expect(eventsOf(world, 'stop').find(line => line.task === '2')).toMatchObject({ at: 'merge', pr: 102, worktree: path.join(world.root, 'mc-2'), shift: world.shift, session: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, ts: expect.stringMatching(/^2026-10-06T/) as unknown })
    expect(eventsOf(world, 'merge').map(line => line.task)).not.toContain('2')
  })

  it('a ladder owner card with who window is not taken and writes no stop', async () => {
    const { world, calls } = await threeCardShift()
    expect(eventsOf(world, 'path').filter(line => line.task === '3')).toEqual([])
    expect(existsSync(path.join(world.root, 'mc-3'))).toBe(false)
    expect(stubRuns(world, 3)).toBe(0)
    expect(calls.filter(args => args.some(arg => /\b(?:3|103)\b/.test(arg) || arg.includes('feat/3')))).toEqual([])
    expect(eventsOf(world, 'stop').find(line => line.task === '3')).toBeUndefined()
  })

  it('the stop journal holds exactly one stop line, with its reason', async () => {
    const { world } = await threeCardShift()
    const stops = eventsOf(world, 'stop')
    expect(stops.map(line => [line.task, line.at])).toEqual([['2', 'merge']])
    expect(stops.every(line => typeof line.why === 'string' && line.why.length > 10 && !line.why.includes('\n'))).toBe(true)
    expect(stops[0]!.why).toContain('merge is Eli\'s')
  })

  it('a rerun leaves the window ladder card as who window and writes no second stop line', async () => {
    const { world } = await threeCardShift()
    const io = captured()
    const rerun = path.join(world.root, 'shift-2')
    mkdirSync(rerun)
    const { gh } = fakeGh(PR_CARDS)
    const code = await runShift([rerun, '--parking', world.parking, '--queue'], depsOf(world, gh, io))
    expect(code).toBe(1)
    expect(io.out).toContain('[shift] parking: leaves #3 (who window)')
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  it('the autopilot line says on, once, between the start line and the first task line', async () => {
    const { world } = await threeCardShift()
    const journal = lines(path.join(world.shift, 'shift.jsonl'))
    expect(journal.map(line => line.event)).toEqual(['start', 'autopilot', 'task', 'task'])
    expect(journal[1]).toMatchObject({ event: 'autopilot', state: 'on', shift: world.shift, ts: expect.stringMatching(/^2026-10-06T/) as unknown })
  })

  it('--check writes no stop line and no autopilot line', async () => {
    const world = newWorld(THREE)
    const before = lines(world.journal)
    const { gh } = fakeGh(PR_CARDS)
    expect(await runShift([world.shift, '--parking', world.parking, '--check'], depsOf(world, gh, captured()))).toBe(0)
    expect(lines(world.journal)).toEqual(before)
    expect(existsSync(path.join(world.shift, 'shift.jsonl'))).toBe(false)
  })
})

describe('--manual', () => {
  it('--manual with no terminal takes nothing: no start line, no tree, no session', async () => {
    const world = newWorld(THREE)
    const { gh, calls } = fakeGh(PR_CARDS)
    const io = captured()
    expect(await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, io))).toBe(0)
    expect(eventsOf(world, 'path')).toEqual([])
    expect([1, 2].map(id => stubRuns(world, id))).toEqual([0, 0])
    expect([1, 2].map(id => existsSync(path.join(world.root, `mc-${id}`)))).toEqual([false, false])
    expect(calls.filter(args => args[1] === 'merge')).toEqual([])
    expect(io.out).toContain('[shift] 1.md 1: not taken, not confirmed (--manual)')
  })

  it('--manual takes the card a yes is given for and no other', async () => {
    const world = newWorld(THREE)
    const { gh } = fakeGh(PR_CARDS)
    const asked: string[] = []
    const confirm = async (question: string): Promise<boolean> => {
      asked.push(question)
      return question.startsWith('take #2')
    }
    await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, captured(), { confirm }))
    expect(asked.map(question => question.split(' ')[1])).toEqual(['#1', '#2'])
    expect([1, 2].map(id => stubRuns(world, id))).toEqual([0, 1])
    expect(eventsOf(world, 'path').map(line => line.task)).toEqual(['2', '2'])
  })

  it('--manual writes an autopilot line that says off, and the next run without it says on', async () => {
    const world = newWorld(THREE)
    const { gh } = fakeGh(PR_CARDS)
    await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, captured()))
    const next = path.join(world.root, 'shift-2')
    mkdirSync(next)
    await runShift([next, '--parking', world.parking], depsOf(world, gh, captured()))
    expect([world.shift, next].map(dir => lines(path.join(dir, 'shift.jsonl')).find(line => line.event === 'autopilot')?.state)).toEqual(['off', 'on'])
  })

  it('a run without --manual never calls confirm', async () => {
    const world = newWorld(THREE)
    const { gh } = fakeGh(PR_CARDS)
    let asked = 0
    const confirm = async (): Promise<boolean> => {
      asked++
      return false
    }
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured(), { confirm }))
    expect(asked).toBe(0)
    expect(stubRuns(world, 1)).toBe(1)
  })

  it('--manual does not change what the merge rules arm: a confirmed auto card is armed', async () => {
    const world = newWorld(THREE)
    const { gh, calls } = fakeGh(PR_CARDS)
    await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, captured(), { confirm: async () => true }))
    expect(calls.filter(args => args[1] === 'merge').map(args => args[2])).toEqual(['101'])
  })
})

describe('the handoff is picked up by a new session', () => {
  const CONTINUING = [{ id: 1, header: 'continue: auto\n', body: 'do 1 STUB-BOUNDARY STUB-NO-PR' }]

  it('a continue: auto card at a boundary is followed by a new session without a human', async () => {
    const world = newWorld(CONTINUING)
    const { gh } = fakeGh({})
    let asked = 0
    const confirm = async (): Promise<boolean> => {
      asked++
      return true
    }
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, captured(), { confirm }))
    expect(stubRuns(world, 1)).toBe(2)
    expect(asked).toBe(0)
  })

  it('under --manual a continuation waits for a yes and a no ends the card at a boundary stop', async () => {
    const world = newWorld(CONTINUING)
    const { gh } = fakeGh({})
    const asked: string[] = []
    const confirm = async (question: string): Promise<boolean> => {
      asked.push(question)
      return question.startsWith('take')
    }
    await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, captured(), { confirm }))
    expect(stubRuns(world, 1)).toBe(1)
    expect(asked.map(question => question.split(' ')[0])).toEqual(['take', 'continue'])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'boundary', worktree: path.join(world.root, 'mc-1') }])
    expect(eventsOf(world, 'stop')[0]!.why).toContain('not confirmed')
  })

  it('under --manual a continuation with a yes starts the new session', async () => {
    const world = newWorld([{ id: 1, header: 'continue: auto\n', body: 'do 1 STUB-BOUNDARY STUB-NO-PR' }])
    const { gh } = fakeGh({})
    await runShift([world.shift, '--parking', world.parking, '--manual'], depsOf(world, gh, captured(), { confirm: async () => true }))
    expect(stubRuns(world, 1)).toBe(2)
  })
})
