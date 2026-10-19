import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { LANE_FILE } from '../../src/commands/intake/admit.js'

export { LANE_FILE }
export const UNKNOWN = 'unknown'
export const LANE_NAME = /^(?:lane-\d{2,}|\d{4}-\d{2}-\d{2}-[a-z]+)$/

export interface LaneJson {
  purpose: string
  touches: string[] | typeof UNKNOWN
  createdBy: string
  createdAt: string
  status: string
}

const FIELDS = ['purpose', 'touches', 'createdBy', 'createdAt', 'status'] as const

const TEXT_FIELDS = ['purpose', 'createdBy', 'createdAt', 'status'] as const

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

export function laneJsonProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return ['lane.json is not an object']
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter(key => !(FIELDS as readonly string[]).includes(key)).map(key => `${key} is not a lane.json field`)
  const missing = FIELDS.filter(field => !(field in record)).map(field => `${field} is missing`)
  const texts = TEXT_FIELDS.filter(field => field in record && !isText(record[field])).map(field => `${field} is not a non-empty string`)
  const touches = record.touches
  const touchesProblem = 'touches' in record && touches !== UNKNOWN && !(Array.isArray(touches) && touches.every(isText))
    ? [`touches is neither '${UNKNOWN}' nor a list of non-empty strings`]
    : []
  return [...extra, ...missing, ...texts, ...touchesProblem]
}

export function laneFile(lane: string): string {
  return path.join(lane, LANE_FILE)
}

export function isLane(dir: string): boolean {
  return existsSync(laneFile(dir))
}

export function readLaneJson(lane: string): LaneJson {
  const value: unknown = JSON.parse(readFileSync(laneFile(lane), 'utf8'))
  const problems = laneJsonProblems(value)
  if (problems.length > 0)
    throw new Error(`${laneFile(lane)}: ${problems.join('; ')}`)
  return value as LaneJson
}

export function writeLaneJson(lane: string, json: LaneJson): void {
  const problems = laneJsonProblems(json)
  if (problems.length > 0)
    throw new Error(`${laneFile(lane)}: ${problems.join('; ')}`)
  writeFileSync(laneFile(lane), `${JSON.stringify(json, null, 2)}\n`)
}
