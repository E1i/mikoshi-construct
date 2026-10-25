import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FACTORY_FOLDERS } from '../../../scripts/core/factory-paths.js'
import { PREFIX_SUFFIX } from '../../card/task-file.js'

export const SHARED_CODE_DIRECTORIES = [
  ...FACTORY_FOLDERS.sharedCode,
  'src/card',
  'src/commands/intake',
  'src/commands/board',
  'src/commands/cost',
] as const

export const MASKABLE_ROOTS = ['tests', ...FACTORY_FOLDERS.tests, '.changeset'] as const

const CONTOUR_MAP_SECTION = /^### (\S+?)\/? \(/
const TABLE_ROW = /^\| ([^|\s][^|]*?) \|/
const TABLE_RULE = /^\|[-:| ]+\|$/
const TABLE_HEADER_CELL = 'файл'

export function defaultContourMap(): string {
  return path.join(os.homedir(), '.construct', 'probes', 'contour-map', 'contour-map.md')
}

export function readContourMap(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
  catch {
    return null
  }
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}

function scopeOf(entry: string): string {
  return entry.endsWith(PREFIX_SUFFIX) ? entry.slice(0, -PREFIX_SUFFIX.length) : entry
}

function overlapsSharedCode(scope: string): boolean {
  return SHARED_CODE_DIRECTORIES.some(directory => within(directory, scope) || within(scope, directory))
}

function maskAllowed(scope: string, created: readonly string[]): boolean {
  return MASKABLE_ROOTS.some(root => within(root, scope)) || created.some(entry => within(scopeOf(entry), scope))
}

export function contourMapFiles(contourMap: string, scope: string): string[] {
  const files: string[] = []
  let section: string | null = null
  for (const line of contourMap.split('\n')) {
    const heading = CONTOUR_MAP_SECTION.exec(line)
    if (heading !== null) {
      section = heading[1]!
      continue
    }
    if (line.startsWith('#'))
      section = null
    const cell = TABLE_ROW.exec(line)?.[1]
    if (section === null || cell === undefined || cell === TABLE_HEADER_CELL || TABLE_RULE.test(line))
      continue
    const file = `${section}/${cell}`
    if (within(scope, file))
      files.push(file)
  }
  return files
}

function refusalOf(mask: string, contourMap: string | null): string {
  const files = contourMap === null ? [] : contourMapFiles(contourMap, scopeOf(mask))
  const named = `touches entry '${mask}' masks shared code; name the files the change edits`
  return files.length === 0 ? named : `${named}: ${files.join(', ')}`
}

export function sharedCodeMaskRefusals(touches: readonly string[], created: readonly string[], contourMap: string | null): string[] {
  return touches
    .filter(touch => touch.endsWith(PREFIX_SUFFIX) && overlapsSharedCode(scopeOf(touch)) && !maskAllowed(scopeOf(touch), created))
    .map(mask => refusalOf(mask, contourMap))
}
