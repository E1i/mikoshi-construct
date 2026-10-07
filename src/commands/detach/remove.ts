import type { ExcludeRemoval } from '../attach/exclude.js'
import type { AttachRecord } from '../attach/record.js'
import type { RuntimeRemoval } from './runtime.js'
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { ATTACH_RUNTIME_BROWSER } from '../attach/carriers.js'
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

function removedOnce(action: () => void, tolerated: string[]): boolean {
  try {
    action()
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && tolerated.includes(error.code))
      return false
    throw error
  }
}

function removeFile(root: string, target: string): string[] {
  return removedOnce(() => rmSync(path.join(root, target)), ['ENOENT']) ? [target] : []
}

function removeDirectory(root: string, target: string): string[] {
  return removedOnce(() => rmdirSync(path.join(root, target)), ['ENOENT', 'ENOTEMPTY']) ? [target] : []
}

export function removeAttached(root: string, record: AttachRecord, files: string[], runtime: RuntimeRemoval): Removal {
  for (const target of files)
    rmSync(path.join(root, target))
  const directories = removeEmptyDirectories(root, record.directories)
  const runtimeFiles = runtime.files.flatMap(target => removeFile(root, target))
  const runs = runtime.runs.flatMap(run => [...run.shots.flatMap(shot => removeFile(root, shot)), ...removeDirectory(root, run.directory)])
  const browser = runtime.browser ? removeDirectory(root, ATTACH_RUNTIME_BROWSER) : []
  const known = new Set([...Object.keys(record.files), ...record.directories, ATTACH_RECORD_FILE])
  const leftBehind = [...record.directories, ATTACH_LEDGER_DIR].flatMap(directory => entriesLeftIn(root, directory, known))
  return { removed: [...files, ...directories, ...runtimeFiles, ...runs, ...browser], leftBehind }
}

export function closeRecord(root: string, record: AttachRecord, exclude: ExcludeRemoval): void {
  applyExcludeRemoval(root, exclude)
  rmSync(path.join(root, ATTACH_RECORD_FILE))
  if (record.ledgerCreated === true && readdirSync(path.join(root, ATTACH_LEDGER_DIR)).length === 0)
    rmdirSync(path.join(root, ATTACH_LEDGER_DIR))
}
