import type { DatabaseSync } from 'node:sqlite'
import type { AnswerOutcome } from '../../bus/answer-executor.js'
import type { Answerer } from '../../bus/answerer.js'
import type { CardTreeTools } from '../../bus/card-tree.js'
import type { BusEvent } from '../../bus/db.js'
import type { ShardDeps } from '../../shift/shard.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnswerExecutor } from '../../bus/answer-executor.js'
import { appendEvent, OPEN_WAIT, openBus, OWNER_WAITS } from '../../bus/db.js'
import { cardDecisionCommand } from '../../bus/launch-worker.js'
import { leaseNext } from '../../bus/lease.js'
import { queueTask } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { activeWindowShards, DECISIONS_SCOPE, expiredWindowShards } from '../../bus/shards.js'
import { CARD_STARTED, CARD_STOPPED, QUESTION_OWNER, SHARD_DECIDED, SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED } from '../../core/events.js'
import { runShard, USAGE } from '../../shift/shard.js'

const SHARD = '5a4d0000-0000-4000-8000-000000000650'

interface World {
  handoff: string
  shift: string
}

interface Captured {
  out: string[]
  err: string[]
}

function initWorld(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'shard-'))
  return { handoff: root, shift: path.join(root, 'shift') }
}

function captured(): Captured {
  return { out: [], err: [] }
}

function shardDeps(world: World, io: Captured, record: ShardDeps['record'] = () => {}): ShardDeps {
  return { record, activeWindows: () => [], inForce: () => false, now: () => new Date('2026-10-08T09:00:00.000Z'), uuid: () => SHARD, by: () => '', out: line => io.out.push(line), err: line => io.err.push(line) }
}

function busEvents(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT type, actor, card_id, pr, payload FROM events ORDER BY id').all().map(row => ({ ...row, payload: JSON.parse(String(row.payload)) as unknown }))
}

interface Asked {
  outcome: AnswerOutcome
  decided: number
  waits: unknown[]
}

async function askedUnderADecisionsShard(question: string): Promise<Asked> {
  const world = initWorld()
  const db = openBus(path.join(world.handoff, 'bus.db'))
  expect(runShard(['--window', '--hours', '2', '--scope', DECISIONS_SCOPE, '--by', 'Eli'], shardDeps(world, captured(), event => appendEvent(db, event)))).toBe(0)
  const now = new Date('2026-10-08T09:30:00.000Z')
  const ts = now.toISOString()
  const worktree = path.join(world.handoff, 'mc-905')
  mkdirSync(worktree)
  appendEvent(db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STARTED}:905`, payload: { session: 'card-session-1', worktree, branch: 'feat/card-905', base: '1'.repeat(40) }, legacy: false })
  appendEvent(db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:905`, payload: { reason: 'question.agent', detail: 'a question on card #905' }, legacy: false })
  const stop = Number((db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(db, ts, { queue: 'answer', cardId: 905, stop })
  const answerer: Answerer = async () => ({ session: 'card-session-1', resumed: true, before: 'a'.repeat(40), after: 'a'.repeat(40), owner: question })
  const trees: CardTreeTools = { home: world.handoff, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db, answerer, ownerMerges: () => readFileSync('architecture/owner-merges.md', 'utf8'), clock: () => now, trees, isolation: () => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [] }) })
  const outcome = await executor.answer(leaseNext(db, ts, 'answer', 'worker:answer:worker-1')!)
  reduce(db)
  const decided = Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(SHARD_DECIDED) as { n: number }).n)
  const waits = db.prepare(`SELECT need, text, command, card_id, state FROM ${OWNER_WAITS}`).all().map(row => ({ ...row }))
  db.close()
  return { outcome, decided, waits }
}

describe('a shard delegates one owner merge', () => {
  it('pnpm shard writes shard.issued to the bus for the card and pull request it names', () => {
    const world = initWorld()
    const db = openBus(path.join(world.handoff, 'bus.db'))
    const io = captured()
    const deps = shardDeps(world, io, event => appendEvent(db, event))
    expect(runShard(['--card', '726', '--pr', '626', '--by', 'Eli'], { ...deps, uuid: () => `${SHARD}-card` })).toBe(0)
    expect(busEvents(db)).toEqual([
      { type: SHARD_ISSUED, actor: 'owner', card_id: 726, pr: 626, payload: { id: `${SHARD}-card`, by: 'Eli', run: null } },
    ])
    expect(io.out.at(-1)).toContain('card #726 and PR #626')
    db.close()
  })

  it('pnpm shard names a card or a pull request, refuses a shift run, and writes nothing otherwise', () => {
    const world = initWorld()
    const io = captured()
    const recorded: unknown[] = []
    const deps = shardDeps(world, io, event => recorded.push(event))
    for (const argv of [[], [world.shift], [world.shift, '--card', '726'], ['--card', 'x'], ['--pr', '0'], ['--card'], ['--card', '726', '--by']])
      expect(runShard(argv, deps)).toBe(1)
    expect(recorded).toEqual([])
    expect(io.err.every(line => line.includes(USAGE))).toBe(true)
  })

  it('pnpm shard --under D-N issues a card or pull request shard only while D-N is in force, and names the decision when it refuses', () => {
    const world = initWorld()
    const io = captured()
    const recorded: BusEvent[] = []
    const deps = { ...shardDeps(world, io, event => recorded.push(event)), inForce: (decisionId: number) => decisionId === 82 }
    expect(runShard(['--pr', '626', '--under', 'D-82', '--by', 'Eli'], deps)).toBe(0)
    expect(recorded).toMatchObject([{ type: SHARD_ISSUED, pr: 626, payload: { id: SHARD, by: 'Eli', run: null, under: 82 } }])
    expect(runShard(['--pr', '626', '--under', 'D-80', '--by', 'Eli'], deps)).toBe(1)
    expect(io.err.at(-1)).toContain('D-80 is not in force')
    for (const argv of [[world.shift, '--under', 'D-82'], ['--pr', '626', '--under', '82'], ['--pr', '626', '--under']])
      expect(runShard(argv, deps)).toBe(1)
    expect(recorded).toHaveLength(1)
  })

  it('pnpm shard --window issues a window shard for six hours of merges by default, or the term and scope named', () => {
    const world = initWorld()
    const db = openBus(path.join(world.handoff, 'bus.db'))
    const io = captured()
    const deps = shardDeps(world, io, event => appendEvent(db, event))
    expect(runShard(['--window', '--by', 'Eli'], deps)).toBe(0)
    expect(runShard(['--window', '--hours', '2', '--scope', 'merge+decisions', '--by', 'Eli'], { ...deps, uuid: () => `${SHARD}-all` })).toBe(0)
    expect(busEvents(db)).toEqual([
      { type: SHARD_ISSUED, actor: 'owner', card_id: null, pr: null, payload: { id: SHARD, by: 'Eli', run: null, window: true, scope: 'merge', until: '2026-10-08T15:00:00.000Z' } },
      { type: SHARD_ISSUED, actor: 'owner', card_id: null, pr: null, payload: { id: `${SHARD}-all`, by: 'Eli', run: null, window: true, scope: 'merge+decisions', until: '2026-10-08T11:00:00.000Z' } },
    ])
    expect(io.out[0]).toContain('for the window, scope merge, until 2026-10-08T15:00:00.000Z')
    expect(activeWindowShards(db, new Date('2026-10-08T12:00:00.000Z')).map(shard => shard.id)).toEqual([SHARD])
    db.close()
  })

  it('pnpm shard --window refuses a target, a term that is not a whole number of hours and an unknown scope, and writes nothing', () => {
    const world = initWorld()
    const io = captured()
    const recorded: unknown[] = []
    const deps = shardDeps(world, io, event => recorded.push(event))
    for (const argv of [['--window', '--card', '726'], ['--window', world.shift], ['--window', '--hours', '0'], ['--window', '--hours', '1.5'], ['--window', '--scope', 'all'], ['--card', '726', '--hours', '2'], ['--stop', '--window'], ['--stop', '--hours', '2']])
      expect(runShard([...argv, '--by', 'Eli'], deps)).toBe(1)
    expect(recorded).toEqual([])
    expect(io.err.every(line => line.includes(USAGE))).toBe(true)
  })

  it('stop revokes the shard and the revocation is a bus event', () => {
    const world = initWorld()
    const db = openBus(path.join(world.handoff, 'bus.db'))
    const io = captured()
    const deps = { ...shardDeps(world, io, event => appendEvent(db, event)), activeWindows: (now: Date) => activeWindowShards(db, now) }
    expect(runShard(['--window', '--by', 'Eli'], deps)).toBe(0)
    expect(runShard(['--stop'], deps)).toBe(0)
    expect(busEvents(db).at(-1)).toEqual({ type: SHARD_REVOKED, actor: 'owner', card_id: null, pr: null, payload: { id: SHARD } })
    expect(io.out.at(-1)).toBe(`[shard] shard ${SHARD} revoked`)
    expect(activeWindowShards(db, new Date('2026-10-08T09:30:00.000Z'))).toEqual([])
    expect(runShard(['--stop'], deps)).toBe(1)
    expect(io.err.at(-1)).toBe('[shard] no active window shard to revoke')
    db.close()
  })

  it('a window shard past its term expires as a bus event once, and is no longer active', () => {
    const world = initWorld()
    const db = openBus(path.join(world.handoff, 'bus.db'))
    expect(runShard(['--window', '--hours', '1', '--by', 'Eli'], shardDeps(world, captured(), event => appendEvent(db, event)))).toBe(0)
    expect(expiredWindowShards(db, new Date('2026-10-08T09:59:00.000Z'), 'worker:merge:1')).toEqual([])
    const late = new Date('2026-10-08T10:00:00.000Z')
    expect(activeWindowShards(db, late)).toEqual([])
    const expired = expiredWindowShards(db, late, 'worker:merge:1')
    expect(expired).toMatchObject([{ type: SHARD_EXPIRED, actor: 'worker:merge:1', payload: { id: SHARD } }])
    for (const event of expired)
      appendEvent(db, event)
    expect(expiredWindowShards(db, late, 'worker:merge:1')).toEqual([])
    db.close()
  })

  it('a question in the owner boundary opens an owner wait instead of a shard decision', async () => {
    const r1 = 'may the owner push 03c463cd, which changes .github/workflows/ci.yml?'
    const r1Detail = `${r1} (.github/workflows/ci.yml is R1 and stays the owner's under any shard)`
    const owner = await askedUnderADecisionsShard(r1)
    expect(owner.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: r1Detail })
    expect(owner.decided).toBe(0)
    expect(owner.waits).toEqual([{ need: 'decision', text: `card #905 asks: ${r1Detail}`, command: cardDecisionCommand(905), card_id: 905, state: OPEN_WAIT }])
    const windowOwn = 'may the card also touch AGENTS.md?'
    const decided = await askedUnderADecisionsShard(windowOwn)
    expect(decided.outcome).toMatchObject({ kind: 'decided', shard: SHARD, question: windowOwn })
    expect(decided.decided).toBe(1)
    expect(decided.waits).toEqual([])
  })
})
