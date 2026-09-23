import type { BlockSeparator } from '../../materialize/strategies.js'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendBlockWith, blockMarkers, removeBlock } from '../../materialize/strategies.js'

export const EXCLUDE_FILE = '.git/info/exclude'
export const LEDGER_DIR = '.construct/'

export interface ExcludeWrite {
  created: boolean
  separator: BlockSeparator
}

export function excludeBlockBody(carriers: string[]): string {
  return [LEDGER_DIR, ...carriers].join('\n')
}

export function pathsInExcludeBlock(exclude: string): string[] {
  const [begin, end] = blockMarkers(EXCLUDE_FILE)
  const start = exclude.indexOf(begin)
  const stop = exclude.indexOf(end)
  if (start === -1 || stop === -1 || stop < start)
    return []
  return exclude.slice(start + begin.length, stop).split('\n').map(line => line.trim()).filter(line => line !== '')
}

export function readExcludeBlockPaths(root: string): string[] {
  const file = path.join(root, EXCLUDE_FILE)
  return existsSync(file) ? pathsInExcludeBlock(readFileSync(file, 'utf8')) : []
}

export function writeExcludeBlock(root: string, carriers: string[]): ExcludeWrite {
  const file = path.join(root, EXCLUDE_FILE)
  const created = !existsSync(file)
  const previous = created ? '' : readFileSync(file, 'utf8')
  mkdirSync(path.dirname(file), { recursive: true })
  const appended = appendBlockWith(previous, excludeBlockBody(carriers), EXCLUDE_FILE)
  writeFileSync(file, appended.content)
  return { created, separator: appended.separator }
}

export function removeExcludeBlock(root: string, separator: BlockSeparator): void {
  const file = path.join(root, EXCLUDE_FILE)
  if (!existsSync(file))
    return
  const remaining = removeBlock(readFileSync(file, 'utf8'), EXCLUDE_FILE, separator)
  if (remaining === '') {
    rmSync(file)
    return
  }
  writeFileSync(file, remaining)
}
