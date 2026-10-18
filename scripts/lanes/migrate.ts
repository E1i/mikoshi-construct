import type { DatabaseSync } from 'node:sqlite'
import type { LaneJson } from './lane-json.js'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { isLane, LANE_NAME, laneName, laneNumber, UNKNOWN, writeLaneJson } from './lane-json.js'

export const LEGACY_LANES = [/^lane-/, /^night-/, /^\d{4}-\d{2}-\d{2}-/]
export const OPEN = 'open'

const CARD_FILE = /^\d+\.md$/

export type LaneMove
  = | { kind: 'rename', from: string, to: string, cards: string[], lane: LaneJson }
    | { kind: 'remove', from: string }

export class LaneMigrationRefused extends Error {}

function isLegacyLane(parking: string, name: string): boolean {
  if (LANE_NAME.test(name) && isLane(path.join(parking, name)))
    return false
  return LEGACY_LANES.some(pattern => pattern.test(name))
}

function laneDirs(parking: string): string[] {
  return readdirSync(parking, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

export function laneCards(lane: string): string[] {
  return readdirSync(lane).filter(name => CARD_FILE.test(name)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
}

function touchesOf(lane: string, cards: string[]): LaneJson['touches'] {
  const touches = new Set<string>()
  for (const card of cards) {
    const parsed = parseParkingFile(card, readFileSync(path.join(lane, card), 'utf8'))
    if (parsed.kind === 'refused' || parsed.parked.task.touches.length === 0)
      return UNKNOWN
    parsed.parked.task.touches.forEach(touch => touches.add(touch))
  }
  return [...touches].sort()
}

export function planMigration(parking: string): LaneMove[] {
  const names = laneDirs(parking)
  let next = Math.max(0, ...names.map(name => isLane(path.join(parking, name)) ? laneNumber(name) ?? 0 : 0)) + 1
  return names.filter(name => isLegacyLane(parking, name)).sort().map((name): LaneMove => {
    const from = path.join(parking, name)
    if (readdirSync(from).length === 0)
      return { kind: 'remove', from }
    const cards = laneCards(from)
    const lane: LaneJson = { purpose: UNKNOWN, touches: touchesOf(from, cards), createdBy: UNKNOWN, createdAt: UNKNOWN, status: OPEN }
    return { kind: 'rename', from, to: path.join(parking, laneName(next++)), cards, lane }
  })
}

export function migrate(parking: string, liveLanes: readonly string[]): LaneMove[] {
  const moves = planMigration(parking)
  const live = new Set(liveLanes.map(lane => path.resolve(lane)))
  const held = moves.filter(move => live.has(path.resolve(move.from))).map(move => move.from)
  if (held.length > 0)
    throw new LaneMigrationRefused(`a chain is live in ${held.join(', ')}: nothing was migrated; run the migration once the chain has stopped`)
  for (const move of moves) {
    if (move.kind === 'remove') {
      rmdirSync(move.from)
      continue
    }
    renameSync(move.from, move.to)
    writeLaneJson(move.to, move.lane)
  }
  return moves
}

export function liveChainLanes(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT DISTINCT parking FROM chains WHERE state IN ('running', 'waiting')`).all() as unknown as { parking: string }[]
  return rows.map(row => row.parking)
}

function describe(move: LaneMove): string {
  return move.kind === 'remove' ? `remove ${move.from} (empty)` : `rename ${move.from} → ${move.to} (${move.cards.length} cards)`
}

function main(argv: string[]): number {
  const index = argv.indexOf('--parking')
  const parking = index === -1 ? path.join(os.homedir(), '.construct', 'parking') : argv[index + 1]!
  const busPath = defaultBusPath()
  if (argv.includes('--dry-run')) {
    planMigration(parking).forEach(move => console.log(describe(move)))
    return 0
  }
  const db = existsSync(busPath) ? openBus(busPath) : null
  try {
    migrate(parking, db === null ? [] : liveChainLanes(db)).forEach(move => console.log(describe(move)))
    return 0
  }
  catch (error) {
    if (!(error instanceof LaneMigrationRefused))
      throw error
    console.error(error.message)
    return 1
  }
  finally {
    db?.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
