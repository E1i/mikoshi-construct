import type { ExcludeRemoval } from '../attach/exclude.js'
import type { AttachRecord } from '../attach/record.js'
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { applyExcludeRemoval } from '../attach/exclude.js'
import { ATTACH_LEDGER_DIR, ATTACH_RECORD_FILE } from '../attach/record.js'
import { removeEmptyDirectories } from '../attach/rollback.js'

export interface Removal {
  removed: string[]
  leftBehind: string[]
}

function entriesLeftIn(root: string, directory: string, known: Set<string>): string[] {
  const absolute = path.join(root, directory)
  if (!existsSync(absolute))
    return []
  return readdirSync(absolute).map(entry => `${directory}/${entry}`).filter(entry => !known.has(entry))
}

export function removeAttached(root: string, record: AttachRecord, files: string[], exclude: ExcludeRemoval): Removal {
  for (const target of files)
    rmSync(path.join(root, target))
  const directories = removeEmptyDirectories(root, record.directories)
  const known = new Set([...Object.keys(record.files), ...record.directories, ATTACH_RECORD_FILE])
  const leftBehind = [...record.directories, ATTACH_LEDGER_DIR].flatMap(directory => entriesLeftIn(root, directory, known))
  applyExcludeRemoval(root, exclude)
  rmSync(path.join(root, ATTACH_RECORD_FILE))
  if (record.ledgerCreated === true && readdirSync(path.join(root, ATTACH_LEDGER_DIR)).length === 0)
    rmdirSync(path.join(root, ATTACH_LEDGER_DIR))
  return { removed: [...files, ...directories], leftBehind }
}
