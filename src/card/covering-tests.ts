import path from 'node:path'
import { FACTORY_FOLDERS, FACTORY_FORMER_FOLDERS, FACTORY_NAMED, FACTORY_ROOT, scopeOf } from '../../scripts/core/factory-paths.js'
import { createdPaths } from './parking.js'
import { PREFIX_SUFFIX } from './task-file.js'
import { isLayerEntry, layerNamedBy, runsFieldOf } from './witness-fields.js'

function scannedBy(groups: readonly (readonly [readonly string[], readonly string[]])[]): Record<string, readonly string[]> {
  const trees: Record<string, string[]> = {}
  for (const [entries, scanners] of groups) {
    for (const entry of entries)
      (trees[scopeOf(entry)] ??= []).push(...scanners)
  }
  return trees
}

export const TEST_ROOTS = ['tests', FACTORY_FOLDERS.tests[0]]
export const PACKAGE_MANIFEST = 'package.json'
export const PACKAGE_SCRIPT_READERS = ['tests/contributing-scripts.test.ts', 'tests/harness-membership.test.ts']
export const RISK_RULE = 'src/card/risk.ts'
export const RISK_RULE_READERS = [`${FACTORY_FOLDERS.tests[0]}/morse/cli.test.ts`, `${FACTORY_FOLDERS.tests[0]}/morse/rules.test.ts`]
export const NAMED_READERS: Readonly<Record<string, readonly string[]>> = {
  [PACKAGE_MANIFEST]: PACKAGE_SCRIPT_READERS,
  [RISK_RULE]: RISK_RULE_READERS,
}
export const SCANNED_TREES: Readonly<Record<string, readonly string[]>> = {
  'src/': ['tests/dependency-policy.test.ts', 'tests/graph-command.test.ts', 'tests/every-source-has-a-reader.test.ts', 'tests/intake-command-word.test.ts', 'tests/delivery-boundary.test.ts', 'tests/contract/factory.test.ts', 'tests/contract/accepted.test.ts', FACTORY_NAMED.eventsTest, FACTORY_NAMED.noParkingReadsTest, FACTORY_NAMED.journalGuardTest, FACTORY_NAMED.factoryPathsTest, FACTORY_NAMED.clientSealTest],
  [`${FACTORY_ROOT}/`]: ['tests/graph-command.test.ts', 'tests/contract/factory.test.ts', 'tests/contract/accepted.test.ts', FACTORY_NAMED.sqliteTest, FACTORY_NAMED.factoryPathsTest, FACTORY_NAMED.eventsTest, FACTORY_NAMED.noParkingReadsTest, FACTORY_NAMED.journalGuardTest, FACTORY_NAMED.clientSealTest],
  'templates/ai/claude/': [FACTORY_NAMED.clientSealTest],
  ...scannedBy([
    [FACTORY_FOLDERS.sharedCode, [FACTORY_NAMED.layersTest]],
    [FACTORY_FORMER_FOLDERS.ghosts, [FACTORY_NAMED.ownerMergesTest]],
    [FACTORY_FORMER_FOLDERS.shift, ['tests/decisions-read-through-reader.test.ts']],
  ]),
}
const LINT_CONFIG = /^eslint\.config\.[cm]?[jt]s$/
const LINT_RUN = /\bnew\s+ESLint\s*\(|\bcalculateConfigForFile\s*\(/
const WORD_BOUNDARY = /[\s,;:()[\]"'`?!<>]+/
const TRAILING_DOTS = /\.+$/
const FILE_EXTENSION = /\.[a-z][\w-]*$/i
const TEST_FILE = /\.test\.ts$/
const WORKSPACE_TEST_ROOT = /^(?:apps|packages)\/[^/]+\/tests\//
const MODULE_FILE = /\.[cm]?[jt]s$/
const RELATIVE_SPECIFIER = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\b(?:import|require|vi\.(?:mock|doMock|importActual|importMock))\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
const COMPILED_TO_SOURCE: readonly (readonly [RegExp, string])[] = [[/\.js$/, '.ts'], [/\.mjs$/, '.mts'], [/\.cjs$/, '.cts']]
export const COVERING_REASON = 'a test that imports a touched file, directly or through other modules, follows the touches: the rule in src/card/covering-tests.ts'
export const RUNS_PREFIX = 'Runs: '
const RUNS_SEPARATOR = ', '
const COVERING_TOUCH_CORRECTION_PREFIX = 'corrected: touches — (absent) → '
const COVERING_TOUCH_CORRECTION_SUFFIX = ` — ${COVERING_REASON}`

export function isTest(file: string): boolean {
  return TEST_FILE.test(file) && TEST_ROOTS.some(root => file.startsWith(`${root}/`))
}

function coversByImport(file: string): boolean {
  return isTest(file) || (TEST_FILE.test(file) && WORKSPACE_TEST_ROOT.test(file))
}

export function isTestScope(entry: string): boolean {
  if (isLayerEntry(entry))
    return true
  if (!entry.endsWith(PREFIX_SUFFIX))
    return coversByImport(entry)
  const scope = `${entry.slice(0, -PREFIX_SUFFIX.length)}/`
  return TEST_ROOTS.some(root => scope.startsWith(`${root}/`)) || WORKSPACE_TEST_ROOT.test(scope)
}

export function runsLine(runs: readonly string[]): string {
  return `${RUNS_PREFIX}${runs.join(RUNS_SEPARATOR)}`
}

function coveringTouchOf(line: string): string[] {
  if (!line.startsWith(COVERING_TOUCH_CORRECTION_PREFIX) || !line.endsWith(COVERING_TOUCH_CORRECTION_SUFFIX))
    return []
  return [line.slice(COVERING_TOUCH_CORRECTION_PREFIX.length, -COVERING_TOUCH_CORRECTION_SUFFIX.length)]
}

function runsOfLine(line: string): string[] {
  if (!line.startsWith(RUNS_PREFIX))
    return coveringTouchOf(line)
  return line.slice(RUNS_PREFIX.length).split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

function runsEntriesOf(body: string): string[] {
  return [...new Set([...runsFieldOf(body), ...body.split('\n').flatMap(line => runsOfLine(line.trim()))])]
}

export function runsOf(body: string): string[] {
  return runsEntriesOf(body).filter(entry => !isLayerEntry(entry) && isTestScope(entry))
}

export function layerMasksOf(body: string): string[] {
  return runsEntriesOf(body).filter(isLayerEntry).map(layerNamedBy)
}

export function runsCover(file: string, runs: readonly string[]): boolean {
  return coversByImport(file) && withinTouches(file, runs)
}

export function touchesWithoutRuns(touches: readonly string[], body: string): string[] {
  const runs = new Set(runsOf(body))
  return touches.filter(entry => !runs.has(entry))
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

function scanning(touched: readonly string[], known: ReadonlySet<string>): string[] {
  return Object.entries(SCANNED_TREES)
    .filter(([root]) => touched.some(file => file.startsWith(root)))
    .flatMap(([, scanners]) => scanners.filter(test => known.has(test)))
}

function spawning(touched: readonly string[], files: readonly string[], read: (file: string) => string | null): string[] {
  const named = touched.flatMap(file => [file, path.posix.basename(file)])
  return files.filter(isTest).filter(test => named.some(name => (read(test) ?? '').includes(name)))
}

function linting(touched: readonly string[], files: readonly string[], read: (file: string) => string | null): string[] {
  if (!touched.some(file => LINT_CONFIG.test(file)))
    return []
  return files.filter(isTest).filter(test => LINT_RUN.test(read(test) ?? ''))
}

export function coveringTests(touches: readonly string[], files: readonly string[], importers: ReadonlyMap<string, readonly string[]>, read: (file: string) => string | null): string[] {
  const touched = files.filter(file => !coversByImport(file) && withinTouches(file, touches))
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
  const readers = Object.entries(NAMED_READERS)
    .filter(([file]) => touches.includes(file) || touched.includes(file))
    .flatMap(([, named]) => named.filter(reader => known.has(reader)))
  return [...new Set([...[...reached].filter(coversByImport), ...readers, ...scanning(touched, known), ...spawning(touched, files, read), ...linting(touched, files, read)])].sort()
}

export function pathsIn(text: string): string[] {
  return [...new Set(text.split(WORD_BOUNDARY).map(word => word.replace(TRAILING_DOTS, '')).filter(word => word.includes('/') || FILE_EXTENSION.test(word)))]
}

export function pathsOutside(touches: readonly string[], creates: readonly string[], paths: readonly string[]): string[] {
  const reach = [...touches, ...createdPaths(creates)]
  return paths.filter(file => !withinTouches(file, reach))
}

export class TestCoverage {
  private importers: Map<string, string[]> | undefined
  private files: readonly string[] | undefined

  constructor(private readonly list: () => readonly string[], private readonly read: (file: string) => string | null) {}

  of(touches: readonly string[]): string[] {
    this.files ??= this.list()
    this.importers ??= importersOf(this.files, this.read)
    return coveringTests(touches, this.files, this.importers, this.read)
  }
}
