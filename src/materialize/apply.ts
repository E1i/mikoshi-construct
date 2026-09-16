import type { FileOp } from './plan.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function applyPlan(root: string, ops: FileOp[]): FileOp[] {
  const written: FileOp[] = []
  for (const op of ops) {
    if (op.action === 'skip')
      continue
    const absolute = path.join(root, op.target)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, op.content)
    written.push(op)
  }
  return written
}
