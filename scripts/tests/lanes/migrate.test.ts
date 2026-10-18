import type { ChainState } from '../../bus/chain.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { observeChain } from '../../bus/chain.js'
import { openBus } from '../../bus/db.js'
import { LANE_NAME, laneJsonProblems, readLaneJson, UNKNOWN, writeLaneJson } from '../../lanes/lane-json.js'
import { laneCards, LaneMigrationRefused, liveChainLanes, migrate, planMigration } from '../../lanes/migrate.js'

const roots: string[] = []

function parkingRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanes-migrate-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

function card(id: number, touches: string[] | null): string {
  return [`card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, `branch: feat/card-${id}`, ...(touches === null ? [] : [`touches: ${touches.join(', ')}`]), 'continue: stop', 'who: shift', '', 'Body.', ''].join('\n')
}

function park(parking: string, lane: string, id: number, touches: string[] | null = [`scripts/c${id}.ts`]): void {
  mkdirSync(path.join(parking, lane), { recursive: true })
  writeFileSync(path.join(parking, lane, `${id}.md`), card(id, touches))
}

function legacyParking(): string {
  const parking = parkingRoot()
  park(parking, 'lane-1', 738)
  park(parking, 'lane-1', 750)
  park(parking, 'lane-1', 61)
  park(parking, 'lane-bus-5', 820)
  park(parking, 'lane-miko-1', 817, null)
  park(parking, '2026-10-10-a', 607)
  mkdirSync(path.join(parking, 'lane-2'))
  mkdirSync(path.join(parking, '2026-10-10-b'))
  mkdirSync(path.join(parking, 'notes'))
  writeFileSync(path.join(parking, 'notes', 'n.md'), 'note\n')
  mkdirSync(path.join(parking, 'archive'))
  writeFileSync(path.join(parking, 'archive', '1.md'), card(1, ['a.ts']))
  writeFileSync(path.join(parking, '997.md'), card(997, ['b.ts']))
  return parking
}

function lanesWithCards(parking: string): Map<string, string[]> {
  return new Map(readdirSync(parking, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(parking, entry.name, 'lane.json')))
    .map(entry => [entry.name, laneCards(path.join(parking, entry.name))]))
}

describe('the lane migration', () => {
  it('after the migration no lane directory has a name other than lane-NN', () => {
    const parking = legacyParking()
    migrate(parking, [])
    const dirs = readdirSync(parking, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(dirs).toEqual(['archive', 'lane-01', 'lane-02', 'lane-03', 'lane-04', 'notes'])
    expect(dirs.filter(name => existsSync(path.join(parking, name, 'lane.json'))).every(name => LANE_NAME.test(name))).toBe(true)
    expect(readFileSync(path.join(parking, 'notes', 'n.md'), 'utf8')).toBe('note\n')
    expect(existsSync(path.join(parking, '997.md'))).toBe(true)
  })

  it('every lane after the migration has a valid lane.json, unknown where the old metadata cannot restore a field', () => {
    const parking = legacyParking()
    migrate(parking, [])
    const lanes = [...lanesWithCards(parking).keys()].sort()
    expect(lanes).toHaveLength(4)
    for (const lane of lanes) {
      const json = JSON.parse(readFileSync(path.join(parking, lane, 'lane.json'), 'utf8')) as unknown
      expect(laneJsonProblems(json)).toEqual([])
      expect(json).toMatchObject({ purpose: UNKNOWN, createdBy: UNKNOWN, createdAt: UNKNOWN, status: 'open' })
    }
    expect(readLaneJson(path.join(parking, 'lane-02')).touches).toEqual(['scripts/c61.ts', 'scripts/c738.ts', 'scripts/c750.ts'])
    expect(readLaneJson(path.join(parking, 'lane-04')).touches).toBe(UNKNOWN)
  })

  it('the set and the order of cards in each lane are the same before and after the migration', () => {
    const parking = legacyParking()
    const before = new Map(['2026-10-10-a', 'lane-1', 'lane-bus-5', 'lane-miko-1'].map(lane => [lane, laneCards(path.join(parking, lane))]))
    const moves = migrate(parking, [])
    const after = lanesWithCards(parking)
    for (const move of moves) {
      if (move.kind === 'rename')
        expect(after.get(path.basename(move.to))).toEqual(before.get(path.basename(move.from)))
    }
    expect([...after.values()]).toEqual([...before.values()])
    expect(before.get('lane-1')).toEqual(['61.md', '738.md', '750.md'])
  })

  it('empty lanes are removed and a lane already in the contract keeps its name and number', () => {
    const parking = legacyParking()
    park(parking, 'lane-07', 900)
    writeLaneJson(path.join(parking, 'lane-07'), { purpose: 'kept', touches: ['x.ts'], createdBy: 'owner', createdAt: '2026-10-12', status: 'open' })
    const moves = migrate(parking, [])
    expect(moves.filter(move => move.kind === 'remove').map(move => path.basename(move.from))).toEqual(['2026-10-10-b', 'lane-2'])
    expect(moves.flatMap(move => move.kind === 'rename' ? [path.basename(move.to)] : [])).toEqual(['lane-08', 'lane-09', 'lane-10', 'lane-11'])
    expect(readLaneJson(path.join(parking, 'lane-07')).purpose).toBe('kept')
  })

  it('the migration refuses while a chain is live in a lane it would rename', () => {
    const parking = legacyParking()
    const before = readdirSync(parking).sort()
    expect(() => migrate(parking, [path.join(parking, 'lane-bus-5')])).toThrow(LaneMigrationRefused)
    expect(() => migrate(parking, [path.join(parking, 'lane-bus-5')])).toThrow(`a chain is live in ${path.join(parking, 'lane-bus-5')}: nothing was migrated`)
    expect(readdirSync(parking).sort()).toEqual(before)
    expect(planMigration(parking)).toHaveLength(6)
  })

  it('the live lanes are the parking of every running or waiting chain in the bus', () => {
    const db = openBus(path.join(parkingRoot(), 'bus.db'))
    const chain = (dir: string, cardId: number, parking: string, state: ChainState): void => {
      observeChain(db, '2026-10-18T12:00:00.000Z', 'worker:chain:c1', { dir, parking, cardId, sha: 'a'.repeat(40), pid: 10 + cardId, leader: null, boundary: false, state, ...(state === 'waiting' ? { waitingOn: [9] } : {}) })
    }
    chain('/s/a', 1, '/p/lane-bus-5', 'running')
    chain('/s/b', 2, '/p/lane-miko-1', 'waiting')
    chain('/s/c', 3, '/p/lane-1', 'stopped')
    expect(liveChainLanes(db).sort()).toEqual(['/p/lane-bus-5', '/p/lane-miko-1'])
    db.close()
  })
})
