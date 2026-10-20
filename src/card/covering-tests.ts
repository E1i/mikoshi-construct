import path from 'node:path'
import { PREFIX_SUFFIX } from './task-file.js'

export const TEST_ROOTS = ['tests', 'scripts/tests']
export const PACKAGE_MANIFEST = 'package.json'
export const PACKAGE_SCRIPT_READERS = ['tests/contributing-scripts.test.ts', 'tests/harness-membership.test.ts']
const TEST_FILE = /\.test\.ts$/
const MODULE_FILE = /\.[cm]?[jt]s$/
const RELATIVE_SPECIFIER = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
const COMPILED_TO_SOURCE: readonly (readonly [RegExp, string])[] = [[/\.js$/, '.ts'], [/\.mjs$/, '.mts'], [/\.cjs$/, '.cts']]

export function isTest(file: string): boolean {
  return TEST_FILE.test(file) && TEST_ROOTS.some(root => file.startsWith(`${root}/`))
}

export function withinTouches(file: string, touches: readonly string[]): boolean {
  return touches.some(entry => entry.endsWith(PREFIX_SUFFIX)
    ? file.startsWith(`${entry.slice(0, -PREFIX_SUFFIX.length)}/`)
    : file === entry)
}

function resolvedImport(file: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  return [joined, ...COMPILED_TO_SOURCE.map(([compiled, source]) => joined.replace(compiled, source))].find(candidate => known.has(candidate))
}

export function importersOf(files: readonly string[], read: (file: string) => string | null): Map<string, string[]> {
  const known = new Set(files)
  const importers = new Map<string, string[]>()
  for (const file of files.filter(candidate => MODULE_FILE.test(candidate))) {
    for (const match of (read(file) ?? '').matchAll(RELATIVE_SPECIFIER)) {
      const target = resolvedImport(file, match[1] ?? match[2]!, known)
      if (target !== undefined && target !== file)
        importers.set(target, [...new Set([...(importers.get(target) ?? []), file])])
    }
  }
  return importers
}

export function coveringTests(touches: readonly string[], files: readonly string[], importers: ReadonlyMap<string, readonly string[]>): string[] {
  const touched = files.filter(file => !isTest(file) && withinTouches(file, touches))
  const reached = new Set(touched)
  const queue = [...touched]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const importer of importers.get(file) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer)
        queue.push(importer)
      }
    }
  }
  const known = new Set(files)
  const readers = touches.includes(PACKAGE_MANIFEST) ? PACKAGE_SCRIPT_READERS.filter(reader => known.has(reader)) : []
  return [...new Set([...[...reached].filter(isTest), ...readers])].sort()
}

export class TestCoverage {
  private importers: Map<string, string[]> | undefined
  private files: readonly string[] | undefined

  constructor(private readonly list: () => readonly string[], private readonly read: (file: string) => string | null) {}

  of(touches: readonly string[]): string[] {
    this.files ??= this.list()
    this.importers ??= importersOf(this.files, this.read)
    return coveringTests(touches, this.files, this.importers)
  }
}
