import type { CommandReading } from '../detect/git.js'
import type { SpecifierTargets } from './imports/specifiers.js'
import type { ModuleReading } from './scan.js'
import type { CommandSource, Component, Mechanics, Relation, RepositoryModel } from './schema.js'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { readHead, readTrackedFiles } from '../detect/git.js'
import { discoverContours } from './contours.js'
import { importReaderFor } from './imports/index.js'
import { readPathAliases } from './imports/path-aliases.js'
import { readWorkspaces } from './imports/workspaces.js'
import { MODEL_FILE, MODEL_VERSION } from './schema.js'
import { readModel, writeModel } from './write.js'

export interface GitReadings {
  head: CommandReading
  tracked: CommandReading
}

export const ENGRAM_HOME_DIR = '.construct/engram'

const RESOLVED_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
}
const IMPLICIT_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']
const FULL_SHA = /^[0-9a-f]{40,64}$/

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sourceOf(reading: CommandReading): CommandSource {
  return { command: reading.command, exit: reading.exit, effects: reading.effects }
}

export function readGit(root: string): GitReadings {
  return { head: readHead(root), tracked: readTrackedFiles(root) }
}

function candidates(target: string): string[] {
  const extension = path.posix.extname(target)
  const swapped = (RESOLVED_EXTENSIONS[extension] ?? []).map(replacement => `${target.slice(0, -extension.length)}${replacement}`)
  return [target, ...swapped, ...IMPLICIT_SUFFIXES.map(suffix => `${target}${suffix}`)]
}

interface Resolution {
  tracked: Set<string>
  nonRelative: SpecifierTargets[]
}

function targetsOf(from: string, specifier: string, resolution: Resolution): string[] | null {
  if (specifier.startsWith('.'))
    return [path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))]
  for (const targets of resolution.nonRelative) {
    const found = targets(from, specifier)
    if (found != null)
      return found
  }
  return null
}

function resolve(targets: string[], tracked: Set<string>): string | null {
  return targets.flatMap(candidates).find(candidate => tracked.has(candidate)) ?? null
}

function readInside(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file)
    if (!lstatSync(absolute).isFile() || !realpathSync(absolute).startsWith(`${realpathSync(root)}${path.sep}`))
      return null
    return readFileSync(absolute, 'utf8')
  }
  catch {
    return null
  }
}

interface ComponentReading {
  component: Component
  relations: Relation[]
}

function readComponent(root: string, file: string, resolution: Resolution): ComponentReading {
  const reader = importReaderFor(file)
  if (reader === undefined)
    return { component: { id: file, path: file, relations: 'unknown', reason: 'type-not-scanned' }, relations: [] }
  const source = readInside(root, file)
  if (source == null)
    return { component: { id: file, path: file, relations: 'unknown', reason: 'unreadable' }, relations: [] }
  return { component: { id: file, path: file, relations: 'found' }, relations: relationsOf(reader.read(source), file, resolution) }
}

function relationsOf(reading: ModuleReading, file: string, resolution: Resolution): Relation[] {
  const relations: Relation[] = []
  const owners = new Map<string, { to: string | null, specifier: string }>()
  for (const entry of reading.imports) {
    const targets = targetsOf(file, entry.specifier, resolution)
    if (targets == null)
      continue
    const to = resolve(targets, resolution.tracked)
    relations.push({ from: file, to, kind: 'imports', specifier: entry.specifier, status: to == null ? 'unknown' : 'found', source: { path: file, line: entry.line } })
    for (const name of [...entry.bindings, ...entry.namespaces])
      owners.set(name, { to, specifier: entry.specifier })
  }
  for (const call of reading.calls) {
    const owner = owners.get(call.name)
    if (owner === undefined)
      continue
    relations.push({ from: file, to: owner.to, kind: 'calls', specifier: owner.specifier, status: owner.to == null ? 'unknown' : 'found', source: { path: file, line: call.line } })
  }
  return relations
}

function relationKey(relation: Relation): string {
  return [relation.from, String(relation.source.line).padStart(9, '0'), relation.kind, relation.specifier, relation.to ?? ''].join('\u0000')
}

export function discoverMechanics(root: string, readings: GitReadings = readGit(root)): Mechanics {
  const sha = readings.head.stdout.trim()
  const shaFound = readings.head.exit === 0 && FULL_SHA.test(sha)
  const treeFound = readings.tracked.exit === 0
  const files = treeFound ? readings.tracked.stdout.split('\0').filter(file => file !== '') : []
  const tracked = new Set(files)
  const readFile = (file: string): string | null => tracked.has(file) ? readInside(root, file) : null
  const resolution: Resolution = { tracked, nonRelative: [readPathAliases(tracked, readFile), readWorkspaces(files, readFile)] }
  const read = [...files].sort(compare).map(file => readComponent(root, file, resolution))
  const components: Component[] = read.map(reading => reading.component)
  const unique = new Map<string, Relation>()
  for (const reading of read) {
    for (const relation of reading.relations)
      unique.set(relationKey(relation), relation)
  }
  return {
    identity: { sha: shaFound ? sha : null, status: shaFound ? 'found' : 'unknown', source: sourceOf(readings.head) },
    tree: { status: treeFound ? 'found' : 'unknown', source: sourceOf(readings.tracked) },
    contours: treeFound ? discoverContours(path.basename(path.resolve(root)), files, readFile, target => resolve([target], tracked)) : [],
    components,
    relations: [...unique.entries()].sort(([left], [right]) => compare(left, right)).map(([, relation]) => relation),
  }
}

export interface EngramPlace {
  attached: boolean
  home: string
}

const ENGRAM_PATH_HASH_LENGTH = 12

export function engramDirectoryName(root: string): string {
  const real = realpathSync(path.resolve(root))
  const hash = createHash('sha256').update(real).digest('hex').slice(0, ENGRAM_PATH_HASH_LENGTH)
  return `${path.basename(real)}-${hash}`
}

export function engramFile(root: string, place: EngramPlace): string {
  const resolved = path.resolve(root)
  return place.attached ? path.join(place.home, ENGRAM_HOME_DIR, engramDirectoryName(resolved), MODEL_FILE) : path.join(resolved, MODEL_FILE)
}

function emptyModel(): RepositoryModel {
  return { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [] }
}

export function writeEngram(root: string, place: EngramPlace, mechanics: Mechanics = discoverMechanics(root)): string {
  const file = engramFile(root, place)
  const directory = path.dirname(file)
  mkdirSync(directory, { recursive: true })
  const existing = readModel(directory) ?? emptyModel()
  writeModel(directory, { ...existing, modelVersion: MODEL_VERSION, mechanics })
  return file
}
