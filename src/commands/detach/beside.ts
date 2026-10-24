import type { FactoryBeside } from '../attach/beside.js'
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { engramFile } from '../../model/discovery.js'

const KEEP_ALIVE_DIR = path.join('Library', 'LaunchAgents')
const KEEP_ALIVE_FILE = /\.plist$/

function entriesOf(directory: string): string[] {
  try {
    return readdirSync(directory)
  }
  catch {
    return []
  }
}

export function keepAliveNaming(beside: FactoryBeside | undefined, home: string = homedir()): string[] {
  if (beside == null)
    return []
  const agents = path.join(home, KEEP_ALIVE_DIR)
  return entriesOf(agents)
    .filter(entry => KEEP_ALIVE_FILE.test(entry))
    .map(entry => path.join(agents, entry))
    .filter(file => readFileSync(file, 'utf8').includes(`${beside.home}${path.sep}`))
}

function removeUpTo(directory: string, top: string): string[] {
  const removed: string[] = []
  let current = path.dirname(directory)
  const stop = path.dirname(top)
  while (current !== stop && (current === top || current.startsWith(`${top}${path.sep}`)) && existsSync(current) && readdirSync(current).length === 0) {
    rmdirSync(current)
    removed.push(current)
    current = path.dirname(current)
  }
  return removed
}

export function removeFactoryBeside(beside: FactoryBeside | undefined): string[] {
  if (beside == null || !existsSync(beside.home))
    return []
  rmSync(beside.home, { recursive: true })
  return [beside.home, ...removeUpTo(beside.home, beside.createdFrom)]
}

export interface EngramRemoval {
  removed: string[]
  leftBehind: string[]
}

export function removeEngram(root: string, beside: FactoryBeside | undefined, home: string = homedir()): EngramRemoval {
  const file = engramFile(root, { attached: true, home })
  if (!existsSync(file))
    return { removed: [], leftBehind: [] }
  rmSync(file)
  const directory = path.dirname(file)
  const left = readdirSync(directory)
  if (left.length > 0)
    return { removed: [file], leftBehind: left.map(entry => path.join(directory, entry)) }
  rmdirSync(directory)
  const emptiedAbove = beside == null ? [] : removeUpTo(directory, beside.createdFrom)
  return { removed: [file, directory, ...emptiedAbove], leftBehind: [] }
}
