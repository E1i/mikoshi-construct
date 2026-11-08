import type { CheckCatalog } from '../../ci/card-runs.js'
import type { Graph } from '../../ci/layers.js'
import type { LayerMap } from '../../core/layer-map.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVERY_CHANGE_READERS } from '../../../src/card/covering-tests.js'
import { cardRunsOf } from '../../ci/card-runs.js'
import { selectRun } from '../../ci/layers.js'
import { rebuildCatalogAt, writeCatalog } from '../../cli/check-catalog.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, MERGE_DONE, REVIEW_RECORDED } from '../../core/events.js'
import { DOCS_LAYER, isCheckPipeline, isTestInfrastructure, layersInOf } from '../../core/layer-map.js'
import { CATALOG_REBUILD_FAILED, MergeNode } from '../../nodes/merge/merge-worker.js'
import { cardBody, MAIN_2, sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

const QUEUE = 'scripts/core/queue.ts'
const SEAM = 'scripts/core/db.ts'
const FRESH = 'scripts/core/fresh.ts'
const CI_MODULE = 'scripts/ci/layers.ts'
const CARD_RUNS = 'scripts/ci/card-runs.ts'
const WINDOW_DOC = 'architecture/window.md'
const COMPOSITION = 'architecture/composition/intake.yaml'
const RECORD = 'contract/factory.json'
const ORPHAN = 'src/orphan.ts'
const QUEUE_TEST = 'scripts/tests/core/queue.test.ts'
const SEAM_TEST = 'scripts/tests/bus/db.test.ts'
const RECORD_TEST = 'tests/contract/factory.test.ts'
const DOCS_TEST = 'scripts/tests/docs/window.test.ts'
const CI_TEST = 'scripts/tests/ci/card-runs.test.ts'
const NEW_TEST = 'scripts/tests/core/brand-new.test.ts'
const FULL = 'full'

const MAP: LayerMap = {
  files: { [SEAM]: 'bus-core', [RECORD]: 'contract' },
  folders: { 'scripts/core/': 'core', 'scripts/ci/': 'ci', 'scripts/nodes/': 'nodes' },
}

const GRAPH: Graph = new Map([
  [QUEUE, []],
  [SEAM, []],
  [QUEUE_TEST, [QUEUE]],
  [SEAM_TEST, [SEAM]],
  [RECORD_TEST, []],
  [DOCS_TEST, []],
  [CARD_RUNS, []],
  [CI_TEST, [CARD_RUNS]],
])

const TEST_TEXT: Readonly<Record<string, string>> = {
  [DOCS_TEST]: `readFileSync('${WINDOW_DOC}', 'utf8'); readFileSync('${COMPOSITION}', 'utf8')`,
}

const CATALOG: CheckCatalog = {
  moduleLayers: new Map([[QUEUE, ['core']], [SEAM, ['bus-core']], [CARD_RUNS, ['ci']]]),
  testLayers: new Map([[QUEUE_TEST, ['core']], [SEAM_TEST, ['bus-core']], [RECORD_TEST, ['contract']], [DOCS_TEST, [DOCS_LAYER]], [CI_TEST, ['ci']]]),
}

const LAYER_OF_FILE: Readonly<Record<string, { layer: string, selected: string, carded: string }>> = {
  [FRESH]: { layer: 'core', selected: 'core', carded: 'core' },
  [SEAM]: { layer: 'bus-core', selected: 'bus-core', carded: 'bus-core' },
  [CI_MODULE]: { layer: 'ci', selected: FULL, carded: 'ci' },
  [CARD_RUNS]: { layer: 'ci', selected: FULL, carded: 'ci' },
  [WINDOW_DOC]: { layer: DOCS_LAYER, selected: DOCS_LAYER, carded: DOCS_LAYER },
  [RECORD]: { layer: 'contract', selected: 'contract', carded: 'contract' },
  [COMPOSITION]: { layer: DOCS_LAYER, selected: DOCS_LAYER, carded: DOCS_LAYER },
}

function testText(test: string): string {
  return TEST_TEXT[test] ?? ''
}

function selected(file: string): string[] | typeof FULL {
  const run = selectRun([file], GRAPH, testText, MAP)
  return run.kind === 'full' ? FULL : run.layers
}

function carded(file: string): string[] | typeof FULL {
  const runs = cardRunsOf({ touches: [file], runs: [], masks: [] }, CATALOG, MAP)
  return 'full' in runs ? FULL : runs.layers
}

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function aBrokenTree(stderr: string): { clone: string, bus: string, commit: string } {
  const root = aTempRoot('layer-map-rebuild-')
  const origin = path.join(root, 'origin.git')
  const clone = path.join(root, 'clone')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' })
  git(clone, 'checkout', '-q', '-B', 'main')
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(clone, 'node_modules'))
  mkdirSync(path.join(clone, 'scripts', 'cli'), { recursive: true })
  writeFileSync(path.join(clone, 'scripts', 'cli', 'check-catalog.ts'), `console.error(${JSON.stringify(stderr)})\nprocess.exit(3)\n`)
  git(clone, 'add', 'scripts')
  git(clone, 'commit', '-q', '-m', 'broken')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')
  return { clone, bus: path.join(root, 'bus.db'), commit: git(clone, 'rev-parse', 'HEAD') }
}

function aMergeOfANewTest(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  writeCatalog(made.db, { tests: [{ test: 'tests/cli.test.ts', layer: 'src', kind: 'unit', what: '', witness: '' }], mutations: [] })
  made.gitHub.upToDateRequired = false
  made.gitHub.open({ number: 970, review: 'success', files: [NEW_TEST], body: `${cardBody(970)}\n\n■ 4 □ 1 · 1` })
  made.tick()
  return made
}

it('every reader answers the same layer for a new file, a seam, ci and md json yml', () => {
  const answers = Object.keys(LAYER_OF_FILE).map(file => ({ file, layersIn: layersInOf(MAP, file), selected: selected(file), carded: carded(file) }))

  expect(answers).toEqual(Object.entries(LAYER_OF_FILE).map(([file, { layer, selected, carded }]) => ({
    file,
    layersIn: [layer],
    selected: selected === FULL ? FULL : expect.arrayContaining([selected]),
    carded: [carded],
  })))
})

it('only the files that choose or run the tests are test infrastructure, and the rest of scripts/ci keeps its ci layer for a card', () => {
  expect([CI_MODULE, CARD_RUNS, 'vitest.config.ts', 'scripts/ci/tree-scanners.ts'].map(isTestInfrastructure)).toEqual([true, false, true, false])
  expect([CI_MODULE, CARD_RUNS, 'vitest-setup.ts', WINDOW_DOC].map(isCheckPipeline)).toEqual([true, true, true, false])
  expect(cardRunsOf({ touches: [CARD_RUNS, CI_MODULE], runs: [], masks: [] }, CATALOG, MAP)).toEqual({ layers: ['ci'], paths: [], tests: [CI_TEST] })
})

it('a layer resolver outside the layer map is red', () => {
  expect(findSites(REPO_ROOT).filter(site => site.concept === 'layers')).toEqual([])

  const root = aTempRoot('layer-resolver-')
  mkdirSync(path.join(root, 'scripts', 'thing'), { recursive: true })
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'scripts', 'thing', 'thing.ts'), 'export function layersOfThing(file: string): string[] {\n  return [file]\n}\n')

  expect(findSites(root).filter(site => site.concept === 'layers')).toEqual([expect.objectContaining({ file: 'scripts/thing/thing.ts', line: 1 })])
})

it('a failed catalog rebuild writes an event with its reason', async () => {
  const { clone, bus, commit } = aBrokenTree('depcruise is not installed in this tree')
  const made = aMergeOfANewTest()
  const node = new MergeNode({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: {}, rebuildCatalog: () => rebuildCatalogAt(commit, bus, clone) })
  const controller = new AbortController()

  await node.run({ pause: async () => controller.abort(), signal: controller.signal })

  expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
  expect(eventsOf(made.db, BOARD_ALARM)).toContainEqual(expect.objectContaining({ reason: CATALOG_REBUILD_FAILED, ref: MAIN_2, detail: expect.stringContaining('depcruise is not installed in this tree') }))
})

it('a change only to a docs file runs the docs layer tests and the every-change readers, not the full suite', () => {
  expect(selectRun([WINDOW_DOC], GRAPH, testText, MAP)).toEqual({ kind: 'layers', layers: [DOCS_LAYER], tests: [...new Set([DOCS_TEST, ...EVERY_CHANGE_READERS.filter(test => GRAPH.has(test))])].sort() })
  expect(cardRunsOf({ touches: [WINDOW_DOC], runs: [], masks: [] }, CATALOG, MAP)).toEqual({ layers: [DOCS_LAYER], paths: [], tests: [DOCS_TEST] })
  for (const glob of ['architecture/**', 'docs/**', '.claude/skills/**'])
    expect(cardRunsOf({ touches: [glob], runs: [], masks: [] }, CATALOG, MAP), glob).toEqual({ layers: [DOCS_LAYER], paths: [], tests: [DOCS_TEST] })
  expect(cardRunsOf({ touches: ['bin/**'], runs: [], masks: [] }, CATALOG, MAP)).toEqual({ full: true, why: 'bin/** belongs to no layer of the check catalog' })
})

it('a new test file not yet in the graph runs itself and not the full suite', () => {
  expect(selectRun([NEW_TEST], GRAPH, testText, MAP)).toEqual({ kind: 'layers', layers: [], tests: expect.arrayContaining([NEW_TEST]) })
  expect(cardRunsOf({ touches: [NEW_TEST], runs: [], masks: [] }, CATALOG, MAP)).toEqual({ layers: [], paths: [], tests: [NEW_TEST] })
})

it('a code file outside every layer still runs the full suite', () => {
  expect(selectRun([ORPHAN], GRAPH, testText, MAP)).toEqual({ kind: 'full', why: `${ORPHAN} belongs to no layer of the dependency graph` })
  expect(cardRunsOf({ touches: [ORPHAN], runs: [], masks: [] }, CATALOG, MAP)).toEqual({ full: true, why: `${ORPHAN} belongs to no layer of the check catalog` })
})
