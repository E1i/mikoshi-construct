import type { DatabaseSync } from 'node:sqlite'
import type { Graph } from '../ci/layers.js'
import type { Meter } from './meter.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseMutationFile } from '../../src/commands/mutate/lines.js'
import { isTest, layerOf, selectRun } from '../ci/layers.js'
import { cruise } from '../ci/select.js'
import { ghostLinesText } from '../ghosts/journal.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { MAIN_BRANCH } from './snapshot.js'
import { openDatabase } from './sqlite.js'

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
const NO_LAYER = 'none'
const UNTESTED_FILE = /^\.changeset\//

export const RERUN_VARIABLE = 'BUS_RERUN'
export const RERUN_MODES = ['as-now', 'by-layers'] as const
export type RerunMode = typeof RERUN_MODES[number]
export type Rerun = { rerun: true, why: string } | { rerun: false, why: string }

const REPO = 'repos/{owner}/{repo}'
const MAIN_PROTECTION = `${REPO}/branches/${MAIN_BRANCH}/protection`
const FILES_PAGE = 100
const COMPARE_FILES_CAP = 300

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
`
const MUTATION_COLUMNS_ADDED_LATER = ['find', 'replacement']

export interface CheckTest { test: string, layer: string, kind: string, what: string, witness: string }

export interface CheckMutation { card: number, id: string, operator: string, file: string, layer: string, killedBy: string | null, judged: string | null, find: string | null, replacement: string | null }

export interface Catalog { tests: CheckTest[], mutations: CheckMutation[] }

export interface Brief { card: number, text: string }

export interface ParkingCard { card: number, text: string }

export interface CatalogSources {
  graph: Graph
  testText: (test: string) => string
  parking: readonly ParkingCard[]
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
  for (const file of graph.keys()) {
    const layer = layerOf(file)
    if (layer !== null)
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
  return byTest
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

function witnessCards(test: string, titles: readonly TestTitle[], parking: readonly ParkingCard[]): string {
  return parking
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
      witness: witnessCards(test, itTitles(testText(test)), sources.parking),
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

export function buildCatalog(sources: CatalogSources): Catalog {
  return { tests: catalogTests(sources), mutations: catalogMutations(sources) }
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
    db.exec('DELETE FROM check_tests; DELETE FROM check_mutations;')
    const insertTest = db.prepare('INSERT INTO check_tests (test, layer, kind, what, witness) VALUES (?, ?, ?, ?, ?)')
    for (const row of catalog.tests)
      insertTest.run(row.test, row.layer, row.kind, row.what, row.witness)
    const insertMutation = db.prepare('INSERT OR REPLACE INTO check_mutations (card, id, operator, file, layer, killed_by, judged, find, replacement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of catalog.mutations)
      insertMutation.run(row.card, row.id, row.operator, row.file, row.layer, row.killedBy, row.judged, row.find, row.replacement)
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

function catalogLayersByTest(db: DatabaseSync): Map<string, string[]> {
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'check_tests'`).get() === undefined)
    return new Map()
  const rows = db.prepare('SELECT test, layer FROM check_tests').all() as unknown as { test: string, layer: string }[]
  return new Map(rows.map(row => [row.test, row.layer.split(',').filter(layer => layer !== NO_LAYER)]))
}

function layersOfFile(file: string, byTest: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  if (isTest(file)) {
    const layers = byTest.get(file)
    return layers === undefined || layers.length === 0 ? null : layers
  }
  const layer = layerOf(file)
  return layer === null ? null : [layer]
}

export function overlapWithMain(db: DatabaseSync, prFiles: readonly string[], mainFiles: readonly string[]): string | null {
  const tested = (files: readonly string[]): string[] => files.filter(file => !UNTESTED_FILE.test(file))
  const pr = tested(prFiles)
  const main = tested(mainFiles)
  if (main.length === 0)
    return null
  const byTest = catalogLayersByTest(db)
  if (byTest.size === 0)
    return 'the check catalog is empty, so no layer can be told apart'
  const unplaced = [...pr, ...main].find(file => layersOfFile(file, byTest) === null)
  if (unplaced !== undefined)
    return `${unplaced} belongs to no layer of the check catalog`
  const prLayers = new Set(pr.flatMap(file => layersOfFile(file, byTest)!))
  const mainLayers = new Set(main.flatMap(file => layersOfFile(file, byTest)!))
  const shared = [...prLayers].sort().find(layer => mainLayers.has(layer))
  if (shared !== undefined)
    return `main changed the layer ${shared} since the base`
  const both = [...byTest].sort(([a], [b]) => a.localeCompare(b)).find(([, layers]) => layers.some(layer => prLayers.has(layer)) && layers.some(layer => mainLayers.has(layer)))
  return both === undefined ? null : `${both[0]} runs for a layer of the pull request and a layer main changed`
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

export function changedFiles(meter: Meter, pr: number): string[] {
  return listedFiles(meter, pr).flatMap(file => file.filename === undefined ? [] : [file.filename])
}

export function upToDateRequired(meter: Meter): boolean {
  try {
    const protection = meter.get(MAIN_PROTECTION) as { required_status_checks?: { strict?: boolean } | null }
    return protection.required_status_checks?.strict !== false
  }
  catch {
    return true
  }
}

type MainSince = { kind: 'files', files: string[] } | { kind: 'truncated', why: string }

function mainFilesSince(meter: Meter, base: string): MainSince {
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

export function rerunOf(db: DatabaseSync, meter: Meter, pr: number, base: string | undefined): Rerun {
  if (upToDateRequired(meter))
    return { rerun: true, why: `${MAIN_BRANCH} requires an up-to-date branch on this host` }
  if (base === undefined)
    return { rerun: true, why: `#${pr} came back with no base sha` }
  const main = mainFilesSince(meter, base)
  if (main.kind === 'truncated')
    return { rerun: true, why: main.why }
  const overlap = overlapWithMain(db, pathsOf(listedFiles(meter, pr)), main.files)
  return overlap === null ? { rerun: false, why: `nothing ${MAIN_BRANCH} changed since ${base} reaches a layer of #${pr}` } : { rerun: true, why: overlap }
}

export function readBriefs(dir: string): Brief[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir).flatMap((name) => {
    const card = BRIEF_FILE.exec(name)?.[1]
    return card === undefined ? [] : [{ card: Number(card), text: readFileSync(path.join(dir, name), 'utf8') }]
  })
}

export function readParking(dir: string): ParkingCard[] {
  if (!existsSync(dir))
    return []
  const files = readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? readdirSync(path.join(dir, entry.name)).map(name => path.join(dir, entry.name, name))
    : [path.join(dir, entry.name)])
  return files.flatMap((file) => {
    const card = /^(\d+)\.md$/.exec(path.basename(file))?.[1]
    return card === undefined ? [] : [{ card: Number(card), text: readFileSync(file, 'utf8') }]
  })
}

function main(): void {
  const handoff = process.env.CONSTRUCT_HANDOFF_DIR ?? path.join(os.homedir(), '.construct', 'handoff')
  const catalog = buildCatalog({
    graph: cruise(),
    testText: test => readFileSync(path.join(REPO_ROOT, test), 'utf8'),
    parking: readParking(path.join(os.homedir(), '.construct', 'parking')),
    briefs: readBriefs(handoff),
    journal: ghostLinesText(defaultBusPath()),
  })
  const db = openDatabase(defaultBusPath(), { timeout: BUSY_TIMEOUT_MS })
  writeCatalog(db, catalog)
  db.close()
  console.log(`[checks:catalog] ${catalog.tests.length} tests, ${catalog.mutations.length} mutations`)
}

if (process.argv[1] === import.meta.filename)
  main()
