import type { FileOp } from '../../materialize/plan.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface CarrierWrite {
  written: FileOp[]
  collided: string | null
}

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

export function writeCarriersExclusively(root: string, ops: FileOp[]): CarrierWrite {
  const written: FileOp[] = []
  for (const op of ops) {
    const absolute = path.join(root, op.target)
    mkdirSync(path.dirname(absolute), { recursive: true })
    try {
      writeFileSync(absolute, op.content, { flag: 'wx' })
    }
    catch (error) {
      if (alreadyExists(error))
        return { written, collided: op.target }
      throw error
    }
    written.push(op)
  }
  return { written, collided: null }
}
