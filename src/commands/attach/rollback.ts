import type { FileOp } from '../../materialize/plan.js'
import type { ExcludeWrite } from './exclude.js'
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '../../manifest.js'
import { restoreExclude } from './exclude.js'

export interface RollbackInput {
  written: FileOp[]
  directories: string[]
  exclude: ExcludeWrite
}

function stillWhatThisRunWrote(absolute: string, op: FileOp): boolean {
  return existsSync(absolute) && sha256(readFileSync(absolute, 'utf8')) === sha256(op.content)
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
  for (const directory of [...input.directories].reverse()) {
    const absolute = path.join(root, directory)
    if (existsSync(absolute) && readdirSync(absolute).length === 0)
      rmdirSync(absolute)
  }
  restoreExclude(root, input.exclude)
  return removed
}
