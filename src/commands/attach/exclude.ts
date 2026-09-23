import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendBlock, blockMarkers } from '../../materialize/strategies.js'

export const EXCLUDE_FILE = '.git/info/exclude'
export const LEDGER_DIR = '.construct/'

export interface ExcludeWrite {
  created: boolean
  infoDirCreated: boolean
  previous: string | null
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

export function writeExcludeBlock(root: string, carriers: string[]): ExcludeWrite {
  const file = path.join(root, EXCLUDE_FILE)
  const created = !existsSync(file)
  const infoDirCreated = !existsSync(path.dirname(file))
  const previous = created ? null : readFileSync(file, 'utf8')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, appendBlock(previous ?? '', excludeBlockBody(carriers), EXCLUDE_FILE))
  return { created, infoDirCreated, previous }
}

export function restoreExclude(root: string, write: ExcludeWrite): void {
  const file = path.join(root, EXCLUDE_FILE)
  if (write.previous != null) {
    writeFileSync(file, write.previous)
    return
  }
  rmSync(file, { force: true })
  if (write.infoDirCreated)
    rmdirSync(path.dirname(file))
}
