import type { ParkedTask } from '../../../src/card/parking.js'
import type { ShiftDeps } from '../../shift/shift.js'
import type { World } from './fixtures/autopilot-world.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { reduce } from '../../bus/reducer.js'
import { MERGE_DONE } from '../../core/events.js'
import { choose, dependencyWaits, leftSummary, nextInPipeline, queueText, readParking, waitingLine } from '../../shift/parking.js'
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

function recordMergeDone(world: World, pr: number, commit: string): void {
  const db = openBus(world.bus)
  try {
    appendEvent(db, { ts: '2026-10-06T02:00:00.000Z', type: MERGE_DONE, actor: 'worker:merge:stub', cardId: pr - 100, pr, head: null, dedupeKey: `${MERGE_DONE}:${pr}`, payload: { commit, rule: 'auto' }, legacy: false })
    reduce(db)
  }
  finally {
    db.close()
  }
}

function pipelineGh(world: World): { gh: (args: string[]) => string, busMerge: ShiftDeps['busMerge'] } {
  const inner = fakeGh({ 101: cardLine(1), 102: cardLine(2) })
  return {
    gh: (args) => {
      const fields = args.at(-1)
      if (args[1] === 'view' && fields === 'headRefName,headRefOid,state')
        return JSON.stringify({ headRefName: `feat/${Number(args[2]) - 100}`, headRefOid: HEAD, state: 'OPEN' })
      if (args[1] === 'view' && fields === 'headRefOid,statusCheckRollup,files')
        return JSON.stringify({ headRefOid: HEAD, statusCheckRollup: [], files: [] })
      return inner.gh(args)
    },
    busMerge: (pr, head) => {
      mergeOnOrigin(world, pr)
      const merged = inner.bus(pr, head)
      if (merged.kind === 'merged')
        recordMergeDone(world, pr, merged.commit)
      return merged
    },
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
  const { gh, busMerge } = pipelineGh(world)
  return runShift([world.shift, '--parking', world.parking, '--chain'], depsOf(world, gh, captured(), { sleep, busMerge }))
}

const TWO = [{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101', touches: 'src/1/**' }, { id: 2, body: 'do 2 STUB-VERIFIED-run STUB-PR-102', touches: 'src/2/**' }]

function overlapCardTwo(world: World): void {
  const file = path.join(world.parking, '2.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('touches: src/2/**', 'touches: src/1/x.ts'))
}

describe('the chain as a pipeline', () => {
  it('takes the next card only after the previous PR merges, though their touches do not overlap', async () => {
    const world = newWorld(TWO)
    const startedWhileOpen: boolean[] = []
    expect(await pipelineRun(world, () => {
      startedWhileOpen.push(existsSync(path.join(world.root, 'mc-2')))
      reviewPasses(world, 101)
      reviewPasses(world, 102)
    })).toBe(0)
    expect(startedWhileOpen[0]).toBe(false)
    expect(steps(world)).toEqual(['wait 1', 'reviewed 1', 'merged 1', 'next 2', 'wait 2', 'reviewed 2', 'merged 2', 'end no-eligible'])
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

describe('dependencyWaits', () => {
  const started = (task: string): string => `${JSON.stringify({ event: 'path', task, path: 'cheap', started: '2026-10-11T00:00:00.000Z' })}\n`
  const merged = (task: string): string => `${JSON.stringify({ event: 'merge', task, pr: 100 + Number(task) })}\n`

  it('names every card left on open depends, and says whether one of them is in work: started and not merged', () => {
    const left = [
      { id: '7', reason: 'depends #5, #6 not merged' },
      { id: '8', reason: 'depends #6 not merged' },
      { id: '9', reason: 'depends #4 not merged' },
      { id: '10', reason: 'depends failed #5' },
      { id: '11', reason: 'who window' },
    ]
    expect(dependencyWaits(left, `${started('5')}${started('4')}${merged('4')}not json\n`)).toEqual([
      { id: '7', on: ['5', '6'], inWork: true },
      { id: '8', on: ['6'], inWork: false },
      { id: '9', on: ['4'], inWork: false },
    ])
    expect(waitingLine({ id: '7', on: ['5', '6'], inWork: true })).toBe('waiting on #5, #6')
  })

  it('reads a close line without started as no start', () => {
    const closed = `${JSON.stringify({ event: 'path', task: '5', path: 'cheap', verification: 'run' })}\n`
    expect(dependencyWaits([{ id: '7', reason: 'depends #5 not merged' }], closed)).toEqual([{ id: '7', on: ['5'], inWork: false }])
  })

  it('takes a depends the bus holds merged out of work, and a merge line after the journal half of history only through the bus', () => {
    const late = `${JSON.stringify({ event: 'merge', task: '6', pr: 106, ts: '2026-10-12T18:00:00.000Z' })}\n`
    const left = [{ id: '7', reason: 'depends #5 not merged' }, { id: '8', reason: 'depends #6 not merged' }]
    expect(dependencyWaits(left, `${started('5')}${started('6')}${late}`, new Map([['5', 'merged'], ['6', 'running']]))).toEqual([
      { id: '7', on: ['5'], inWork: false },
      { id: '8', on: ['6'], inWork: true },
    ])
  })
})

describe('readParking', () => {
  it('reads a depends as merged when the bus it is given holds the card closed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'read-parking-bus-'))
    try {
      const bus = path.join(root, 'bus.db')
      const db = openBus(bus)
      try {
        appendEvent(db, { ts: '2026-10-13T00:00:00.000Z', type: 'card.admitted', actor: 'worker:intake:test', cardId: 5, pr: null, head: null, dedupeKey: 'card.admitted:5', payload: {}, legacy: false })
        db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (5, \'closed\', NULL, 1)').run()
      }
      finally {
        db.close()
      }
      const card = 'card: #7 task-7 [implement/ghosts/S/cheap/owner] · depends #5 · blocks —\nbranch: feat/7\ntouches: scripts/7/**\nwho: shift\n\ndo 7\n'
      const reads = { cwd: root, handoffDir: root, listDir: () => ['7.md'], read: () => card, exists: (target: string) => target === bus, git: () => '' }
      expect(readParking(reads, root).choice.left).toEqual([{ id: '7', reason: 'depends #5 not merged' }])
      expect(readParking({ ...reads, bus }, root).choice.chosen.map(task => task.id)).toEqual(['7'])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('nextInPipeline', () => {
  const task = (id: number, touches: string[]): ParkedTask['task'] => ({ ...parked(id, 'who: shift').task, touches })

  it('takes no card while one is in review, whatever its touches, and names the review each card waits on', () => {
    const inReview = [{ task: task(1, ['scripts/1/**']), pr: 101 }]
    expect(nextInPipeline([task(2, ['scripts/1/x.ts']), task(3, ['scripts/3/**'])], new Set(), inReview)).toEqual({
      next: undefined,
      held: [{ id: '2', reason: 'waits PR #101 of #1 in review' }, { id: '3', reason: 'waits PR #101 of #1 in review' }],
    })
  })

  it('takes the first card not taken when nothing is in review', () => {
    expect(nextInPipeline([task(1, ['scripts/1/**']), task(2, ['scripts/2/**'])], new Set(['1']), [])).toEqual({ next: task(2, ['scripts/2/**']), held: [] })
  })

  it('takes nothing when every card left overlaps one in review, and skips the cards already taken', () => {
    const inReview = [{ task: task(1, ['scripts/1/**']), pr: 101 }]
    expect(nextInPipeline([task(1, ['scripts/1/**']), task(2, ['scripts/1/y.ts'])], new Set(['1']), inReview)).toEqual({ next: undefined, held: [{ id: '2', reason: 'waits PR #101 of #1 in review' }] })
  })
})
