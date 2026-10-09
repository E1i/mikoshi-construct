import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parkedNumbers } from './numbers.js'

export const AXES = ['autonomy', 'cost', 'self-learning', 'interface', 'architecture'] as const

const LANE_NAME = /^(?:lane-\d+|\d{4}-\d{2}-\d{2}-[a-z0-9]+)$/
const LAW_LINE = /^Решение: Law(?![\p{L}\p{N}])/mu

export function isLaw(body: string): boolean {
  return LAW_LINE.test(body)
}

export function laneOf(file: string, root: string): string | null {
  const dir = path.dirname(path.resolve(file))
  const lane = path.basename(dir)
  return path.dirname(dir) === path.resolve(root) && LANE_NAME.test(lane) ? lane : null
}

export function queueNumbers(root: string): Set<number> {
  if (!existsSync(root))
    return new Set()
  const lanes = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && LANE_NAME.test(entry.name))
  return new Set(lanes.flatMap(lane => parkedNumbers(readdirSync(path.join(root, lane.name)))))
}

export function entersFrozenQueue(id: number, body: string, blocks: readonly number[], queue: ReadonlySet<number>): boolean {
  return !isLaw(body) && !blocks.some(blocked => blocked !== id && queue.has(blocked))
}
