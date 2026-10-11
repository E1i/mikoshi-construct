import type { DatabaseSync } from 'node:sqlite'
import type { Board, LaneParking, Watched } from '../../bus/board.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { renderBoard } from '../../bus/board-page.js'
import { MERGE_PAST_THE_BUS, readBoard } from '../../bus/board.js'
import { observeChain } from '../../bus/chain.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { MERGE_DONE } from '../../bus/executor.js'
import { importJournal } from '../../bus/import.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { completeTask, leaseNext } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { queueTask } from '../../bus/queue.js'
import { BusTick } from '../../bus/run.js'
import { choose } from '../../shift/parking.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const REVIEW_PID = 4242

interface BoardBench {
  db: DatabaseSync
  gitHub: FakeGitHub
  clock: Clock
  watched: Watched[]
  parking: LaneParking[]
  boards: Board[]
  tick: () => Board
  ts: () => string
}

const benches: { root: string, db: DatabaseSync }[] = []

afterEach(() => {
  for (const bench of benches.splice(0)) {
    bench.db.close()
    rmSync(bench.root, { recursive: true, force: true })
  }
})

function reviewWorker(pid: number | null): Watched {
  return { name: 'review', actor: 'worker:review:', queue: 'review', pid, wanted: true }
}

function boardBench(): BoardBench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-'))
  const db = openBus(path.join(root, 'bus.db'))
  benches.push({ root, db })
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const bench: BoardBench = { db, gitHub, clock, watched: [reviewWorker(REVIEW_PID)], parking: [], boards: [], tick: () => bench.boards.at(-1)!, ts: () => clock.now().toISOString() }
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now, () => {}, now => bench.boards.push(readBoard({ db, now, watched: bench.watched, parking: bench.parking })))
  bench.tick = () => {
    const before = bench.boards.length
    busTick.run()
    clock.advance(TICK_MS)
    expect(bench.boards.length).toBe(before + 1)
    return bench.boards.at(-1)!
  }
  return bench
}

function laneOf(lane: string, ...ids: number[]): LaneParking {
  const parked = ids.map((id) => {
    const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: shift\n\ndo ${id}\n`)
    if (parsed.kind === 'refused')
      throw new Error(parsed.reason)
    return parsed.parked
  })
  return { lane, dir: `/parking/${lane}`, choice: choose(parked, new Set(), new Set()) }
}

function healthOf(board: Board, name: string): string | undefined {
  return board.health.find(component => component.name === name)?.health
}

describe('the factory board', () => {
  it('the answer queue lists its leased task with holder, lease_gen and since, and its waiting tasks #849, #837, #847 in grant order', () => {
    const bench = boardBench()
    bench.tick()
    queueTask(bench.db, bench.ts(), { queue: 'answer', cardId: 835 })
    const leasedAt = bench.ts()
    expect(leaseNext(bench.db, leasedAt, 'answer', 'worker:answer:s1')?.cardId).toBe(835)
    for (const cardId of [849, 837, 847])
      queueTask(bench.db, bench.ts(), { queue: 'answer', cardId })
    const answer = bench.tick().queues.find(queue => queue.queue === 'answer')
    expect(answer?.leased).toEqual([{ taskKey: 'answer:835:-:-', card: 835, holder: 'worker:answer:s1', leaseGen: 1, since: leasedAt }])
    expect(answer?.waiting.map(task => task.card)).toEqual([849, 837, 847])
    const granted = leaseNext(bench.db, bench.ts(), 'answer', 'worker:answer:s2')
    expect(granted?.cardId).toBe(849)
  })

  it('a killed review worker reads red and marks the cards in review within two ticks', () => {
    const bench = boardBench()
    bench.gitHub.open({ number: 10 })
    bench.tick()
    expect(leaseNext(bench.db, bench.ts(), 'review', 'worker:review:s1')?.cardId).toBe(110)
    const living = bench.tick()
    expect(healthOf(living, 'review')).toBe('alive')
    expect(living.execution.find(row => row.card === 110)).toMatchObject({ pr: 10, stage: 'review', markers: [] })
    bench.watched = [reviewWorker(null)]
    const killed = [bench.tick(), bench.tick()]
    expect(killed.some(board => healthOf(board, 'review') === 'down' && board.execution.find(row => row.card === 110)?.markers.includes('review down'))).toBe(true)
    expect(renderBoard(killed[1]!)).toContain('<td data-tone="red">review down</td>')
  })

  it('a card taken into a lane leaves ready and appears in its lane within two ticks', () => {
    const bench = boardBench()
    bench.parking = [laneOf('lane-1', 850)]
    const before = bench.tick()
    expect(before.ready.map(card => card.card)).toEqual(['850'])
    expect(before.lanes).toEqual([{ lane: 'lane-1', card: null, state: null, since: null }])
    const takenAt = bench.ts()
    observeChain(bench.db, takenAt, 'worker:shift:s1', { dir: '/trees/mc-850', parking: '/parking/lane-1', cardId: 850, sha: sha('c'), pid: 99, leader: null, boundary: false, state: 'running' })
    const after = [bench.tick(), bench.tick()]
    expect(after.some(board => board.ready.length === 0 && board.lanes[0]?.card === 850)).toBe(true)
    expect(after[1]!.lanes).toEqual([{ lane: 'lane-1', card: 850, state: 'running', since: takenAt }])
    expect(after[1]!.execution.find(row => row.card === 850)?.stage).toBe('writing')
  })

  it('a worker with a pid but no fresh event reads unknown, not green', () => {
    const bench = boardBench()
    const idle = bench.tick()
    expect(healthOf(idle, 'review')).toBe('unknown')
    expect(idle.health.find(component => component.name === 'review')?.why).toContain(`pid ${REVIEW_PID}`)
    bench.gitHub.open({ number: 10 })
    bench.tick()
    leaseNext(bench.db, bench.ts(), 'review', 'worker:review:s1')
    expect(healthOf(bench.tick(), 'review')).toBe('alive')
    bench.clock.advance(2 * 60 * 60_000)
    bench.db.prepare('UPDATE tasks SET lease_until = ? WHERE queue = ?').run(bench.ts(), 'review')
    expect(healthOf(bench.tick(), 'review')).toBe('unknown')
  })

  it('no card advanced for thirty minutes reads no progress with its cause on its own line', () => {
    const bench = boardBench()
    appendEvent(bench.db, { ts: bench.ts(), type: CARD_STARTED, actor: 'policy', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_STARTED}:850`, payload: {}, legacy: false })
    expect(bench.tick().progress.stalled).toBe(false)
    bench.watched = [reviewWorker(null)]
    for (let minute = 0; minute < 29; minute++)
      expect(bench.tick().progress.stalled).toBe(false)
    const stalled = bench.tick()
    expect(stalled.progress).toMatchObject({ stalled: true, cause: 'down: review' })
    expect(renderBoard(stalled)).toContain('<p>cause: down: review</p>')
    bench.watched = [reviewWorker(REVIEW_PID)]
    bench.parking = [{ lane: 'lane-1', dir: '/parking/lane-1', choice: { chosen: [], left: [{ id: '851', reason: 'waits question' }] } }]
    expect(bench.tick().progress.cause).toBe('queue blocked: #851 waits question')
  })

  it('the bus contract row reads launch, Shard, automaton and writer red on a database with the counts of 2026-10-11', () => {
    const bench = boardBench()
    bench.gitHub.open({ number: 10 })
    bench.tick()
    importJournal(bench.db, `${JSON.stringify({ event: 'path', task: '850', ts: bench.ts() })}\n`)
    appendEvent(bench.db, { ts: bench.ts(), type: MERGE_DONE, actor: 'worker:merge:s1', cardId: 110, pr: 10, head: sha('a'), dedupeKey: `${MERGE_DONE}:10`, payload: { commit: sha('2'), rule: 'auto' }, legacy: false })
    queueTask(bench.db, bench.ts(), { queue: 'answer', cardId: 849 })
    completeTask(bench.db, bench.ts(), leaseNext(bench.db, bench.ts(), 'answer', 'worker:answer:s1')!, [])
    const contract = new Map(bench.tick().contract.map(link => [link.link, link]))
    expect([...contract.values()].filter(link => !link.green).map(link => link.link)).toEqual(['launch', 'Shard', 'automaton', 'one writer'])
    expect(contract.get('one writer')?.fact).toBe('no bus.cutover recorded')
    expect(contract.get('automaton')?.fact).toBe('0 pr.opened, 1 cards without state')
    expect(contract.get('replay')?.fact).toBe('matches')
  })

  it('a pull request merged with no merge.done reads merge past the bus', () => {
    const bench = boardBench()
    bench.gitHub.open({ number: 753 })
    bench.gitHub.open({ number: 754 })
    bench.tick()
    bench.gitHub.close(753, true)
    bench.gitHub.pulls.set(753, { ...bench.gitHub.pulls.get(753)!, merge_commit_sha: `1e18f06c${'0'.repeat(32)}` })
    bench.gitHub.close(754, true)
    appendEvent(bench.db, { ts: bench.ts(), type: MERGE_DONE, actor: 'worker:merge:s1', cardId: 854, pr: 754, head: sha('a'), dedupeKey: `${MERGE_DONE}:754`, payload: { commit: sha('2'), rule: 'auto' }, legacy: false })
    const execution = bench.tick().execution
    expect(execution.find(row => row.pr === 753)).toMatchObject({ card: 853, stage: `merged 1e18f06c${'0'.repeat(32)}`, markers: [MERGE_PAST_THE_BUS] })
    expect(execution.find(row => row.pr === 754)).toBeUndefined()
  })
})
