import type { FileOp } from '../../materialize/plan.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { strategyFor } from '../../materialize/strategies.js'
import { listTemplateFiles } from '../../materialize/templates.js'
import { ATTACH_WINDOW_HOOKS } from '../../presets/index.js'

export function planWindowHooks(): FileOp[] {
  const wanted: string[] = [ATTACH_WINDOW_HOOKS.target, ATTACH_WINDOW_HOOKS.rules]
  const ops: FileOp[] = listTemplateFiles(ATTACH_WINDOW_HOOKS.group)
    .filter(file => wanted.includes(file.target))
    .map(file => ({ target: file.target, strategy: strategyFor(file.target), action: 'create', content: readFileSync(file.source, 'utf8') }))
  if (ops.length !== wanted.length)
    throw new Error(`attach window hooks missing from the templates: ${wanted.join(', ')}`)
  return ops
}

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
