import type { ParkedTask } from '../../../src/card/parking.js'
import type { World } from './fixtures/autopilot-world.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { choose, leftSummary, nextInPipeline, queueText } from '../../shift/parking.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, newWorld } from './fixtures/autopilot-world.js'

function parked(id: number, header: string, extra = ''): ParkedTask {
  const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends ${extra || '—'} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\n${header}\n\ndo ${id}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.parked
}

describe('choose', () => {
  it('takes the cards for the shift, p0 first and then by id, and names why every other card is left', () => {
    const cards = [
      parked(99, 'who: shift'),
      parked(19, 'who: shift'),
      parked(189, 'who: shift\npriority: p0'),
      parked(187, 'who: shift\npriority: p0'),
      parked(171, 'who: window'),
      parked(180, 'who: shift', '#179'),
      parked(178, 'who: shift'),
    ]
    const choice = choose(cards, new Set(['178']), new Set(['178']))
    expect(choice.chosen.map(task => task.id)).toEqual(['187', '189', '19', '99'])
    expect(choice.left).toEqual([
      { id: '171', reason: 'who window' },
      { id: '178', reason: 'closed' },
      { id: '180', reason: 'depends #179 not merged' },
    ])
  })

  it('names a closed card closed, whoever it was parked for', () => {
    expect(choose([parked(542, 'who: window')], new Set(['542']), new Set(['542'])).left).toEqual([{ id: '542', reason: 'closed' }])
  })

  it('takes a card whose depends are all closed', () => {
    expect(choose([parked(180, 'who: shift', '#179')], new Set(['179']), new Set(['179'])).chosen.map(task => task.id)).toEqual(['180'])
  })

  it('leaves a card that conflicts with one already taken, and keeps the one taken first', () => {
    const first = parked(1, 'who: shift')
    const second = parked(2, 'who: shift')
    const overlapping = { ...second, task: { ...second.task, touches: ['scripts/1/x.ts'] } }
    expect(choose([overlapping, first], new Set(), new Set())).toEqual({ chosen: [first.task], left: [{ id: '2', reason: 'conflicts with #1' }] })
  })
})

describe('leftSummary', () => {
  it('counts the cards left by reason, the largest first, keeping who apart and folding the ids of depends and conflicts', () => {
    const left = [
      { id: '1', reason: 'who window' },
      { id: '2', reason: 'closed' },
      { id: '3', reason: 'closed' },
      { id: '4', reason: 'depends #9 not merged' },
      { id: '5', reason: 'conflicts with #7' },
      { id: '6', reason: 'who owner' },
      { id: '8', reason: 'depends #10, #11 not merged' },
    ]
    expect(leftSummary(left)).toBe('left: 2 closed · 2 depends · 1 who window · 1 conflicts · 1 who owner')
  })

  it('says none when nothing is left', () => {
    expect(leftSummary([])).toBe('left: none')
  })

  it('writes the queue as one leaves line per card, closed ones included', () => {
    expect(queueText([{ id: '1', reason: 'closed' }, { id: '2', reason: 'who window' }])).toBe('leaves #1 (closed)\nleaves #2 (who window)\n')
  })
})

const HEAD = 'a1b2c3d'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function mergeOnOrigin(world: World, pr: number): void {
  const clone = path.join(world.root, `merge-${pr}`)
  git(world.root, ['clone', '-q', path.join(world.root, 'origin.git'), clone])
  writeFileSync(path.join(clone, `merged-${pr}.txt`), `${pr}\n`)
  git(clone, ['add', '.'])
  git(clone, ['commit', '-q', '-m', `merge PR #${pr}`])
  git(clone, ['push', '-q', 'origin', 'HEAD:main'])
}

function pipelineGh(world: World): (args: string[]) => string {
  const inner = fakeGh({ 101: cardLine(1), 102: cardLine(2) }).gh
  return (args) => {
    const fields = args.at(-1)
    if (args[1] === 'view' && fields === 'headRefName,headRefOid,state')
      return JSON.stringify({ headRefName: `feat/${Number(args[2]) - 100}`, headRefOid: HEAD, state: 'OPEN' })
    if (args[1] === 'view' && fields === 'headRefOid,statusCheckRollup,files')
      return JSON.stringify({ headRefOid: HEAD, statusCheckRollup: [], files: [] })
    if (args[1] === 'merge')
      mergeOnOrigin(world, Number(args[2]))
    return inner(args)
  }
}

function reviewPasses(world: World, pr: number): void {
  appendFileSync(world.journal, `${JSON.stringify({ event: 'pr-review', task: String(pr - 100), pr, verdict: 'pass', commit: HEAD, ts: '2026-10-06T02:00:00.000Z' })}\n`)
}

function steps(world: World): string[] {
  return eventsOf(world, 'chain').map(line => `${String(line.step)} ${String(line.task ?? line.reason)}`)
}

async function pipelineRun(world: World, onSleep: (slept: number) => void): Promise<number> {
  let slept = 0
  const sleep = (): Promise<void> => {
    onSleep(++slept)
    return Promise.resolve()
  }
  return runShift([world.shift, '--parking', world.parking, '--chain'], depsOf(world, pipelineGh(world), captured(), { sleep }))
}

const TWO = [{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' }]

function overlapCardTwo(world: World): void {
  const file = path.join(world.parking, '2.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('touches: scripts/2/**', 'touches: scripts/1/x.ts'))
}

describe('the chain as a pipeline', () => {
  it('takes the next card while the previous PR is open', async () => {
    const world = newWorld(TWO)
    expect(await pipelineRun(world, () => {
      reviewPasses(world, 101)
      reviewPasses(world, 102)
    })).toBe(0)
    expect(steps(world)).toEqual(['wait 1', 'next 2', 'wait 2', 'reviewed 1', 'reviewed 2', 'merged 1', 'merged 2', 'end no-eligible'])
    expect(eventsOf(world, 'stop')).toEqual([])
  })

  it('holds a card that overlaps one in review', async () => {
    const world = newWorld(TWO)
    overlapCardTwo(world)
    const before = git(world.repo, ['rev-parse', 'origin/main']).trim()
    const startedWhileHeld: boolean[] = []
    expect(await pipelineRun(world, (slept) => {
      startedWhileHeld.push(existsSync(path.join(world.root, 'mc-2')))
      if (slept === 2)
        reviewPasses(world, 101)
      if (slept > 2)
        reviewPasses(world, 102)
    })).toBe(0)
    expect(startedWhileHeld.slice(0, 2)).toEqual([false, false])
    expect(steps(world)).toEqual(['wait 1', 'reviewed 1', 'merged 1', 'next 2', 'wait 2', 'reviewed 2', 'merged 2', 'end no-eligible'])
    const base = git(path.join(world.root, 'mc-2'), ['log', '--format=%s', '-1', 'origin/main'])
    expect(base.trim()).toBe('merge PR #101')
    expect(git(path.join(world.root, 'mc-2'), ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('')
    expect(existsSync(path.join(world.root, 'mc-2', 'merged-101.txt'))).toBe(true)
    expect(before).not.toBe(git(world.repo, ['rev-parse', 'origin/main']).trim())
  })
})

describe('nextInPipeline', () => {
  const task = (id: number, touches: string[]): ParkedTask['task'] => ({ ...parked(id, 'who: shift').task, touches })

  it('takes the first card whose touches overlap no card in review', () => {
    const inReview = [{ task: task(1, ['scripts/1/**']), pr: 101 }]
    expect(nextInPipeline([task(2, ['scripts/1/x.ts']), task(3, ['scripts/3/**'])], new Set(), inReview)).toEqual({
      next: task(3, ['scripts/3/**']),
      held: [{ id: '2', reason: 'waits PR #101 of #1 in review' }],
    })
  })

  it('takes nothing when every card left overlaps one in review, and skips the cards already taken', () => {
    const inReview = [{ task: task(1, ['scripts/1/**']), pr: 101 }]
    expect(nextInPipeline([task(1, ['scripts/1/**']), task(2, ['scripts/1/y.ts'])], new Set(['1']), inReview)).toEqual({ next: undefined, held: [{ id: '2', reason: 'waits PR #101 of #1 in review' }] })
  })
})
