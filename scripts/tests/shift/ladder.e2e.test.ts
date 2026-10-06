import type { Captured, World } from './fixtures/autopilot-world.js'
import type { Ladder, Launch, Morse } from './fixtures/ladder-world.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { approvedHashPath } from '../../ghosts/approval.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, eventsOf, fakeGh, lines, newWorld, stubRuns } from './fixtures/autopilot-world.js'
import { approvalLine, approve, approvedFile, briefOf, briefWritten, cardNameOf, LADDER, ladderDeps, ladderPnpm, revokeLine } from './fixtures/ladder-world.js'

const BODY = 'do 1 STUB-BRIEF-WRITE STUB-VERIFIED-run STUB-PR-101'
const PR_CARDS = { 101: cardLine(1, LADDER) }

interface Run {
  world: World
  ladder: Ladder
  io: Captured
  code: number
  calls: string[][]
}

async function shiftOver(world: World, behaviour: { morse?: Morse, launch?: Launch, ghostWrites?: boolean } = {}, dir = world.shift): Promise<Run> {
  const ladder = ladderPnpm(world, 1, behaviour)
  const { gh, calls } = fakeGh(PR_CARDS)
  const io = captured()
  const code = await runShift([dir, '--parking', world.parking], ladderDeps(world, gh, io, ladder))
  return { world, ladder, io, code, calls }
}

function newLadderWorld(who = 'shift'): World {
  return newWorld([{ id: 1, kind: LADDER, who, body: BODY }])
}

function startLines(world: World): Record<string, unknown>[] {
  return eventsOf(world, 'path').filter(line => line.worktree !== undefined)
}

function startedTreeOf(world: World): string {
  return String(eventsOf(world, 'path').find(line => line.task === '1')?.worktree)
}

describe('a ladder card in a shift', () => {
  it('shift takes a ladder card with who shift: it cuts the tree and runs the brief session', async () => {
    const world = newLadderWorld()
    const { ladder } = await shiftOver(world, { morse: 'refuses' })
    expect(eventsOf(world, 'path').map(line => [line.task, line.path])).toEqual([['1', 'ladder']])
    expect(existsSync(path.join(world.root, 'mc-1'))).toBe(true)
    expect(stubRuns(world, 1)).toBe(1)
    expect(briefWritten(world, 1)).toBe(true)
    expect(ladder.calls.map(call => call.args[0])).toEqual(['ghosts:hash'])
  })

  it('shift takes a ladder card with who shift: no stop is written for it before it is taken', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'approves', launch: 'running' })
    expect(eventsOf(world, 'stop')).toEqual([])
  })

  it('a ladder card with who window is not taken', async () => {
    const world = newLadderWorld('window')
    const { code, ladder } = await shiftOver(world)
    expect(code).toBe(1)
    expect(eventsOf(world, 'path')).toEqual([])
    expect(ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop')).toEqual([])
  })

  it('the brief step asks MORSE for the approval after the session exits, with the card and the parking', async () => {
    const world = newLadderWorld()
    const { ladder } = await shiftOver(world, { morse: 'refuses' })
    expect(ladder.calls[0]!.args).toEqual(['ghosts:hash', briefOf(world, 1), '--by', 'morse', '--card', '1', '--parking', world.parking])
    expect(ladder.calls[0]!.input).toBeUndefined()
  })

  it('the brief session is told the brief path, never to write an approval file and never to pass --by', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    const prompt = readFileSync(path.join(world.stubOut, 'mc-1.prompt'), 'utf8')
    expect(prompt).toContain(`write the brief to \`${briefOf(world, 1)}\``)
    expect(prompt).toContain('Never write an `.approved-sha256` file')
    expect(prompt).toContain(`pnpm ghosts:hash ${briefOf(world, 1)}\` (no \`--by\`)`)
  })

  it('the brief step with no pnpm runner wired stops at fault and not at hash', async () => {
    const world = newLadderWorld()
    const { gh } = fakeGh(PR_CARDS)
    const ladder = ladderPnpm(world, 1)
    await runShift([world.shift, '--parking', world.parking], ladderDeps(world, gh, captured(), ladder, { pnpm: undefined }))
    expect(ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: 'no pnpm runner is wired into this shift' }])
  })

  it('a brief session that wrote no brief stops at fault and asks nobody for an approval', async () => {
    const world = newWorld([{ id: 1, kind: LADDER, body: 'do 1 STUB-NO-PR' }])
    const { ladder } = await shiftOver(world)
    expect(ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: `the brief session wrote no brief at ${briefOf(world, 1)}`, worktree: path.join(world.root, 'mc-1') }])
  })

  it('a brief session that asks the owner a question stops at question and asks MORSE for nothing', async () => {
    const world = newWorld([{ id: 1, kind: LADDER, body: 'do 1 STUB-BRIEF-WRITE STUB-QUESTION STUB-NO-PR' }])
    const { ladder } = await shiftOver(world)
    expect(ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'question', why: 'which way, owner?' }])
  })

  it('a brief session that exits 1 stops at fault and asks MORSE for nothing', async () => {
    const world = newWorld([{ id: 1, kind: LADDER, body: 'do 1 STUB-BRIEF-WRITE STUB-FAIL' }])
    const { ladder } = await shiftOver(world)
    expect(ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'fault', why: 'exit 1' }])
  })

  it('the ladder walks brief, launch and review in one tree and stops at the owner merge', async () => {
    const world = newLadderWorld()
    const { ladder, calls } = await shiftOver(world)
    expect(ladder.calls.map(call => call.args[0])).toEqual(['ghosts:hash', 'ghosts:launch'])
    expect(startLines(world)).toHaveLength(1)
    expect(stubRuns(world, 1)).toBe(2)
    expect(lines(path.join(world.shift, 'shift.jsonl')).find(line => line.event === 'task')).toMatchObject({ steps: ['brief', 'launch', 'review'], worktree: startedTreeOf(world), exit: 0 })
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101, worktree: startedTreeOf(world) }])
    expect(calls.filter(args => args[1] === 'merge')).toEqual([])
    expect(readFileSync(path.join(world.stubOut, 'mc-1.prompt.2'), 'utf8')).toContain('Ladder route, step 3 of 3')
  })
})

describe('an R1 brief waits in the owner queue', () => {
  it('an R1 brief waits in the owner queue: the hash stop names the tree, the last session and the refusal', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    const stops = eventsOf(world, 'stop')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({ task: '1', at: 'hash', worktree: path.join(world.root, 'mc-1'), session: readFileSync(path.join(world.stubOut, 'mc-1.session'), 'utf8').trim(), shift: world.shift })
    expect(stops[0]!.why).toBe(`ladder card: MORSE approves an R2–R4 brief (ghosts:hash --by morse), the owner approves an R1 brief: the brief waits for the owner: card #1 is R1 (it touches the runner)`)
  })

  it('an R1 brief waits in the owner queue: a rerun leaves it as waits hash, writes no second stop and starts no session', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    const rerun = path.join(world.root, 'shift-2')
    const second = await shiftOver(world, { morse: 'refuses' }, rerun)
    expect(second.code).toBe(1)
    expect(second.io.out).toContain('[shift] parking: takes none')
    expect(second.ladder.calls).toEqual([])
    expect(stubRuns(world, 1)).toBe(1)
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  it('an R1 brief waits in the owner queue: the shift writes no approval file and launches nothing', async () => {
    const world = newLadderWorld()
    const { ladder } = await shiftOver(world, { morse: 'refuses' })
    expect(existsSync(approvedHashPath(briefOf(world, 1)))).toBe(false)
    expect(ladder.calls.some(call => call.args[0] === 'ghosts:launch')).toBe(false)
    expect(existsSync(path.join(world.handoff, 'tasks-1-task-1.json'))).toBe(false)
  })

  it('an R1 brief waits in the owner queue until the owner approves it, and then the next run goes on', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    approve(world, 1)
    const next = await shiftOver(world, { launch: 'running' }, path.join(world.root, 'shift-2'))
    expect(next.ladder.calls.map(call => call.args[0])).toEqual(['ghosts:launch'])
    expect(stubRuns(world, 1)).toBe(1)
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  async function heldAfter(world: World, change: () => void): Promise<Run> {
    await shiftOver(world, { morse: 'refuses' })
    change()
    return shiftOver(world, { launch: 'running' }, path.join(world.root, 'shift-2'))
  }

  it('an R1 brief waits in the owner queue: an .approved-sha256 file for the current hash with no approval event leaves it waits hash', async () => {
    const world = newLadderWorld()
    const next = await heldAfter(world, () => approvedFile(world, 1))
    expect(next.io.out).toContain('[shift] parking: takes none')
    expect(next.ladder.calls).toEqual([])
    expect(stubRuns(world, 1)).toBe(1)
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  it('an R1 brief waits in the owner queue: a revoke after the approval leaves it held', async () => {
    const world = newLadderWorld()
    const next = await heldAfter(world, () => {
      approve(world, 1)
      appendFileSync(world.journal, revokeLine(1))
    })
    expect(next.ladder.calls).toEqual([])
    expect(next.io.out).toContain('[shift] parking: takes none')
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  it('an R1 brief waits in the owner queue: an approval event for an older hash leaves it held', async () => {
    const world = newLadderWorld()
    const next = await heldAfter(world, () => {
      approvedFile(world, 1)
      appendFileSync(world.journal, approvalLine(1, 'owner', '0'.repeat(64)))
    })
    expect(next.ladder.calls).toEqual([])
    expect(next.io.out).toContain('[shift] parking: takes none')
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })
})

describe('an approved brief is launched by the next step', () => {
  async function approvedWorld(behaviour: { launch?: Launch, ghostWrites?: boolean } = {}): Promise<Run> {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    approve(world, 1)
    return shiftOver(world, behaviour, path.join(world.root, 'shift-2'))
  }

  it('an approved brief is launched by the next step: the tasks file is written and ghosts:launch gets a yes on stdin, with no session', async () => {
    const { world, ladder } = await approvedWorld({ launch: 'running' })
    const file = path.join(world.handoff, 'tasks-1-task-1.json')
    expect(ladder.calls.at(-1)).toEqual({ args: ['ghosts:launch', '--tasks', file], input: 'yes\n' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ repo: world.repo, status: path.join(world.handoff, 'status.md'), out: world.handoff, tasks: [{ id: cardNameOf(1), brief: briefOf(world, 1), card: cardLine(1, LADDER) }] })
    expect(stubRuns(world, 1)).toBe(1)
  })

  it('an approved brief is launched by the next step: a Ghost still running leaves the card with no stop and no new session', async () => {
    const { world, io } = await approvedWorld({ launch: 'running' })
    expect(io.out).toContain('[shift] 1.md 1: ladder launch → running')
    expect(eventsOf(world, 'stop')).toHaveLength(1)
    const again = await shiftOver(world, { launch: 'running' }, path.join(world.root, 'shift-3'))
    expect(again.ladder.calls).toEqual([])
    expect(again.io.out).toContain('[shift] 1.md 1: ghost running')
    expect(stubRuns(world, 1)).toBe(1)
    expect(eventsOf(world, 'stop')).toHaveLength(1)
  })

  it('an approved brief is launched by the next step: a launch that exits non-zero stops at fault with its first stderr line', async () => {
    const { world } = await approvedWorld({ launch: 'exit' })
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ task: '1', at: 'fault', why: 'task task-1: refused by the launcher', worktree: path.join(world.root, 'mc-1') })
  })

  it('an approved brief is launched by the next step: a ladder status other than done stops at fault naming it', async () => {
    const { world } = await approvedWorld({ launch: { ladder: 'stopped' } })
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'fault', why: `the Ghost ended with ladder status 'stopped'` })
    expect(stubRuns(world, 1)).toBe(1)
  })

  it('an approved brief is launched by the next step: a done Ghost goes on to the review in the same tree with no second task:start', async () => {
    const { world, ladder } = await approvedWorld({ launch: 'done' })
    expect(ladder.calls.map(call => call.args[0])).toEqual(['ghosts:launch'])
    expect(startLines(world)).toHaveLength(1)
    expect(stubRuns(world, 1)).toBe(2)
    expect(readFileSync(path.join(world.stubOut, 'mc-1.cwd'), 'utf8').trim()).toBe(path.join(world.root, 'mc-1'))
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'merge', pr: 101 })
  })

  it('an approved brief is launched by the next step: the tree the Ghost left dirty is reviewed, not refused', async () => {
    const { world } = await approvedWorld({ launch: 'done', ghostWrites: true })
    expect(stubRuns(world, 1)).toBe(2)
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'merge', pr: 101 })
  })

  it('an approved brief is launched by the next step: a launch that wrote no entry stops at fault instead of looping', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    approve(world, 1)
    const ladder = ladderPnpm(world, 1)
    const noEntry: Ladder = { calls: ladder.calls, pnpm: () => ({ code: 0, stdout: '', stderr: '' }) }
    const { gh } = fakeGh(PR_CARDS)
    await runShift([path.join(world.root, 'shift-2'), '--parking', world.parking], ladderDeps(world, gh, captured(), noEntry))
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'fault', why: 'the launch step did not advance the card' })
  })

  it('an approved brief is launched by the next step: a tree that is gone stops at fault and a dirty tree too', async () => {
    const world = newLadderWorld()
    await shiftOver(world, { morse: 'refuses' })
    approve(world, 1)
    const tree = path.join(world.root, 'mc-1')
    writeFileSync(path.join(tree, 'dirty.txt'), 'x\n')
    const dirty = await shiftOver(world, { launch: 'running' }, path.join(world.root, 'shift-2'))
    expect(dirty.ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'fault', why: `the tree ${tree} has 1 changed paths` })
    execFileSync('git', ['-C', world.repo, 'worktree', 'remove', '--force', tree])
    const gone = await shiftOver(world, { launch: 'running' }, path.join(world.root, 'shift-3'))
    expect(gone.ladder.calls).toEqual([])
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ at: 'fault', why: `the tree ${tree} does not exist` })
  })
})
