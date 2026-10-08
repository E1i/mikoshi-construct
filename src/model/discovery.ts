import type { CommandReading } from '../detect/git.js'
import type { CommandSource, Component, Mechanics, Relation, RepositoryModel } from './schema.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readHead, readTrackedFiles } from '../detect/git.js'
import { scanModule } from './scan.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from './schema.js'

export interface GitReadings {
  head: CommandReading
  tracked: CommandReading
}

export const ENGRAM_HOME_DIR = '.construct/engram'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
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

function isSource(file: string): boolean {
  return SOURCE_EXTENSIONS.some(extension => file.endsWith(extension))
}

function candidates(target: string): string[] {
  const extension = path.posix.extname(target)
  const swapped = (RESOLVED_EXTENSIONS[extension] ?? []).map(replacement => `${target.slice(0, -extension.length)}${replacement}`)
  return [target, ...swapped, ...IMPLICIT_SUFFIXES.map(suffix => `${target}${suffix}`)]
}

function resolve(from: string, specifier: string, tracked: Set<string>): string | null {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  return candidates(target).find(candidate => tracked.has(candidate)) ?? null
}

function relationsOf(root: string, file: string, tracked: Set<string>): Relation[] {
  let source: string
  try {
    source = readFileSync(path.join(root, file), 'utf8')
  }
  catch {
    return []
  }
  const reading = scanModule(source)
  const relations: Relation[] = []
  const owners = new Map<string, { to: string | null, specifier: string }>()
  for (const entry of reading.imports) {
    if (!entry.specifier.startsWith('.'))
      continue
    const to = resolve(file, entry.specifier, tracked)
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
  const components: Component[] = files.filter(isSource).sort(compare).map(file => ({ id: file, path: file }))
  const unique = new Map<string, Relation>()
  for (const component of components) {
    for (const relation of relationsOf(root, component.path, tracked))
      unique.set(relationKey(relation), relation)
  }
  return {
    identity: { sha: shaFound ? sha : null, status: shaFound ? 'found' : 'unknown', source: sourceOf(readings.head) },
    tree: { status: treeFound ? 'found' : 'unknown', source: sourceOf(readings.tracked) },
    components,
    relations: [...unique.entries()].sort(([left], [right]) => compare(left, right)).map(([, relation]) => relation),
  }
}

export interface EngramPlace {
  attached: boolean
  home: string
}

export function engramFile(root: string, place: EngramPlace): string {
  const resolved = path.resolve(root)
  return place.attached ? path.join(place.home, ENGRAM_HOME_DIR, path.basename(resolved), MODEL_FILE) : path.join(resolved, MODEL_FILE)
}

function emptyModel(): RepositoryModel {
  return { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [] }
}

export function writeEngram(root: string, place: EngramPlace, mechanics: Mechanics = discoverMechanics(root)): string {
  const file = engramFile(root, place)
  const existing = existsSync(file) ? parseModel(readFileSync(file, 'utf8'), MODEL_FILE) : emptyModel()
  const source = `${JSON.stringify({ ...existing, modelVersion: MODEL_VERSION, mechanics }, null, 2)}\n`
  parseModel(source, MODEL_FILE)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}
