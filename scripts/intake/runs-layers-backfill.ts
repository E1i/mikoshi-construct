import type { DatabaseSync } from 'node:sqlite'
import type { AdmitResult } from '../../src/commands/intake/admit.js'
import type { CheckCatalog } from '../ci/card-runs.js'
import type { LayerMap } from '../core/layer-map.js'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { layerMasksOf, RUNS_PREFIX, runsOf } from '../../src/card/covering-tests.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { runsFieldLine, runsFieldOf } from '../../src/card/witness-fields.js'
import { admittedCardFile, runAdmit, withRunsLine } from '../../src/commands/intake/admit.js'
import { correctionText } from '../../src/commands/intake/check.js'
import { cardRunsOf, catalogLayersByTest, catalogModuleLayers } from '../ci/card-runs.js'
import { DEFERRED_CARD, QUEUED_CARD, RUNNING_CARD } from '../core/card-automaton.js'
import { CARD_BODIES } from '../core/card-bodies.js'
import { BUSY_TIMEOUT_MS, defaultBusPath, openBus } from '../core/db.js'
import { readLayerMap } from '../core/layer-map.js'
import { openDatabase } from '../core/sqlite.js'
import { withinTouches } from '../policy/touch-scope.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from './intake.js'

export const PREFIX = '[bus:runs-layers-backfill] '

const WRITE_FLAG = '--write'
const LAYER_ENTRY = 'layer:'
const GLOB_SUFFIX = '/**'
const RUNS_SEPARATOR = ','
const CARD_TEXTS = `SELECT card_id, text FROM ${CARD_BODIES} ORDER BY card_id`
const STATE_OF_CARD = 'SELECT state FROM cards WHERE card_id = ?'
const OPEN_PR_OF_CARD = `SELECT pr FROM prs WHERE card_id = ? AND state = 'open' LIMIT 1`
const LEASED_LAUNCH_OF_CARD = `SELECT 1 FROM tasks WHERE queue = 'launch' AND card_id = ? AND state = 'leased' LIMIT 1`
const WRITABLE_STATES = new Set<string | null>([null, QUEUED_CARD, DEFERRED_CARD])

export type Collapse
  = | { kind: 'collapse', layers: string[], dropped: string[], runs: string[], text: string }
    | { kind: 'stays', why: string }

export type CardOutcome
  = | { card: number, kind: 'written' | 'would write', layers: string[], dropped: string[], runs: string[], corrections: string[] }
    | { card: number, kind: 'skipped' | 'stays' | 'refused', why: string }

export interface BackfillOptions {
  write: boolean
  dir: string
  catalog: CheckCatalog
  map: LayerMap
  now?: () => Date
}

function filesWithin(entry: string, tests: Iterable<string>): string[] {
  return [...tests].filter(test => withinTouches(test, [entry]))
}

function testsOfLayer(layer: string, { testLayers }: CheckCatalog): string[] {
  return [...testLayers].filter(([, own]) => own.includes(layer)).map(([test]) => test)
}

function fullyNamedLayers(entries: readonly string[], masks: readonly string[], catalog: CheckCatalog, map: LayerMap): string[] {
  const known = new Set([...Object.values(map.files), ...Object.values(map.folders)])
  const catalogued = new Set([...catalog.testLayers.values()].flat())
  return [...catalogued]
    .filter(layer => known.has(layer) && !masks.includes(layer))
    .filter(layer => testsOfLayer(layer, catalog).every(test => withinTouches(test, entries)))
    .sort()
}

function proseRunsEntries(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.startsWith(RUNS_PREFIX)).flatMap(line =>
    line.slice(RUNS_PREFIX.length).split(RUNS_SEPARATOR).map(entry => entry.trim()).filter(entry => entry !== ''),
  )
}

function withoutProseRuns(text: string): string {
  return text.split('\n').filter(line => !line.trim().startsWith(RUNS_PREFIX)).join('\n')
}

function expandedTests(card: number, text: string, catalog: CheckCatalog, map: LayerMap): string[] | string {
  const parsed = parseParkingFile(`${card}.md`, text)
  if (parsed.kind === 'refused')
    return `the text does not parse: ${parsed.reason}`
  const { touches, body } = parsed.parked.task
  const reading = cardRunsOf({ touches, runs: runsOf(body), masks: layerMasksOf(body) }, catalog, map)
  if ('full' in reading)
    return `a full reading: ${reading.why}`
  return [...new Set(reading.tests.flatMap(test => test.endsWith(GLOB_SUFFIX) ? filesWithin(test, catalog.testLayers.keys()) : [test]))].sort()
}

function widenedOrNarrowed(card: number, before: string, after: string, catalog: CheckCatalog, map: LayerMap): string | null {
  const from = expandedTests(card, before, catalog, map)
  if (typeof from === 'string')
    return from
  const to = expandedTests(card, after, catalog, map)
  if (typeof to === 'string')
    return to
  if (from.length === to.length && from.every((test, index) => test === to[index]))
    return null
  return `the tests of the card would change: ${from.length} → ${to.length}`
}

export function collapseOf(card: number, text: string, catalog: CheckCatalog, map: LayerMap): Collapse | null {
  const entries = runsOf(text)
  const named = fullyNamedLayers(entries, layerMasksOf(text), catalog, map)
  const covered = new Set(named.flatMap(layer => testsOfLayer(layer, catalog)))
  const dropped = entries.filter((entry) => {
    const files = filesWithin(entry, catalog.testLayers.keys())
    return files.length > 0 && files.every(file => covered.has(file))
  })
  if (dropped.length === 0)
    return null
  const replaced = new Set(dropped.flatMap(entry => filesWithin(entry, catalog.testLayers.keys())))
  const layers = named.filter(layer => testsOfLayer(layer, catalog).some(test => replaced.has(test)))
  const kept = [...new Set([...runsFieldOf(text), ...proseRunsEntries(text)])].filter(entry => !dropped.includes(entry))
  const runs = [...kept, ...layers.map(layer => `${LAYER_ENTRY}${layer}`)]
  const after = withRunsLine(withoutProseRuns(text), runs)
  if (!after.includes(runsFieldLine(runs)))
    return { kind: 'stays', why: 'the text has no line to hold the layers: no runs field and no witnesses' }
  const changed = widenedOrNarrowed(card, text, after, catalog, map)
  return changed === null ? { kind: 'collapse', layers, dropped, runs, text: after } : { kind: 'stays', why: changed }
}

function skipOf(db: DatabaseSync, card: number, text: string): string | null {
  const state = (db.prepare(STATE_OF_CARD).get(card) as { state: string | null } | undefined)?.state ?? null
  if (state === RUNNING_CARD || db.prepare(LEASED_LAUNCH_OF_CARD).get(card) !== undefined)
    return 'its session is running'
  const pr = db.prepare(OPEN_PR_OF_CARD).get(card) as { pr: number } | undefined
  if (pr !== undefined)
    return `pull request #${pr.pr} is open`
  if (!WRITABLE_STATES.has(state))
    return `it is ${state}`
  return busCardAdmissions(db)(card)?.text === text ? null : 'its latest admission is not the text of the bus yet'
}

function refusalOf(result: AdmitResult): string {
  if ('why' in result)
    return result.why
  return 'reasons' in result ? result.reasons.join('; ') : result.status
}

function outcomeOf(db: DatabaseSync, card: number, text: string, options: BackfillOptions): CardOutcome | null {
  const { catalog, map, dir, write, now } = options
  const collapse = collapseOf(card, text, catalog, map)
  if (collapse === null)
    return null
  if (collapse.kind === 'stays')
    return { card, kind: 'stays', why: collapse.why }
  const skip = skipOf(db, card, text)
  if (skip !== null)
    return { card, kind: 'skipped', why: skip }
  const admit = (dryRun: boolean) => runAdmit({ file: admittedCardFile(card), body: collapse.text, dir, dryRun, autoConfirm: true, events: busCardEvents(db), admissions: busCardAdmissions(db), cardStates: () => busHeldCards(db) }, now)
  const planned = admit(true)
  if (planned.status !== 'dryRun')
    return { card, kind: 'refused', why: refusalOf(planned) }
  const corrected = widenedOrNarrowed(card, text, planned.card.text, catalog, map)
  if (corrected !== null)
    return { card, kind: 'stays', why: `the admission corrects the card: ${corrected}` }
  const { layers, dropped, runs } = collapse
  const corrections = planned.card.corrections.map(correctionText)
  if (!write)
    return { card, kind: 'would write', layers, dropped, runs, corrections }
  const result = admit(false)
  return result.status === 'admitted'
    ? { card, kind: 'written', layers, dropped, runs, corrections }
    : { card, kind: 'refused', why: refusalOf(result) }
}

export function backfillRunsLayers(db: DatabaseSync, options: BackfillOptions): CardOutcome[] {
  const rows = db.prepare(CARD_TEXTS).all() as { card_id: number, text: string }[]
  return rows.flatMap(row => outcomeOf(db, Number(row.card_id), row.text, options) ?? [])
}

export function outcomeLine(outcome: CardOutcome): string {
  if ('why' in outcome)
    return `${PREFIX}#${outcome.card} ${outcome.kind}: ${outcome.why}`
  return `${PREFIX}#${outcome.card} ${outcome.kind}: layers ${outcome.layers.join(', ')}; replaces ${outcome.dropped.join(', ')}; runs ${JSON.stringify(outcome.runs)}; corrections ${JSON.stringify(outcome.corrections)}`
}

function main(): number {
  const write = process.argv.includes(WRITE_FLAG)
  const file = defaultBusPath()
  if (!write && !existsSync(file)) {
    console.log(`${PREFIX}no bus at ${file}`)
    return 1
  }
  const db = write ? openBus(file) : openDatabase(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const catalog: CheckCatalog = { testLayers: catalogLayersByTest(db), moduleLayers: catalogModuleLayers(db) }
    const outcomes = backfillRunsLayers(db, { write, dir: process.cwd(), catalog, map: readLayerMap() })
    for (const outcome of outcomes)
      console.log(outcomeLine(outcome))
    console.log(`${PREFIX}${write ? 'written' : `dry run, ${WRITE_FLAG} writes`}: ${outcomes.length} cards named`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
