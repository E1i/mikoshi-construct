import type { LawCells } from '../nodes/laws.js'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gapRows, LAW_CELLS } from '../nodes/laws.js'
import { findSites, overlapsSection } from './factory/overlaps.js'
import { parsedFiles } from './factory/walk.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const THRESHOLD_KEY = 'threshold'
const LINE_SCOPE_KEY = 'lines-scope:non-test-code-in-scripts-and-src'

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
  return { [THRESHOLD_KEY]: threshold, [LINE_SCOPE_KEY]: 1, ...overlapNumbers(overlapsSection(findSites(root))), ...bigFileNumbers(root, threshold), ...lawGapNumbers() }
}

export function ratchetBreaks(recorded: RatchetNumbers, generated: RatchetNumbers): string[] {
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(generated)])].sort()
  return keys.flatMap((key) => {
    const [held, now] = [recorded[key] ?? 0, generated[key] ?? 0]
    if (now > held)
      return [`${key} grew from ${held} to ${now}: raising it is a change of ${RATCHET_RECORD} that carries the owner's decision`]
    if (now < held)
      return [`${key} went down from ${held} to ${now}: lower it in ${RATCHET_RECORD} in this pull request`]
    return []
  })
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
