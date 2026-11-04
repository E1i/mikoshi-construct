import type { FileOp } from '../../materialize/plan.js'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { sha256 } from '../../manifest.js'
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

export interface CarrierUpgrade {
  rewrite: FileOp[]
  create: FileOp[]
  adopted: string[]
  changed: string[]
  collided: string[]
}

type CarrierOnDisk = { kind: 'absent' } | { kind: 'not-a-carrier' } | { kind: 'file', sha: string }

function presentAt(absolute: string): boolean {
  try {
    lstatSync(absolute)
    return true
  }
  catch {
    return false
  }
}

function resolvesInsideRoot(root: string, target: string): boolean {
  let relative = target
  while (relative !== '.' && !presentAt(path.join(root, relative)))
    relative = path.dirname(relative)
  const realRoot = realpathSync(root)
  try {
    return realpathSync(path.join(root, relative)) === path.join(realRoot, relative)
  }
  catch {
    return false
  }
}

function carrierOnDisk(root: string, target: string): CarrierOnDisk {
  if (!resolvesInsideRoot(root, target))
    return { kind: 'not-a-carrier' }
  const absolute = path.join(root, target)
  if (!presentAt(absolute))
    return { kind: 'absent' }
  if (!lstatSync(absolute).isFile())
    return { kind: 'not-a-carrier' }
  return { kind: 'file', sha: sha256(readFileSync(absolute, 'utf8')) }
}

export function planCarrierUpgrade(root: string, ops: FileOp[], recorded: Readonly<Record<string, string>>, tracked: ReadonlySet<string>): CarrierUpgrade {
  const upgrade: CarrierUpgrade = { rewrite: [], create: [], adopted: [], changed: [], collided: [] }
  for (const op of ops) {
    const recordedSha = recorded[op.target]
    const disk = carrierOnDisk(root, op.target)
    if (tracked.has(op.target))
      upgrade.adopted.push(op.target)
    else if (recordedSha === undefined && disk.kind === 'absent')
      upgrade.create.push(op)
    else if (recordedSha === undefined)
      upgrade.collided.push(op.target)
    else if (disk.kind === 'not-a-carrier')
      upgrade.changed.push(op.target)
    else if (disk.kind === 'absent' || (disk.sha === recordedSha && disk.sha !== sha256(op.content)))
      upgrade.rewrite.push(op)
    else if (disk.sha !== sha256(op.content))
      upgrade.changed.push(op.target)
  }
  return upgrade
}

export function rewriteCarrier(root: string, op: FileOp): void {
  const absolute = path.join(root, op.target)
  const temporary = `${absolute}.${process.pid}.tmp`
  mkdirSync(path.dirname(absolute), { recursive: true })
  try {
    writeFileSync(temporary, op.content, { flag: 'wx' })
    if (presentAt(absolute))
      chmodSync(temporary, statSync(absolute).mode & 0o777)
    renameSync(temporary, absolute)
  }
  catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
