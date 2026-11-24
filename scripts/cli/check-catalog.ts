import type { DatabaseSync } from 'node:sqlite'
import type { Graph } from '../ci/layers.js'
import type { LayerMap } from '../core/layer-map.js'
import type { CardBody } from '../intake/parking-reads.js'
import type { Meter } from '../ports/meter.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseMutationFile } from '../../src/commands/mutate/lines.js'
import { catalogLayersByTest, catalogModuleLayers, NO_LAYER } from '../ci/card-runs.js'
import { isTest, selectRun } from '../ci/layers.js'
import { cruise } from '../ci/select.js'
import { walksATree } from '../ci/tree-scanners.js'
import { BUS_DB_VARIABLE, BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { FACTORY_FOLDERS } from '../core/factory-paths.js'
import { busHistory, ghostLinesText } from '../core/journal.js'
import { DOCS_LAYER, LAYER_MAP, layerOf, layersOf, readLayerMap, recordsOf } from '../core/layer-map.js'
import { openDatabase } from '../core/sqlite.js'
import { cardBodies } from '../intake/parking-reads.js'
import { MAIN_BRANCH } from '../ports/snapshot.js'
import { gitIn, withWorktree } from '../ports/worktree.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const BRIEF_FILE = /^brief-(\d+)(?:-.*)?\.md$/
const FIRST_DESCRIBE = /describe\(\s*(['"`])(.*?)\1/
const EACH_ARGUMENTS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`
const QUOTES = '\'"`'
const EACH_TABLE = '`(?:\\\\.|[^`\\\\])*`'
const IT_TITLE = new RegExp(String.raw`(?<![.\w$])(?:it|test)(\.each\s*(?:${EACH_TABLE}|${EACH_ARGUMENTS}))?\(\s*([${QUOTES}])((?:\\.|(?!\2).)*)\2`, 'g')
const EACH_TOKEN = /(%%)|%[sdifjo#]|\$[a-z_][\w.]*/gi
const RENDERED_PERCENT = '%'
const SHELL_QUOTED_APOSTROPHE = /'\\''/g
const WITNESSES_HEADING = /^Witnesses:/
const DOCUMENT_READER = /^(?:scripts|src|tests)\/.+\.[cm]?[jt]s$/
const DOCUMENT_NAME = /(?<![\w./-])(?:[\w.-]+\/)*[\w.-]+\.md\b/g
const DOCUMENT_TREE = /['"`]((?:\.{1,2}\/)*(?:architecture|docs)(?:\/[\w-]+)*)\/?['"`]/g
const LEADING_DOTS = /^(?:\.{1,2}\/)+/
const SCRIPT_FOLDER = /^scripts\/([^/]+)\/$/
const FACTORY_TESTS = FACTORY_FOLDERS.tests[0]

export const RERUN_VARIABLE = 'BUS_RERUN'
export const RERUN_MODES = ['as-now', 'by-layers'] as const
export type RerunMode = typeof RERUN_MODES[number]

const REPO = 'repos/{owner}/{repo}'
const FILES_PAGE = 100
const COMPARE_FILES_CAP = 300
const CATALOG_SCRIPT = 'scripts/cli/check-catalog.ts'
const REBUILD_MS = 5 * 60_000

export const MAIN_TIP = `origin/${MAIN_BRANCH}`
export const REFUSED_NOT_UP_TO_DATE = 'not_up_to_date'

interface ListedFile { filename?: string, previous_filename?: string }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS check_tests (
    test TEXT PRIMARY KEY,
    layer TEXT NOT NULL,
    kind TEXT NOT NULL,
    what TEXT NOT NULL,
    witness TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS check_mutations (
    card INTEGER NOT NULL,
    id TEXT NOT NULL,
    operator TEXT NOT NULL,
    file TEXT NOT NULL,
    layer TEXT NOT NULL,
    killed_by TEXT,
    judged TEXT,
    find TEXT,
    replacement TEXT,
    PRIMARY KEY (card, id)
  );
  CREATE TABLE IF NOT EXISTS check_modules (
    module TEXT PRIMARY KEY,
    layers TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS check_document_reads (
    document TEXT NOT NULL,
    reader TEXT NOT NULL,
    walked INTEGER NOT NULL,
    PRIMARY KEY (document, reader, walked)
  );
`
const MUTATION_COLUMNS_ADDED_LATER = ['find', 'replacement']

export interface CheckTest { test: string, layer: string, kind: string, what: string, witness: string }

export interface CheckMutation { card: number, id: string, operator: string, file: string, layer: string, killedBy: string | null, judged: string | null, find: string | null, replacement: string | null }

export interface CheckModule { module: string, layers: string[] }

export interface DocumentRead { document: string, reader: string, walked: boolean }

export interface Catalog { tests: CheckTest[], mutations: CheckMutation[], modules?: CheckModule[], documentReads?: DocumentRead[] }

export interface Brief { card: number, text: string }

export interface CatalogSources {
  graph: Graph
  testText: (test: string) => string
  cards: readonly CardBody[]
  briefs: readonly Brief[]
  journal: string
}

export function kindOf(test: string): string {
  if (test.endsWith('.e2e.test.ts'))
    return 'e2e'
  return test.includes('contract') ? 'contract' : 'unit'
}

function layersByTest(graph: Graph, testText: (test: string) => string): Map<string, string[]> {
  const modulesByLayer = new Map<string, string[]>()
  for (const file of [...graph.keys(), ...recordsOf(readLayerMap())]) {
    for (const layer of layersOf(file))
      modulesByLayer.set(layer, [...(modulesByLayer.get(layer) ?? []), file])
  }
  const byTest = new Map<string, string[]>()
  for (const [layer, files] of [...modulesByLayer].sort(([a], [b]) => a.localeCompare(b))) {
    const run = selectRun(files, graph, testText)
    if (run.kind === 'layers') {
      for (const test of run.tests)
        byTest.set(test, [...(byTest.get(test) ?? []), layer])
    }
  }
  for (const test of [...graph.keys()].filter(file => isTest(file) && readsDocuments(testText(file))))
    byTest.set(test, [...new Set([...(byTest.get(test) ?? []), DOCS_LAYER])].sort())
  const testFolders = testFoldersOfLayers(readLayerMap())
  for (const test of [...graph.keys()].filter(isTest)) {
    const own = testFolders.filter(([folder]) => test.startsWith(folder)).map(([, layer]) => layer)
    if (own.length > 0)
      byTest.set(test, [...new Set([...(byTest.get(test) ?? []), ...own])].sort())
  }
  return byTest
}

export function testFoldersOfLayers(map: LayerMap): [string, string][] {
  return Object.entries(map.folders).flatMap(([folder, layer]): [string, string][] => {
    const name = SCRIPT_FOLDER.exec(folder)?.[1]
    return name === undefined ? [] : [[`${FACTORY_TESTS}/${name}/`, layer]]
  })
}

function readsDocuments(text: string): boolean {
  return documentsNamedIn(text).length > 0 || documentTreesWalkedIn(text).length > 0
}

function memoized(read: (test: string) => string): (test: string) => string {
  const texts = new Map<string, string>()
  return (test) => {
    if (!texts.has(test))
      texts.set(test, read(test))
    return texts.get(test)!
  }
}

function namesPath(text: string, test: string): boolean {
  const escaped = test.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(`(?<![\\w./-])${escaped}(?!\\w)`).test(text)
}

function witnessLines(text: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => WITNESSES_HEADING.test(line))
  if (start === -1)
    return ''
  const end = lines.findIndex((line, index) => index > start && line.trim() === '')
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

interface TestTitle {
  title: string
  each: boolean
}

function itTitles(text: string): TestTitle[] {
  return [...text.matchAll(IT_TITLE)]
    .map(match => ({ title: match[3]!.replaceAll(/\\(.)/g, '$1'), each: match[1] !== undefined }))
    .filter(({ title }) => title !== '')
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function renderedEachParts(title: string): string[] {
  const parts = ['']
  let last = 0
  for (const match of title.matchAll(EACH_TOKEN)) {
    parts[parts.length - 1] += title.slice(last, match.index) + (match[1] === undefined ? '' : RENDERED_PERCENT)
    if (match[1] === undefined)
      parts.push('')
    last = match.index + match[0].length
  }
  parts[parts.length - 1] += title.slice(last)
  return parts
}

function namesTitle(witnesses: string, { title, each }: TestTitle): boolean {
  const parts = each ? renderedEachParts(title) : [title]
  if (parts.length === 1)
    return witnesses.includes(parts[0]!)
  if (parts.join('').trim() === '')
    return false
  return new RegExp(parts.map(escapeRegExp).join('[^\\n]+?')).test(witnesses)
}

function witnessCards(test: string, titles: readonly TestTitle[], cards: readonly CardBody[]): string {
  return cards
    .filter((card) => {
      const witnesses = witnessLines(card.text).replaceAll(SHELL_QUOTED_APOSTROPHE, '\'')
      return namesPath(witnesses, test) || titles.some(title => namesTitle(witnesses, title))
    })
    .map(card => card.card)
    .sort((a, b) => a - b)
    .join(',')
}

export function catalogTests(sources: CatalogSources): CheckTest[] {
  const testText = memoized(sources.testText)
  const layers = layersByTest(sources.graph, testText)
  return [...sources.graph.keys()].filter(isTest).sort().map((test) => {
    const what = FIRST_DESCRIBE.exec(testText(test))?.[2] ?? ''
    return {
      test,
      layer: layers.get(test)?.join(',') ?? NO_LAYER,
      kind: kindOf(test),
      what,
      witness: witnessCards(test, itTitles(testText(test)), sources.cards),
    }
  })
}

function judgedOutcomes(journal: string): Map<string, string> {
  const outcomes = new Map<string, string>()
  for (const line of journal.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line) as { event?: string, card?: unknown, id?: unknown, outcome?: unknown }
      if (entry.event === 'mutation-judged')
        outcomes.set(`${String(entry.card).replace('#', '')}:${String(entry.id)}`, String(entry.outcome))
    }
    catch {}
  }
  return outcomes
}

export function catalogMutations(sources: Pick<CatalogSources, 'briefs' | 'journal'>): CheckMutation[] {
  const judged = judgedOutcomes(sources.journal)
  return sources.briefs.flatMap(brief => parseMutationFile(brief.text).flatMap((parsed) => {
    if (!('line' in parsed))
      return []
    const { line } = parsed
    return [{
      card: brief.card,
      id: line.id,
      operator: line.change.kind === 'find' ? `${line.change.find} → ${line.change.replace}` : line.change.prose,
      file: line.file,
      layer: layerOf(line.file) ?? NO_LAYER,
      killedBy: line.prediction.kind === 'test' ? line.prediction.file : null,
      judged: judged.get(`${brief.card}:${line.id}`) ?? null,
      find: line.change.kind === 'find' ? line.change.find : null,
      replacement: line.change.kind === 'find' ? line.change.replace : null,
    }]
  }))
}

function layersReachedFrom(start: string, graph: Graph): string[] {
  const seen = new Set([start])
  const queue = [start]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const target of graph.get(file) ?? []) {
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return [...new Set([...seen].flatMap(layersOf))].sort()
}

export function catalogModules(graph: Graph): CheckModule[] {
  return [...graph.keys()].filter(file => !isTest(file)).sort().map(module => ({ module, layers: layersReachedFrom(module, graph) }))
}

function withoutLeadingDots(name: string): string {
  return name.replace(LEADING_DOTS, '')
}

function documentsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(DOCUMENT_NAME)].map(match => withoutLeadingDots(match[0])))]
}

function documentTreesWalkedIn(text: string): string[] {
  return walksATree(text) ? [...new Set([...text.matchAll(DOCUMENT_TREE)].map(match => withoutLeadingDots(match[1]!)))] : []
}

export function catalogDocumentReads(graph: Graph, text: (file: string) => string): DocumentRead[] {
  return [...graph.keys()].filter(file => DOCUMENT_READER.test(file)).sort().flatMap(reader => [
    ...documentsNamedIn(text(reader)).map(document => ({ document, reader, walked: false })),
    ...documentTreesWalkedIn(text(reader)).map(document => ({ document, reader, walked: true })),
  ])
}

export function buildCatalog(sources: CatalogSources): Catalog {
  return {
    tests: catalogTests(sources),
    mutations: catalogMutations(sources),
    modules: catalogModules(sources.graph),
    documentReads: catalogDocumentReads(sources.graph, sources.testText),
  }
}

export function missingMutationColumns(db: DatabaseSync): string[] {
  const present = (db.prepare('PRAGMA table_info(check_mutations)').all() as unknown as { name: string }[]).map(column => column.name)
  return MUTATION_COLUMNS_ADDED_LATER.filter(name => !present.includes(name))
}

function addMissingMutationColumns(db: DatabaseSync): void {
  for (const column of missingMutationColumns(db))
    db.exec(`ALTER TABLE check_mutations ADD COLUMN ${column} TEXT`)
}

export function writeCatalog(db: DatabaseSync, catalog: Catalog): void {
  db.exec(SCHEMA)
  addMissingMutationColumns(db)
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM check_tests; DELETE FROM check_mutations; DELETE FROM check_modules; DELETE FROM check_document_reads;')
    const insertTest = db.prepare('INSERT INTO check_tests (test, layer, kind, what, witness) VALUES (?, ?, ?, ?, ?)')
    for (const row of catalog.tests)
      insertTest.run(row.test, row.layer, row.kind, row.what, row.witness)
    const insertMutation = db.prepare('INSERT OR REPLACE INTO check_mutations (card, id, operator, file, layer, killed_by, judged, find, replacement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of catalog.mutations)
      insertMutation.run(row.card, row.id, row.operator, row.file, row.layer, row.killedBy, row.judged, row.find, row.replacement)
    const insertModule = db.prepare('INSERT INTO check_modules (module, layers) VALUES (?, ?)')
    for (const row of catalog.modules ?? [])
      insertModule.run(row.module, row.layers.join(','))
    const insertRead = db.prepare('INSERT OR IGNORE INTO check_document_reads (document, reader, walked) VALUES (?, ?, ?)')
    for (const row of catalog.documentReads ?? [])
      insertRead.run(row.document, row.reader, row.walked ? 1 : 0)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function rerunModeOf(env: NodeJS.ProcessEnv): RerunMode {
  const given = env[RERUN_VARIABLE]
  if (given === undefined || given === '')
    return 'as-now'
  const mode = RERUN_MODES.find(each => each === given)
  if (mode === undefined)
    throw new Error(`${RERUN_VARIABLE} is not one of ${RERUN_MODES.join(' | ')}: ${given}`)
  return mode
}

export { catalogLayersByTest, catalogModuleLayers }

export function catalogIsEmpty(db: DatabaseSync): boolean {
  return catalogLayersByTest(db).size === 0
}

export function changesTheCatalog(files: readonly string[]): boolean {
  return files.some(file => isTest(file) || file === LAYER_MAP)
}

export type CatalogRebuilt = { kind: 'rebuilt' } | { kind: 'skipped', reason: string }

function checkoutOf(repo: string): string | null {
  try {
    return gitIn(repo, ['rev-parse', '--show-toplevel'])
  }
  catch {
    return null
  }
}

export function rebuildCatalogAt(ref: string, busPath: string, repo: string): CatalogRebuilt {
  const checkout = checkoutOf(repo)
  if (checkout === null)
    return { kind: 'skipped', reason: `${repo} is not a git checkout, so there is no tree at ${ref} to catalog` }
  if (!existsSync(path.join(checkout, CATALOG_SCRIPT)))
    return { kind: 'skipped', reason: `the repository at ${checkout} carries no ${CATALOG_SCRIPT}, so its tests have no catalog to rebuild` }
  gitIn(checkout, ['fetch', 'origin', MAIN_BRANCH])
  withWorktree(checkout, ref, (tree) => {
    symlinkSync(path.join(checkout, 'node_modules'), path.join(tree, 'node_modules'))
    execFileSync(process.execPath, ['--import', 'tsx', CATALOG_SCRIPT], { cwd: tree, env: { ...process.env, [BUS_DB_VARIABLE]: busPath }, timeout: REBUILD_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  })
  return { kind: 'rebuilt' }
}

function listedFiles(meter: Meter, pr: number): ListedFile[] {
  const files: ListedFile[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`) as ListedFile[]
    files.push(...listed)
    if (listed.length < FILES_PAGE)
      return files
  }
}

function pathsOf(files: readonly ListedFile[]): string[] {
  return files.flatMap(file => [file.filename, file.previous_filename].filter(name => name !== undefined))
}

export function changedPaths(meter: Meter, pr: number): string[] {
  return pathsOf(listedFiles(meter, pr))
}

export function changedFiles(meter: Meter, pr: number): string[] {
  return listedFiles(meter, pr).flatMap(file => file.filename === undefined ? [] : [file.filename])
}

export type MainSince = { kind: 'files', files: string[] } | { kind: 'truncated', why: string }

export function mainFilesSince(meter: Meter, base: string): MainSince {
  const main = (meter.get(`${REPO}/commits/${MAIN_BRANCH}`) as { sha?: string }).sha
  if (main === undefined || main === base)
    return { kind: 'files', files: [] }
  const compared = meter.get(`${REPO}/compare/${base}...${main}`) as { files?: ListedFile[], commits?: unknown[], total_commits?: number }
  const files = compared.files ?? []
  const listedCommits = compared.commits?.length ?? 0
  if (files.length >= COMPARE_FILES_CAP)
    return { kind: 'truncated', why: `the compare of ${base}...${main} lists ${files.length} files, the most GitHub returns, so more may be missing` }
  if ((compared.total_commits ?? listedCommits) > listedCommits)
    return { kind: 'truncated', why: `the compare of ${base}...${main} lists ${listedCommits} of ${compared.total_commits} commits, so its files may be missing some` }
  return { kind: 'files', files: pathsOf(files) }
}

export function readBriefs(dir: string): Brief[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir).flatMap((name) => {
    const card = BRIEF_FILE.exec(name)?.[1]
    return card === undefined ? [] : [{ card: Number(card), text: readFileSync(path.join(dir, name), 'utf8') }]
  })
}

export function ghostJournalOf(busPath: string): string {
  const history = busHistory(busPath).map(entry => `${JSON.stringify(entry)}\n`).join('')
  return `${history}${ghostLinesText(busPath)}`
}

function main(): void {
  const handoff = process.env.CONSTRUCT_HANDOFF_DIR ?? path.join(os.homedir(), '.construct', 'handoff')
  const busPath = defaultBusPath()
  const db = openDatabase(busPath, { timeout: BUSY_TIMEOUT_MS })
  const catalog = buildCatalog({
    graph: cruise(),
    testText: test => readFileSync(path.join(REPO_ROOT, test), 'utf8'),
    cards: cardBodies(db),
    briefs: readBriefs(handoff),
    journal: ghostJournalOf(busPath),
  })
  writeCatalog(db, catalog)
  db.close()
  console.log(`[checks:catalog] ${catalog.tests.length} tests, ${catalog.mutations.length} mutations`)
}

if (process.argv[1] === import.meta.filename)
  main()
