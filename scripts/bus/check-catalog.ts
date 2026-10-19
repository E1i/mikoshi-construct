import type { DatabaseSync } from 'node:sqlite'
import type { Graph } from '../ci/layers.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseMutationFile } from '../../src/commands/mutate/lines.js'
import { isTest, layerOf, selectRun } from '../ci/layers.js'
import { cruise } from '../ci/select.js'
import { defaultBusPath } from './db.js'
import { openDatabase } from './sqlite.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const BRIEF_FILE = /^brief-(\d+)(?:-.*)?\.md$/
const FIRST_DESCRIBE = /describe\(\s*(['"`])(.*?)\1/
const NO_LAYER = 'none'

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
    PRIMARY KEY (card, id)
  );
`

export interface CheckTest { test: string, layer: string, kind: string, what: string, witness: string }

export interface CheckMutation { card: number, id: string, operator: string, file: string, layer: string, killedBy: string | null, judged: string | null }

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

function witnessCards(test: string, title: string, parking: readonly ParkingCard[]): string {
  return parking
    .filter(card => namesPath(card.text, test) || (title !== '' && card.text.includes(title)))
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
      witness: witnessCards(test, what, sources.parking),
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
    }]
  }))
}

export function buildCatalog(sources: CatalogSources): Catalog {
  return { tests: catalogTests(sources), mutations: catalogMutations(sources) }
}

export function writeCatalog(db: DatabaseSync, catalog: Catalog): void {
  db.exec(SCHEMA)
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM check_tests; DELETE FROM check_mutations;')
    const insertTest = db.prepare('INSERT INTO check_tests (test, layer, kind, what, witness) VALUES (?, ?, ?, ?, ?)')
    for (const row of catalog.tests)
      insertTest.run(row.test, row.layer, row.kind, row.what, row.witness)
    const insertMutation = db.prepare('INSERT OR REPLACE INTO check_mutations (card, id, operator, file, layer, killed_by, judged) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const row of catalog.mutations)
      insertMutation.run(row.card, row.id, row.operator, row.file, row.layer, row.killedBy, row.judged)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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
  const journalFile = path.join(handoff, 'ghosts.jsonl')
  const catalog = buildCatalog({
    graph: cruise(),
    testText: test => readFileSync(path.join(REPO_ROOT, test), 'utf8'),
    parking: readParking(path.join(os.homedir(), '.construct', 'parking')),
    briefs: readBriefs(handoff),
    journal: existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '',
  })
  const db = openDatabase(defaultBusPath())
  writeCatalog(db, catalog)
  db.close()
  console.log(`[checks:catalog] ${catalog.tests.length} tests, ${catalog.mutations.length} mutations`)
}

if (process.argv[1] === import.meta.filename)
  main()
