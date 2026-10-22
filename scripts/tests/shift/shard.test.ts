import type { BusEvent } from '../../bus/db.js'
import type { ShardDeps } from '../../shift/shard.js'
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { activeWindowShards, expiredWindowShards } from '../../bus/shards.js'
import { SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED } from '../../core/events.js'
import { runShard, USAGE } from '../../shift/shard.js'
import { GHOST_JOURNAL } from '../../shift/places.js'

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

function eventsOf(world: World, event: string): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(path.join(world.handoff, GHOST_JOURNAL), 'utf8')
  }
  catch {
    return []
  }
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === event)
}

function shardDeps(world: World, io: Captured, record: ShardDeps['record'] = () => {}): ShardDeps {
  return { handoffDir: world.handoff, append: (file, text) => writeFileSync(file, text, { flag: 'a' }), record, activeWindows: () => [], inForce: () => false, now: () => new Date('2026-10-08T09:00:00.000Z'), uuid: () => SHARD, by: () => '', out: line => io.out.push(line), err: line => io.err.push(line) }
}

function busEvents(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT type, actor, card_id, pr, payload FROM events ORDER BY id').all().map(row => ({ ...row, payload: JSON.parse(String(row.payload)) as unknown }))
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
    expect(eventsOf(world, 'shard').at(-1)).toEqual({ event: 'shard', id: `${SHARD}-card`, by: 'Eli', ts: '2026-10-08T09:00:00.000Z', card: 726, pr: 626 })
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
    expect(eventsOf(world, 'shard')).toEqual([])
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
    expect(eventsOf(world, 'shard').at(0)).toEqual({ event: 'shard', id: SHARD, by: 'Eli', ts: '2026-10-08T09:00:00.000Z', window: true, scope: 'merge', until: '2026-10-08T15:00:00.000Z' })
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
    expect(eventsOf(world, 'shard')).toEqual([])
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
})
