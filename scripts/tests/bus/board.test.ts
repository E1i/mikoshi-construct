import type { BoardData, BoardFiles } from '../../bus/board-page.js'
import type { Board, LeaseOrders, Watched } from '../../bus/board.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { busFacts } from '../../../src/commands/board/bus.js'
import { backlogCards } from '../../../src/commands/board/screens.js'
import { answerLeaseOrder } from '../../bus/answer-worker.js'
import { BOARD_DATA_FILE, boardProjection, DISK_FILES, printBoard, runBoardCli } from '../../bus/board-page.js'
import { cardGauges, MERGE_PAST_THE_BUS, readBoard, SILENT_PROCESS, windowGauges } from '../../bus/board.js'
import { DROPPED_LANE, MERGED_CARD } from '../../bus/card-automaton.js'
import { observeChain } from '../../bus/chain.js'
import { appendEvent, defaultBusPath, openBus } from '../../bus/db.js'
import { busSessionPulse, recordHeartbeat, recordProcessHeartbeat } from '../../bus/heartbeat.js'
import { importJournal } from '../../bus/import.js'
import { OWNER, RESTART_MISSED } from '../../bus/inbox.js'
import { completeTask, leaseNext, leaseWhileFree } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { queueTask } from '../../bus/queue.js'
import { PLAN_FOLDS } from '../../bus/reducer.js'
import { busReviewPulse } from '../../bus/review-worker.js'
import { BusTick } from '../../bus/run.js'
import { windowShardEnded } from '../../bus/shards.js'
import { storedByKey } from '../../bus/stored.js'
import { recordJudged } from '../../bus/supervisor.js'
import { recordWindowHeartbeat } from '../../bus/window-heartbeat.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED, CARD_STARTED, CARD_STOPPED, MERGE_DONE, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_OPENED, RESTARTED, SHARD_ISSUED, SHARD_REVOKED } from '../../core/events.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'
import { detectReview } from './review-detection.js'

const REVIEW_PID = 4242

interface BoardBench {
  db: DatabaseSync
  gitHub: FakeGitHub
  clock: Clock
  watched: Watched[]
  leaseOrders: LeaseOrders
  boards: Board[]
  tick: () => Board
  ts: () => string
}

const benches: { root: string, db: DatabaseSync }[] = []

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
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
  const bench: BoardBench = { db, gitHub, clock, watched: [reviewWorker(REVIEW_PID)], leaseOrders: {}, boards: [], tick: () => bench.boards.at(-1)!, ts: () => clock.now().toISOString() }
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now, () => {}, now => bench.boards.push(readBoard({ db, now, watched: bench.watched, leaseOrders: bench.leaseOrders })))
  bench.tick = () => {
    const before = bench.boards.length
    busTick.run()
    detectReview({ db, gitHub, clock })
    clock.advance(TICK_MS)
    expect(bench.boards.length).toBe(before + 1)
    return bench.boards.at(-1)!
  }
  return bench
}

function healthOf(board: Board, name: string): string | undefined {
  return board.health.find(component => component.name === name)?.health
}

interface BodyColumns {
  lane: string
  depends?: number[]
  priority?: string | null
  who?: string
  state?: string | null
  chain?: string
  text?: string
}

function bodyRow(bench: BoardBench, cardId: number, columns: BodyColumns): void {
  appendEvent(bench.db, { ts: bench.ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: {}, legacy: false })
  const eventId = (bench.db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`${CARD_ADMITTED}:${cardId}`) as { id: number }).id
  bench.db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(cardId, eventId, columns.text ?? `do ${cardId}`, sha('a'), columns.lane, columns.who ?? 'shift', columns.priority ?? null, JSON.stringify(columns.depends ?? []))
  bench.db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(cardId, columns.state ?? null, eventId)
  if (columns.chain !== undefined)
    bench.db.prepare('INSERT INTO chains (dir, card_id, parking, sha, pid, leader, boundary, state, event_id) VALUES (?, ?, ?, ?, 1, NULL, 0, ?, ?)').run(`/trees/${cardId}`, cardId, '/parking/lane-1', sha('c'), columns.chain, eventId)
}

function admitCard(bench: BoardBench, cardId: number, lane: string, depends: number[] = []): void {
  const line = `#${cardId} task-${cardId} [implement/netwatch/S/cheap/auto] · depends ${depends.length === 0 ? '—' : depends.map(id => `#${id}`).join(', ')} · blocks —`
  const text = `card: ${line}\nbranch: feat/${cardId}\ntouches: scripts/${cardId}/**\nwho: shift\n\ndo ${cardId}\n`
  appendEvent(bench.db, { ts: bench.ts(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: line, lane, depends, text, textSha: textSha(text) }, legacy: false })
}

function stopCard(bench: BoardBench, cardId: number): void {
  appendEvent(bench.db, { ts: bench.ts(), type: CARD_STOPPED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}:${bench.ts()}`, payload: { reason: 'question.agent' }, legacy: false })
}

function planEvent(bench: BoardBench, type: string, payload: Record<string, unknown>): void {
  const dedupeKey = `${type}:${JSON.stringify(payload)}`
  appendEvent(bench.db, { ts: bench.ts(), type, actor: OWNER, cardId: null, pr: null, head: null, dedupeKey, payload, legacy: false })
  PLAN_FOLDS[type]!(bench.db, storedByKey(bench.db, dedupeKey))
}

function openPlan(bench: BoardBench, items: Record<string, number[]>): void {
  planEvent(bench, PLAN_OPENED, { id: 'p-045', title: 'Plan 0.45', goal: 'explicit journals', plan_file: '/plans/0.45.md' })
  for (const [item, cards] of Object.entries(items)) {
    planEvent(bench, PLAN_ITEM_ADDED, { plan: 'p-045', item, title: `slice ${item}` })
    for (const card of cards)
      planEvent(bench, PLAN_ITEM_LINKED, { plan: 'p-045', item, card })
  }
}

function conflictingSources(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-sources-'))
  roots.push(root)
  const parking = path.join(root, '.construct', 'parking', 'lane-1')
  mkdirSync(parking, { recursive: true })
  writeFileSync(path.join(parking, '999.md'), 'card: #999 other [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/999\ntouches: scripts/999/**\nwho: shift\n\ndo 999\n')
  writeFileSync(path.join(root, 'ghosts.jsonl'), `${JSON.stringify({ event: 'path', task: '999', ts: '2026-10-18T00:00:00Z' })}\n`)
  vi.stubEnv('HOME', root)
  vi.stubEnv('CONSTRUCT_HANDOFF_DIR', root)
}

function seedProjections(bench: BoardBench): void {
  bodyRow(bench, 860, { lane: 'lane-1' })
  bodyRow(bench, 861, { lane: 'lane-1', priority: 'p0' })
  bodyRow(bench, 862, { lane: 'lane-2', depends: [860] })
  bodyRow(bench, 863, { lane: 'lane-2', state: 'stopped' })
  appendEvent(bench.db, { ts: bench.ts(), type: CARD_STOPPED, actor: 'policy', cardId: 863, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:863`, payload: { reason: 'question' }, legacy: false })
}

describe('the factory board', () => {
  it('reads only the bus projections', () => {
    const bench = boardBench()
    conflictingSources()
    seedProjections(bench)
    const board = readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} })
    expect(board.ready).toEqual([{ card: '861', lane: 'lane-1', reason: null }, { card: '860', lane: 'lane-1', reason: null }])
    expect(board.waiting).toEqual([{ card: '862', lane: 'lane-2', reason: 'depends #860 not merged' }])
    expect(board.blocked).toEqual([{ card: '863', lane: 'lane-2', reason: 'waits question' }])

    const busPath = bench.db.location()!
    const projection = boardProjection(bench.db, busPath, TICK_MS)
    projection.project(bench.clock.now())
    const projected = readFileSync(projection.file, 'utf8')
    expect(projected).toContain('#861')
    expect(projected).not.toContain('#999')

    const printed: string[] = []
    expect(printBoard(busPath, bench.clock.now(), text => printed.push(text))).toBe(0)
    expect(printed.join('')).toContain('#862')
    expect(printed.join('')).not.toContain('#999')

    bench.db.prepare('UPDATE cards SET state = ? WHERE card_id = ?').run('merged', 860)
    expect(readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} }).waiting).toEqual([])
  })

  function liveBusCopy(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-data-'))
    roots.push(root)
    const copy = path.join(root, 'bus.db')
    const live = defaultBusPath()
    if (!existsSync(live)) {
      const bench = boardBench()
      seedProjections(bench)
      bench.tick()
      bench.db.exec(`VACUUM INTO '${copy.replace(/'/g, '\'\'')}'`)
      return copy
    }
    const db = new DatabaseSync(live, { readOnly: true })
    try {
      db.exec(`VACUUM INTO '${copy.replace(/'/g, '\'\'')}'`)
    }
    finally {
      db.close()
    }
    return copy
  }

  it('window.BOARD in board-data.js holds the facts of a copy of the live bus.db', () => {
    const copy = liveBusCopy()
    const now = new Date()
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const projection = boardProjection(db, copy, TICK_MS, DISK_FILES, path.join(path.dirname(copy), 'miko.md'))
      expect(projection.dataFile).toBe(path.join(path.dirname(copy), BOARD_DATA_FILE))
      projection.project(now)
      const window: { BOARD?: BoardData } = {}
      vm.runInNewContext(readFileSync(projection.dataFile, 'utf8'), { window })
      const board = window.BOARD!
      const facts = busFacts(db, now)
      expect(board.written).toBe(facts.at)
      expect(board.tickMs).toBe(TICK_MS)
      expect(board.slots.kv).toContain(`<span>written <b>${facts.at}</b></span>`)
      const rows = [...board.slots.rows.matchAll(/<tr data-card="(\d+)" data-stage="([^"]*)"/g)].map(match => ({ id: Number(match[1]), stage: match[2] }))
      expect(rows).toEqual(expect.arrayContaining(backlogCards(facts.cards, facts.at, true).map(card => ({ id: card.id, stage: card.stage }))))
      expect(rows).toHaveLength(backlogCards(facts.cards, facts.at, true).length)
      expect(board.slots.status).toContain(`<span>agents <b>${facts.services.length}</b></span>`)
      expect(board.slots.status).toContain(`<span>review queue <b>${facts.reviewQueue}</b></span>`)
      const shell = readFileSync(projection.file, 'utf8')
      expect(shell).not.toContain('http-equiv="refresh"')
      expect(shell).toContain(`<table id="slot-rows">\n${board.slots.rows}\n</table>`)
      for (const id of board.filters)
        expect(shell).toContain(`<span class="filter-target" id="${id}"></span>`)
    }
    finally {
      db.close()
    }
  })

  it('board-data.js is written through tmp and rename', () => {
    const bench = boardBench()
    seedProjections(bench)
    const busPath = bench.db.location()!
    const root = path.dirname(busPath)
    const previous = 'window.BOARD = "previous"\n'
    const dataFile = path.join(root, BOARD_DATA_FILE)
    writeFileSync(dataFile, previous)
    const calls: string[][] = []
    const files: BoardFiles = {
      write: (file, text) => {
        if (calls.length === 0)
          expect(readFileSync(dataFile, 'utf8')).toBe(previous)
        calls.push(['write', file, text.slice(0, 15)])
        DISK_FILES.write(file, text)
      },
      rename: (from, to) => {
        calls.push(['rename', from, to])
        DISK_FILES.rename(from, to)
      },
    }
    const projection = boardProjection(bench.db, busPath, TICK_MS, files)
    expect(projection.dataFile).toBe(dataFile)
    projection.project(bench.clock.now())
    const [dataWrite, dataRename, pageWrite, pageRename] = calls
    expect(dataWrite).toEqual(['write', dataWrite![1], 'window.BOARD = '])
    expect(dataRename).toEqual(['rename', dataWrite![1], projection.dataFile])
    expect(pageWrite).toEqual(['write', pageWrite![1], '<!doctype html>'])
    expect(pageRename).toEqual(['rename', pageWrite![1], projection.file])
    expect(calls).toHaveLength(4)
    for (const temporary of [dataWrite![1]!, pageWrite![1]!]) {
      expect(path.dirname(temporary)).toBe(root)
      expect(existsSync(temporary)).toBe(false)
    }
    expect(dataWrite![1]).not.toBe(projection.dataFile)
    expect(readFileSync(projection.dataFile, 'utf8')).toMatch(/^window\.BOARD = \{/)
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('the board command exits 1 on a missing database and prints the page for a seeded one', () => {
    const bench = boardBench()
    seedProjections(bench)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runBoardCli(path.join(tmpdir(), 'bus-board-missing', 'bus.db'))).toBe(1)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no bus database'))
    errors.mockRestore()
    const written = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(runBoardCli(bench.db.location()!)).toBe(0)
    expect(String(written.mock.calls[0]?.[0])).toContain('<!doctype html>')
    written.mockRestore()
  })

  it('the projected queue applies each clause of its SQL', () => {
    const cases: { name: string, columns: BodyColumns, queue: 'ready' | 'waiting' | 'blocked' | null }[] = [
      { name: 'fallen', columns: { lane: 'lane-1', state: 'fallen' }, queue: 'ready' },
      { name: 'queued', columns: { lane: 'lane-1', state: 'queued' }, queue: 'ready' },
      { name: 'running', columns: { lane: 'lane-1', state: 'running' }, queue: null },
      { name: 'merged', columns: { lane: 'lane-1', state: 'merged' }, queue: null },
      { name: 'running chain', columns: { lane: 'lane-1', chain: 'running' }, queue: null },
      { name: 'stopped chain', columns: { lane: 'lane-1', chain: 'stopped' }, queue: 'ready' },
      { name: 'who window', columns: { lane: 'lane-1', who: 'window' }, queue: null },
      { name: 'not a lane', columns: { lane: 'archive' }, queue: null },
      { name: 'stopped without a stop event', columns: { lane: 'lane-1', state: 'stopped' }, queue: 'blocked' },
    ]
    const bench = boardBench()
    cases.forEach((each, index) => bodyRow(bench, 900 + index, each.columns))
    const board = readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} })
    const found = (queue: 'ready' | 'waiting' | 'blocked'): string[] => board[queue].map(card => cases[Number(card.card) - 900]!.name)
    expect(found('ready')).toEqual(cases.filter(each => each.queue === 'ready').map(each => each.name))
    expect(found('blocked')).toEqual(['stopped without a stop event'])
    expect(board.blocked[0]?.reason).toBe('waits fault')
    expect(board.waiting).toEqual([])
  })

  it('the projected queue orders p0 first, then lane, then card', () => {
    const bench = boardBench()
    bodyRow(bench, 910, { lane: 'lane-2' })
    bodyRow(bench, 911, { lane: 'lane-1' })
    bodyRow(bench, 912, { lane: 'lane-2', priority: 'p0' })
    bodyRow(bench, 913, { lane: 'lane-1' })
    expect(readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} }).ready.map(card => card.card)).toEqual(['912', '911', '913', '910'])
  })

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

  it('the answer queue lists a p0 card first and a second task of a held card last, in the order the answer worker grants', () => {
    const bench = boardBench()
    bench.gitHub.open({ number: 735 })
    bench.tick()
    const cardText = (cardId: number): string => `card: #${cardId} task-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/${cardId}\ntouches: scripts/${cardId}/**\nwho: shift\n${cardId === 847 ? 'priority: p0\n' : ''}\ndo ${cardId}\n`
    queueTask(bench.db, bench.ts(), { queue: 'answer', cardId: 835 })
    leaseNext(bench.db, bench.ts(), 'answer', 'worker:answer:s1', answerLeaseOrder(bench.db, cardText))
    queueTask(bench.db, bench.ts(), { queue: 'answer', cardId: 835, pr: 735, head: sha('a') })
    for (const cardId of [849, 837, 847])
      queueTask(bench.db, bench.ts(), { queue: 'answer', cardId })
    bench.leaseOrders = { answer: answerLeaseOrder(bench.db, cardText) }
    const answer = bench.tick().queues.find(queue => queue.queue === 'answer')
    expect(answer?.waiting.map(task => task.card)).toEqual([847, 849, 837, 835])
    const granted: number[] = []
    for (let lease = leaseNext(bench.db, bench.ts(), 'answer', 'worker:answer:s2', answerLeaseOrder(bench.db, cardText)); lease !== null; lease = leaseNext(bench.db, bench.ts(), 'answer', 'worker:answer:s2', answerLeaseOrder(bench.db, cardText)))
      granted.push(lease.cardId)
    expect(granted).toEqual([847, 849, 837])
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
    expect(killed[1]!.execution.find(row => row.card === 110)?.markers).toContain('review down')
  })

  it('a card taken into a lane leaves ready and appears in its lane within two ticks', () => {
    const bench = boardBench()
    admitCard(bench, 850, 'lane-1')
    const before = bench.tick()
    expect(before.ready.map(card => card.card)).toEqual(['850'])
    expect(before.lanes).toEqual([])
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
    admitCard(bench, 850, 'lane-1')
    bench.tick()
    appendEvent(bench.db, { ts: bench.ts(), type: CARD_STARTED, actor: 'policy', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_STARTED}:850`, payload: {}, legacy: false })
    expect(bench.tick().progress.stalled).toBe(false)
    bench.watched = [reviewWorker(null)]
    for (let minute = 0; minute < 29; minute++)
      expect(bench.tick().progress.stalled).toBe(false)
    const stalled = bench.tick()
    expect(stalled.progress).toMatchObject({ stalled: true, cause: 'down: review' })
    bench.watched = [reviewWorker(REVIEW_PID)]
    stopCard(bench, 850)
    expect(bench.tick().progress.cause).toBe('queue blocked: #850 waits question.agent')
  })

  it('the board shows the active shard, its scope and the time left', () => {
    const bench = boardBench()
    const read = (at: string): Board => readBoard({ db: bench.db, now: new Date(at), watched: [], leaseOrders: {} })
    expect(read('2026-10-18T09:00:00.000Z').shard).toBeNull()
    appendEvent(bench.db, { ts: '2026-10-18T09:00:00.000Z', type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:w1`, payload: { id: 'w1', by: 'Eli', run: null, window: true, scope: 'merge+decisions', until: '2026-10-18T15:00:00.000Z' }, legacy: false })
    const board = read('2026-10-18T10:30:00.000Z')
    expect(board.shard).toEqual({ id: 'w1', by: 'Eli', scope: 'merge+decisions', until: '2026-10-18T15:00:00.000Z', leftMinutes: 270 })
    expect(read('2026-10-18T15:00:00.000Z').shard).toBeNull()
    appendEvent(bench.db, windowShardEnded(SHARD_REVOKED, 'owner', 'w1', new Date('2026-10-18T11:00:00.000Z')))
    expect(read('2026-10-18T11:00:00.000Z').shard).toBeNull()
  })

  it('the queue-blocked cause names the silent card in work, never a card queued behind it', () => {
    const working = boardBench()
    admitCard(working, 850, 'lane-1')
    admitCard(working, 851, 'lane-1')
    admitCard(working, 852, 'lane-1', [850])
    working.tick()
    appendEvent(working.db, { ts: working.ts(), type: CARD_STARTED, actor: 'policy', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_STARTED}:850`, payload: {}, legacy: false })
    stopCard(working, 851)
    for (let minute = 0; minute < 30; minute++)
      working.tick()
    expect(working.tick().progress).toMatchObject({ stalled: true, cause: 'cause unknown' })
    stopCard(working, 850)
    expect(working.tick().progress.cause).toBe('queue blocked: #850 waits question.agent')
  })

  it('the projection beside pulse gives the latest context and spent of each card', () => {
    const bench = boardBench()
    recordHeartbeat(bench.db, bench.ts(), { card: 870, pr: null, head: null, step: 'implement', session: 's-870', lease: null }, () => ({ context: 100_000, spent: 900_000 }))
    bench.clock.advance(1000)
    recordHeartbeat(bench.db, bench.ts(), { card: 870, pr: null, head: null, step: 'implement', session: 's-870', lease: null }, () => ({ context: 120_000, spent: 1_000_000 }))
    recordHeartbeat(bench.db, bench.ts(), { card: 871, pr: null, head: null, step: 'implement', session: 's-871', lease: null }, () => ({ spent: 50 }))
    expect(cardGauges(bench.db)).toEqual([
      { card: 870, ts: bench.ts(), context: 120_000, spent: 1_000_000 },
      { card: 871, ts: bench.ts(), context: null, spent: 50 },
    ])
    expect(bench.tick().gauges).toEqual(cardGauges(bench.db))
  })

  it('the projection beside pulse gives the gauges of the latest window heartbeat, and none when it carries no fields', () => {
    const bench = boardBench()
    expect(windowGauges(bench.db)).toBeNull()
    recordWindowHeartbeat(bench.db, bench.ts(), 'w-1', { context: 50_000, spent: 70_000 })
    bench.clock.advance(1000)
    recordWindowHeartbeat(bench.db, bench.ts(), 'w-2', { spent: 90_000 })
    expect(windowGauges(bench.db)).toEqual({ session: 'w-2', ts: bench.ts(), context: null, spent: 90_000 })
    expect(bench.tick().windowGauges).toEqual(windowGauges(bench.db))
    bench.clock.advance(1000)
    recordWindowHeartbeat(bench.db, bench.ts(), 'w-1')
    expect(windowGauges(bench.db)).toBeNull()
  })

  it('review and answer tiles show the context and spent bars', () => {
    const bench = boardBench()
    const busPath = bench.db.location()!
    const measured = { context: 80_000, spent: 400_000 }
    const review = leaseWhileFree(bench.db, bench.ts(), { queue: 'review', cardId: 880, pr: 980, head: sha('8') }, 'worker:review:node-1', 1)!
    const answer = leaseWhileFree(bench.db, bench.ts(), { queue: 'answer', cardId: 881 }, 'worker:answer:node-1', 1)!
    busReviewPulse(busPath, bench.clock.now, () => {}, () => measured)(review, 'reviewer-880')
    busSessionPulse(busPath, bench.clock.now, () => measured)(answer, 'answer-881')
    const written: string[] = []
    expect(printBoard(busPath, bench.clock.now(), text => written.push(text))).toBe(0)
    const tiles = written.join('').split('<div class="svc" ').slice(1)
    for (const [role, task] of [['review', '#880'], ['answer', '#881']]) {
      const sessionTile = tiles.find(each => each.startsWith(`data-role="${role}"`) && each.includes(`>${task}<`) && each.includes(' · pulse '))
      expect(sessionTile, role).toContain('<span class="edd-k">ctx</span>')
      expect(sessionTile, role).toContain('<span class="edd-k">spent</span>')
    }
  })

  it('a card whose heartbeat carries no fields has no bar', () => {
    const bench = boardBench()
    recordHeartbeat(bench.db, bench.ts(), { card: 872, pr: null, head: null, step: 'implement', session: 's-872', lease: null })
    recordHeartbeat(bench.db, bench.ts(), { card: 873, pr: null, head: null, step: 'implement', session: 's-873', lease: null }, () => ({}))
    expect(cardGauges(bench.db)).toEqual([])
    expect(bench.tick().gauges).toEqual([])
  })

  it('the board shows no progress for N minutes at step X from the last heartbeat', () => {
    const working = boardBench()
    const text = 'card: #850 task-850 [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/850\ntouches: scripts/850/**\nwho: shift\n\ndo 850\n'
    appendEvent(working.db, { ts: working.ts(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:850`, payload: { card: '#850', lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
    appendEvent(working.db, { ts: working.ts(), type: CARD_STARTED, actor: 'policy', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_STARTED}:850`, payload: {}, legacy: false })
    for (let minute = 0; minute < 30; minute++) {
      if (minute === 20)
        recordHeartbeat(working.db, working.ts(), { card: 850, pr: null, head: null, step: 'implement', session: 's-850', lease: null })
      expect(working.tick().progress.stalled).toBe(false)
    }
    const stalled = working.tick()
    expect(stalled.progress).toMatchObject({ stalled: true, cause: '#850 no progress 30 min, step implement' })
  })

  it('with no card in work a blocked queue and a down component still raise their cause', () => {
    const idle = boardBench()
    admitCard(idle, 851, 'lane-1')
    idle.tick()
    stopCard(idle, 851)
    for (let minute = 1; minute < 30; minute++)
      expect(idle.tick().progress.stalled).toBe(false)
    expect(idle.tick().progress).toMatchObject({ stalled: true, cause: 'queue blocked: #851 waits question.agent' })
    idle.watched = [reviewWorker(null)]
    expect(idle.tick().progress).toMatchObject({ stalled: true, cause: 'down: review' })
    idle.watched = [reviewWorker(REVIEW_PID)]
    appendEvent(idle.db, { ts: idle.ts(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId: 851, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:851`, payload: { lane: 'dropped' }, legacy: false })
    expect(idle.tick().progress).toMatchObject({ stalled: false, cause: null })
  })

  it('silence counts only for the card in work, and a card blocked waiting on #N raises no alarm', () => {
    const working = boardBench()
    appendEvent(working.db, { ts: working.ts(), type: CARD_STARTED, actor: 'policy', cardId: 850, pr: null, head: null, dedupeKey: `${CARD_STARTED}:850`, payload: {}, legacy: false })
    observeChain(working.db, working.ts(), 'worker:chain:1', { dir: '/trees/lane-1', parking: '/parking/lane-1', cardId: 850, sha: sha('c'), pid: 99, leader: null, boundary: false, state: 'running' })
    const busyElsewhere = (minute: number): void => {
      appendEvent(working.db, { ts: working.ts(), type: CARD_ADMITTED, actor: 'policy', cardId: 900 + minute, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${900 + minute}`, payload: {}, legacy: false })
    }
    for (let minute = 0; minute < 30; minute++) {
      busyElsewhere(minute)
      expect(working.tick().progress.stalled).toBe(false)
    }
    busyElsewhere(30)
    expect(working.tick().progress).toMatchObject({ stalled: true, cause: 'cause unknown' })

    const blocked = boardBench()
    admitCard(blocked, 852, 'lane-2', [849])
    observeChain(blocked.db, blocked.ts(), 'worker:chain:2', { dir: '/trees/lane-2', parking: '/parking/lane-2', cardId: 852, sha: sha('d'), pid: 98, leader: null, boundary: true, state: 'waiting', waitingOn: [849] })
    for (let minute = 0; minute < 40; minute++)
      blocked.tick()
    const quiet = blocked.tick()
    expect(quiet.progress).toMatchObject({ stalled: false, cause: null })
    expect(quiet.lanes).toEqual([{ lane: 'lane-2', card: 852, state: 'waiting', since: expect.any(String) as unknown }])
    expect(quiet.execution.find(row => row.card === 852)?.stage).toBe('waiting on #849')
    expect(quiet.waiting).toEqual([])
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
    expect(contract.get('automaton')?.fact).toBe('0 pr.opened, 0 cards without state')
    expect(contract.get('replay')?.fact).toBe('matches')
  })

  it('a missed supervisor restart reads red on the contract row', () => {
    const bench = boardBench()
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: true })
    appendEvent(bench.db, { ts: bench.ts(), type: RESTART_MISSED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTART_MISSED}:${sha('b')}`, payload: { sha: sha('b'), waited_ms: 300_000, limit_ms: 300_000 }, legacy: false })
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: false, fact: expect.stringContaining('1 restart after') })
    appendEvent(bench.db, { ts: bench.ts(), type: RESTART_MISSED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTART_MISSED}:${sha('c')}`, payload: { sha: sha('c'), waited_ms: 300_000, limit_ms: 300_000 }, legacy: false })
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: false, fact: expect.stringContaining('2 restarts after') })
  })

  it('a missed supervisor restart stays red after a later main.advanced and clears on a supervisor.restarted', () => {
    const bench = boardBench()
    bench.tick()
    appendEvent(bench.db, { ts: bench.ts(), type: RESTART_MISSED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTART_MISSED}:${sha('b')}`, payload: { sha: sha('b'), waited_ms: 300_000, limit_ms: 300_000 }, legacy: false })
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: false })
    appendEvent(bench.db, { ts: bench.ts(), type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `main:${sha('d')}`, payload: { sha: sha('d'), touches_mechanics: true }, legacy: false })
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: false })
    appendEvent(bench.db, { ts: bench.ts(), type: RESTARTED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTARTED}:${sha('d')}`, payload: { sha: sha('d') }, legacy: false })
    expect(bench.tick().contract.find(link => link.link === RESTART_MISSED)).toMatchObject({ green: true, fact: expect.stringContaining('0 restarts after') })
  })

  it('a process judged silent shows an alarm on the board', () => {
    const bench = boardBench()
    const lastBeat = bench.ts()
    recordProcessHeartbeat(bench.db, lastBeat, 'bus:merge')
    expect(bench.tick().contract.find(link => link.link === SILENT_PROCESS)).toEqual({ link: SILENT_PROCESS, green: true, fact: 'no process judged silent' })

    recordJudged(bench.db, bench.ts(), { process: 'bus:merge', lastBeat, silentMs: 21 * 60_000 })
    expect(bench.tick().contract.find(link => link.link === SILENT_PROCESS)).toEqual({ link: SILENT_PROCESS, green: false, fact: `judged silent, no heartbeat since: bus:merge (last beat ${lastBeat})` })

    recordProcessHeartbeat(bench.db, bench.ts(), 'bus:merge')
    expect(bench.tick().contract.find(link => link.link === SILENT_PROCESS)).toMatchObject({ green: true })
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

  it('a dropped card is not in flight', () => {
    const bench = boardBench()
    for (const card of [916, 917]) {
      appendEvent(bench.db, { ts: bench.ts(), type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}`, payload: { lane: 'lane-1', depends: [] }, legacy: false })
      appendEvent(bench.db, { ts: bench.ts(), type: CARD_STARTED, actor: 'worker:launch:s1', cardId: card, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${card}`, payload: {}, legacy: false })
      observeChain(bench.db, bench.ts(), 'worker:chain:1', { dir: `/trees/${card}`, parking: '/parking/lane-1', cardId: card, sha: sha('e'), pid: card, leader: null, boundary: false, state: 'running' })
    }
    expect(bench.tick().execution.map(row => row.card)).toEqual([916, 917])
    appendEvent(bench.db, { ts: bench.ts(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId: 916, pr: null, head: null, dedupeKey: `${CARD_MOVED}:916`, payload: { lane: DROPPED_LANE }, legacy: false })
    expect(bench.tick().execution.map(row => row.card)).toEqual([917])
  })

  it('a dropped card is not in work, with or without its chain, so its silence stalls nothing', () => {
    for (const withChain of [true, false]) {
      const bench = boardBench()
      appendEvent(bench.db, { ts: bench.ts(), type: CARD_ADMITTED, actor: 'policy', cardId: 916, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:916`, payload: { lane: 'lane-1', depends: [] }, legacy: false })
      appendEvent(bench.db, { ts: bench.ts(), type: CARD_STARTED, actor: 'worker:launch:s1', cardId: 916, pr: null, head: null, dedupeKey: `${CARD_STARTED}:916`, payload: {}, legacy: false })
      if (withChain)
        observeChain(bench.db, bench.ts(), 'worker:chain:1', { dir: '/trees/916', parking: '/parking/lane-1', cardId: 916, sha: sha('e'), pid: 916, leader: null, boundary: false, state: 'running' })
      appendEvent(bench.db, { ts: bench.ts(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId: 916, pr: null, head: null, dedupeKey: `${CARD_MOVED}:916`, payload: { lane: DROPPED_LANE }, legacy: false })
      for (let minute = 0; minute < 31; minute++)
        bench.tick()
      expect(bench.tick().progress).toMatchObject({ stalled: false, cause: null })
    }
  })

  it('the header goal comes from the open plan journal, never from a decision or a Path line', () => {
    const bench = boardBench()
    const read = (): Board => readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} })
    bodyRow(bench, 920, { lane: 'lane-1', state: MERGED_CARD, text: 'do it\n\nPath (D-76): cheap — 0.44, slice S\n' })
    bodyRow(bench, 921, { lane: 'lane-1', state: 'queued' })
    bodyRow(bench, 922, { lane: 'lane-1', state: 'queued' })
    bench.db.prepare('INSERT INTO decisions (decision_id, text, scope, source, event_id) VALUES (193, ?, \'[]\', \'owner\', 1)').run('[owner] 0.44 scope is the list')
    expect(read().goal).toBeNull()
    openPlan(bench, { S1: [920], S2: [921], S3: [] })
    expect(read().goal).toMatchObject({ plans: [{ id: 'p-045', delivered: 1, total: 3, stages: { not_created: 1, queued: 1, delivered: 1 } }], backlog: 1 })
  })

  it('the board page opens with the plan line and a bar of its slices by stage', () => {
    const bench = boardBench()
    bodyRow(bench, 930, { lane: 'lane-1', state: MERGED_CARD })
    bodyRow(bench, 931, { lane: 'lane-1', state: 'queued' })
    bodyRow(bench, 932, { lane: 'lane-1', state: 'dropped' })
    openPlan(bench, { S1: [930], S2: [931], S3: [932] })
    const written: string[] = []
    expect(printBoard(bench.db.location()!, bench.clock.now(), text => written.push(text))).toBe(0)
    const page = written.join('')
    expect(page).toContain('<div class="goal" id="slot-goal"><div class="goal-top"><span class="goal-k">plan</span><span class="goal-name">Plan 0.45: delivered 1 of 3 · queued 1 · in progress 0 · review 0 · slices without cards: 1 · +1 in 24 h · backlog: 0</span></div>')
    expect(page).toContain('<div class="bar" role="img" aria-label="Plan slices by stage"><i class="sw" data-stage="delivered" style="--_n: 1" title="delivered: 1"></i><i class="sw" data-stage="queued" style="--_n: 1" title="queued: 1"></i><i class="sw" data-stage="not_created" style="--_n: 1" title="not_created: 1"></i></div>')
    expect(page).toContain('<h2 id="h-flow">Flow</h2><span class="meta">live cards by stage</span></div>')
    planEvent(bench, PLAN_CLOSED, { plan: 'p-045' })
    const closed: string[] = []
    expect(printBoard(bench.db.location()!, bench.clock.now(), text => closed.push(text))).toBe(0)
    expect(closed.join('')).toContain('<div class="goal" id="slot-goal"></div>')
  })
})
