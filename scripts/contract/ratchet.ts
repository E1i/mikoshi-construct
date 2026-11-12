import type { LawCells } from '../nodes/laws.js'
import type { GitRunner } from '../ports/git.js'
import type { ModuleGraphSpec } from './factory/modules.js'
import type { BoundarySide } from './module-graph/boundary.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gapRows, LAW_CELLS } from '../nodes/laws.js'
import { processGit } from '../ports/git.js'
import { MODULE_GRAPH } from './factory/modules.js'
import { findSites, overlapsSection } from './factory/overlaps.js'
import { parsedFiles } from './factory/walk.js'
import { BOUNDARY_PREFIX, boundaryNumbers, boundaryReport, identifiedViolations, movedRows } from './module-graph/boundary.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const THRESHOLD_KEY = 'threshold'
const LINE_SCOPE_KEY = 'lines-scope:non-test-code-in-scripts-and-src'
const MAIN_REFS = ['origin/main', 'main']
const SPEC_MODULE = 'scripts/contract/factory/modules.ts'
const DEPENDENCIES = 'node_modules'
const OUTPUT_LIMIT = 1 << 30
const RENAMED = /^R\d*$/

export type SpecReader = (tree: string) => ModuleGraphSpec

export interface MoveSources {
  headSpec?: ModuleGraphSpec
  readSpec?: SpecReader
  mainRefs?: readonly string[]
  git?: GitRunner
}

export const LAW_GAP_PREFIX = 'law-gaps:'

export const RATCHET_RECORD = 'contract/ratchet.json'

export type RatchetNumbers = Record<string, number>

export function overlapNumbers(section: Record<string, Record<string, number>>): RatchetNumbers {
  return Object.fromEntries(Object.entries(section).map(([concept, files]) =>
    [`overlaps:${concept}`, Object.values(files).reduce((sum, count) => sum + count, 0)]))
}

export function bigFileNumbers(root: string, threshold: number): RatchetNumbers {
  return Object.fromEntries(parsedFiles(root)
    .map(({ file, source }) => [file, source.text.trimEnd().split('\n').length] as const)
    .filter(([, lines]) => lines > threshold)
    .map(([file, lines]) => [`lines:${file}`, lines]))
}

export function lawGapNumbers(cells: LawCells = LAW_CELLS): RatchetNumbers {
  return Object.fromEntries(gapRows(cells).map(({ law, node }) => [`${LAW_GAP_PREFIX}${law}:${node}`, 1]))
}

export function generateNumbers(root: string, threshold: number): RatchetNumbers {
  return { [THRESHOLD_KEY]: threshold, [LINE_SCOPE_KEY]: 1, ...overlapNumbers(overlapsSection(findSites(root))), ...bigFileNumbers(root, threshold), ...lawGapNumbers(), ...boundaryNumbers(boundaryReport(root).violations) }
}

export function ratchetBreaks(recorded: RatchetNumbers, generated: RatchetNumbers, movedByOwnership: ReadonlySet<string> = new Set()): string[] {
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(generated)])].sort()
  return keys.flatMap((key) => {
    const [held, now] = [recorded[key] ?? 0, generated[key] ?? 0]
    if (now > held && movedByOwnership.has(key))
      return []
    if (now > held)
      return [`${key} grew from ${held} to ${now}: raising it is a change of ${RATCHET_RECORD} that carries the owner's decision`]
    if (now < held)
      return [`${key} went down from ${held} to ${now}: lower it in ${RATCHET_RECORD} in this pull request`]
    return []
  })
}

export function grownBoundaryRows(recorded: RatchetNumbers, generated: RatchetNumbers): string[] {
  return Object.keys(generated).filter(key => key.startsWith(BOUNDARY_PREFIX) && generated[key]! > (recorded[key] ?? 0)).sort()
}

export function branchBase(root: string, mainRefs: readonly string[] = MAIN_REFS, git: GitRunner = processGit): string | undefined {
  return mainRefs.map(ref => git.readOrNull(root, ['merge-base', 'HEAD', ref])?.trim()).find(base => base !== undefined && base !== '')
}

export function renamesSince(root: string, base: string, git: GitRunner = processGit): Map<string, string> {
  const rows = (git.readOrNull(root, ['diff', '--name-status', '-M', base], { maxBuffer: OUTPUT_LIMIT }) ?? '').split('\n').map(line => line.split('\t'))
  return new Map(rows.filter(([status, was, now]) => RENAMED.test(status ?? '') && was !== undefined && now !== undefined).map(([, was, now]) => [was!, now!]))
}

function treeAt(root: string, commit: string, git: GitRunner): string {
  const tree = mkdtempSync(path.join(tmpdir(), 'ratchet-base-'))
  execFileSync('tar', ['-x', '-C', tree], { input: git.readBytes(root, ['archive', '--format=tar', commit], OUTPUT_LIMIT) })
  if (existsSync(path.join(root, DEPENDENCIES)))
    symlinkSync(path.join(root, DEPENDENCIES), path.join(tree, DEPENDENCIES))
  return tree
}

export function specInTree(tree: string): ModuleGraphSpec {
  const module = pathToFileURL(path.join(tree, SPEC_MODULE)).href
  const program = `const { MODULE_GRAPH } = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(MODULE_GRAPH))`
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT })) as ModuleGraphSpec
}

function sideOf(root: string, spec: ModuleGraphSpec): BoundarySide {
  return { spec, violations: identifiedViolations(root, spec) }
}

export function ownershipMoves(root: string, grown: readonly string[], sources: MoveSources = {}): Set<string> {
  const git = sources.git ?? processGit
  const base = grown.length === 0 ? undefined : branchBase(root, sources.mainRefs, git)
  if (base === undefined)
    return new Set()
  const readSpec = sources.readSpec ?? specInTree
  const tree = treeAt(root, base, git)
  try {
    return new Set(movedRows(sideOf(tree, readSpec(tree)), sideOf(root, sources.headSpec ?? MODULE_GRAPH), grown, renamesSince(root, base, git)))
  }
  finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

export function checkRatchet(root: string, recorded: RatchetNumbers, generated: RatchetNumbers, sources: MoveSources = {}): string[] {
  return ratchetBreaks(recorded, generated, ownershipMoves(root, grownBoundaryRows(recorded, generated), sources))
}

export function readRatchet(root: string): RatchetNumbers {
  return JSON.parse(readFileSync(path.join(root, RATCHET_RECORD), 'utf8')) as RatchetNumbers
}

export function thresholdOf(recorded: RatchetNumbers): number {
  const threshold = recorded[THRESHOLD_KEY]
  if (threshold === undefined)
    throw new Error(`${RATCHET_RECORD} holds no ${THRESHOLD_KEY}`)
  return threshold
}

export function renderRatchet(numbers: RatchetNumbers): string {
  return `${JSON.stringify(Object.fromEntries(Object.keys(numbers).sort().map(key => [key, numbers[key]!])), null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  writeFileSync(path.join(REPO_ROOT, RATCHET_RECORD), renderRatchet(generateNumbers(REPO_ROOT, thresholdOf(readRatchet(REPO_ROOT)))))
