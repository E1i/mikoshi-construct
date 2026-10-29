import type { FactoryBeside } from '../attach/beside.js'
import type { RuntimeRemoval } from './runtime.js'
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { engramFile } from '../../model/discovery.js'
import { ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_DAEMON } from '../attach/carriers.js'

export interface PreviewEntry {
  target: string
  paths: number
  depth: number
}

export interface DetachPreview {
  entries: PreviewEntry[]
  files: number
  total: number
}

const RUN_PARENTS = new Set([ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_DAEMON])
const BESIDE_DEPTH = 2

function isDirectory(absolute: string): boolean {
  try {
    return lstatSync(absolute).isDirectory()
  }
  catch {
    return false
  }
}

function exists(absolute: string): boolean {
  try {
    lstatSync(absolute)
    return true
  }
  catch {
    return false
  }
}

export function countPaths(absolute: string): number {
  if (!exists(absolute))
    return 0
  if (!isDirectory(absolute))
    return 1
  return 1 + readdirSync(absolute).reduce((sum, entry) => sum + countPaths(path.join(absolute, entry)), 0)
}

function besideEntries(directory: string, shown: string, depth: number): PreviewEntry[] {
  const entry = { target: shown, paths: countPaths(directory), depth }
  if (depth >= BESIDE_DEPTH || !isDirectory(directory))
    return [entry]
  const children = readdirSync(directory).sort().flatMap(name => besideEntries(path.join(directory, name), `${shown}/${name}`, depth + 1))
  return [entry, ...children]
}

function runEntries(root: string, runtime: RuntimeRemoval): PreviewEntry[] {
  return runtime.runs
    .filter(run => RUN_PARENTS.has(path.posix.dirname(run.directory)))
    .map(run => ({ target: run.directory, paths: countPaths(path.join(root, run.directory)), depth: 0 }))
}

export function previewDetach(root: string, files: number, runtime: RuntimeRemoval, beside: FactoryBeside | undefined, home: string = homedir()): DetachPreview {
  const runs = runEntries(root, runtime)
  const factory = beside != null && isDirectory(beside.home) ? besideEntries(beside.home, beside.home, 0) : []
  const engram = engramFile(root, { attached: true, home })
  const engramEntry = exists(engram) ? [{ target: engram, paths: 1, depth: 0 }] : []
  const entries = [...runs, ...factory, ...engramEntry]
  const fileCount = files + runtime.files.length
  const total = fileCount + entries.filter(entry => entry.depth === 0).reduce((sum, entry) => sum + entry.paths, 0)
  return { entries, files: fileCount, total }
}
