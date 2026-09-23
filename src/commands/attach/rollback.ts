import type { FileOp } from '../../materialize/plan.js'
import type { BlockSeparator } from '../../materialize/strategies.js'
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '../../manifest.js'
import { removeExcludeBlock } from './exclude.js'

export interface RollbackInput {
  written: FileOp[]
  directories: string[]
  separator: BlockSeparator
}

function stillWhatThisRunWrote(absolute: string, op: FileOp): boolean {
  return existsSync(absolute) && sha256(readFileSync(absolute, 'utf8')) === sha256(op.content)
}

export function removeEmptyDirectories(root: string, directories: string[]): string[] {
  const removed: string[] = []
  for (const directory of [...directories].reverse()) {
    const absolute = path.join(root, directory)
    if (!existsSync(absolute) || readdirSync(absolute).length > 0)
      continue
    rmdirSync(absolute)
    removed.push(directory)
  }
  return removed
}

export function rollbackAttach(root: string, input: RollbackInput): string[] {
  const removed: string[] = []
  for (const op of input.written) {
    const absolute = path.join(root, op.target)
    if (!stillWhatThisRunWrote(absolute, op))
      continue
    rmSync(absolute)
    removed.push(op.target)
  }
  removeEmptyDirectories(root, input.directories)
  removeExcludeBlock(root, input.separator)
  return removed
}
