import type { DatabaseSync } from 'node:sqlite'
import type { CardRuns, CardRunsSource, CheckCatalog } from '../../ci/card-runs.js'
import type { Graph } from '../../ci/layers.js'
import type { LayerMap } from '../../core/layer-map.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runsLine } from '../../../src/card/covering-tests.js'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { branchCardRuns, cardRunsOf, runsSourceOfBranch, runsSourceOfPr, sessionCardRunsOf } from '../../ci/card-runs.js'
import { CHANGESET_READERS, selectRun, sessionRun } from '../../ci/layers.js'
import { sessionSelection, withCardRuns } from '../../ci/prepush.js'
import { writeCatalog } from '../../cli/check-catalog.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'

const CORE = 'scripts/core/db.ts'
const CORE_TEST = 'scripts/tests/core/db.test.ts'
const OTHER = 'scripts/other/x.ts'
const OTHER_TEST = 'scripts/tests/other/x.test.ts'
const SEAM_A = 'scripts/seam/a.ts'
const SEAM_A_TEST = 'scripts/tests/seam/a.test.ts'
const SEAM_B = 'scripts/seam/b.ts'
const SEAM_B_TEST = 'scripts/tests/seam/b.test.ts'
const SEAM = 'scripts/seam/shared/s.ts'
const NEW_IN_KNOWN_FOLDER = 'scripts/core/new-thing.ts'
const NEW_OUTSIDE_SCRIPTS = 'tools/new-thing.ts'
const NEW_IN_UNKNOWN_SCRIPTS_FOLDER = 'scripts/unmapped/new-thing.ts'
const NOTE = '.changeset/a-note.md'
const CHANGESET_READER = CHANGESET_READERS[0]!
const WORKER = 'scripts/nodes/merge/merge-worker.ts'
const WORKER_TEST = 'scripts/tests/bus/merge-node.test.ts'
const CLI = 'src/cli.ts'
const CLI_TEST = 'tests/cli.test.ts'
const CARD_ID = 1070
const PR = 970
const BRANCH = 'feat/a-card'
const CARD_LINE = `#${CARD_ID} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`

const MAP: LayerMap = {
  files: { [SEAM_B]: 'seam-b' },
  folders: { 'scripts/core/': 'core', 'scripts/other/': 'other', 'scripts/seam/': 'seam-a', 'scripts/seam/shared/': 'seam-b' },
}
const GRAPH: Graph = new Map<string, string[]>([
  [CORE, []],
  [CORE_TEST, [CORE]],
  [OTHER, []],
  [OTHER_TEST, [OTHER]],
  [SEAM_A, []],
  [SEAM_A_TEST, [SEAM_A]],
  [SEAM_B, []],
  [SEAM_B_TEST, [SEAM_B]],
  [SEAM, []],
  [CHANGESET_READER, []],
])
const CATALOG: CheckCatalog = {
  testLayers: new Map([
    [CORE_TEST, ['core']],
    [OTHER_TEST, ['other']],
    [SEAM_A_TEST, ['seam-a']],
    [SEAM_B_TEST, ['seam-b']],
    [CHANGESET_READER, ['changesets']],
  ]),
  moduleLayers: new Map([
    [CORE, ['core']],
    [OTHER, ['other']],
    [SEAM_A, ['seam-a']],
    [SEAM_B, ['seam-b']],
    [SEAM, ['seam-a', 'seam-b']],
  ]),
}
const NO_TEXT = (): string => ''

const roots: string[] = []
const benches: MergeBench[] = []
const buses: DatabaseSync[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bus of buses.splice(0))
    bus.close()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'card-runs-gates-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function catalogued(db: DatabaseSync): DatabaseSync {
  writeCatalog(db, {
    tests: [...CATALOG.testLayers].map(([test, layers]) => ({ test, layer: layers.join(','), kind: 'unit', what: '', witness: '' })),
    mutations: [],
    modules: [...CATALOG.moduleLayers].map(([module, layers]) => ({ module, layers: [...layers] })),
  })
  return db
}

function cardOf(touches: string[], masks: string[] = [], runs: string[] = []): CardRunsSource {
  return { touches, runs, masks }
}

function readingOf(source: CardRunsSource): CardRuns {
  return cardRunsOf(source, CATALOG, MAP)
}

function prepushOf(changed: string[], source: CardRunsSource) {
  return sessionSelection(changed, GRAPH, NO_TEXT, sessionCardRunsOf(source, CATALOG, MAP), MAP).run
}

function layeredOf(changed: string[]) {
  return sessionRun(changed, GRAPH, NO_TEXT, MAP).run
}

function admit(db: DatabaseSync, masks: string[], touches: string[] = [WORKER]): void {
  const text = parkingFileText({ card: CARD_LINE, branch: BRANCH, touches, continue: 'stop', who: 'shift', body: `Do it.\n\n${runsLine(masks.map(mask => `layer:${mask}`))}` })
  appendCardEvent(BUS_CONTRACT, db, 'owner', { ts: '2026-11-05T00:00:00.000Z', type: CARD_ADMITTED, cardId: CARD_ID, dedupeKey: `${CARD_ADMITTED}:${CARD_ID}`, payload: { text, textSha: textSha(text) } })
  reduce(db, 'pending', busProjections())
}

it('prepush adds the tests of a masked layer and never removes a selected one', () => {
  const selected = layeredOf([CORE])

  expect(selected).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(withCardRuns(selected, sessionCardRunsOf(cardOf([], ['other']), CATALOG, MAP), GRAPH)).toEqual({ kind: 'layers', layers: ['core', 'other'], tests: [CORE_TEST, OTHER_TEST] })
  expect(withCardRuns(selected, { layers: [], paths: [], tests: [] }, GRAPH)).toEqual(selected)
  expect(sessionCardRunsOf(cardOf([CORE], [], [OTHER_TEST]), { testLayers: new Map(), moduleLayers: new Map() }, MAP)).toEqual({ layers: [], paths: [OTHER_TEST], tests: [OTHER_TEST] })
})

it('a branch and a pull request with no card select as before', () => {
  const graph = new Map<string, string[]>([[WORKER, []], [WORKER_TEST, [WORKER]], [CLI, []], [CLI_TEST, [CLI]]])

  expect(selectRun([WORKER], graph, NO_TEXT)).toEqual({ kind: 'layers', layers: ['bus:merge'], tests: [WORKER_TEST] })
  expect(selectRun(['CONTRIBUTING.md'], graph, NO_TEXT).kind).toBe('full')
})

it('a new file in a known folder gets the same layers from the card reading and prepush', () => {
  const card = cardOf([NEW_IN_KNOWN_FOLDER])

  expect(readingOf(card)).toEqual({ layers: ['core'], paths: [], tests: [CORE_TEST] })
  expect(prepushOf([NEW_IN_KNOWN_FOLDER], card)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
})

it('a new file in an unknown folder reads full with a named reason in the card reading, and the prepush runs its covering tests', () => {
  for (const file of [NEW_OUTSIDE_SCRIPTS, NEW_IN_UNKNOWN_SCRIPTS_FOLDER]) {
    const card = cardOf([file])
    const named = expect.stringContaining(file)

    expect(readingOf(card)).toEqual({ full: true, why: named })
    expect(prepushOf([file], card)).toEqual({ kind: 'layers', layers: [], tests: [] })
  }
  expect(selectRun([NEW_OUTSIDE_SCRIPTS], GRAPH, NO_TEXT, MAP)).toEqual({ kind: 'full', why: expect.stringContaining(NEW_OUTSIDE_SCRIPTS) })
})

it('a seam file runs the union of its layers in the card reading and prepush', () => {
  const newSeam = 'scripts/seam/shared/new-thing.ts'

  for (const file of [SEAM, newSeam]) {
    const card = cardOf([file])

    expect(readingOf(card)).toEqual({ layers: ['seam-a', 'seam-b'], paths: [], tests: [SEAM_A_TEST, SEAM_B_TEST] })
    expect(selectRun([file], GRAPH, NO_TEXT, MAP)).toEqual({ kind: 'layers', layers: ['seam-a', 'seam-b'], tests: [SEAM_A_TEST, SEAM_B_TEST] })
    expect(prepushOf([file], card)).toEqual({ kind: 'layers', layers: ['seam-a', 'seam-b'], tests: [SEAM_A_TEST, SEAM_B_TEST] })
  }
})

it('explicit runs add the layers of a touched file no run covers', () => {
  const card = cardOf([CORE, OTHER], [], [CORE_TEST])

  expect(readingOf(card)).toEqual({ layers: ['other'], paths: [CORE_TEST], tests: [CORE_TEST, OTHER_TEST] })
  expect(readingOf(cardOf([CORE], [], [CORE_TEST]))).toEqual({ layers: [], paths: [CORE_TEST], tests: [CORE_TEST] })
  expect(prepushOf([CORE], card)).toEqual({ kind: 'layers', layers: ['core', 'other'], tests: [CORE_TEST, OTHER_TEST] })
})

it('a changeset note in touches does not make the card a full run', () => {
  for (const note of ['.changeset/**', NOTE]) {
    const card = cardOf([CORE, note])

    expect(readingOf(card)).toEqual({ layers: ['core'], paths: [], tests: [CORE_TEST, CHANGESET_READER] })
    expect(prepushOf([CORE, NOTE], card)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST, CHANGESET_READER] })
  }
  expect(readingOf(cardOf(['.changeset/**'], [], [CORE_TEST]))).toEqual({ layers: [], paths: [CORE_TEST], tests: [CORE_TEST, CHANGESET_READER] })
})

it('a helper under a test root is no test and no layer, and reads full in the card reading and prepush', () => {
  const helper = 'tests/cost-bus.ts'
  const named = `${helper} belongs to no layer of the check catalog`

  expect(cardRunsOf(cardOf([helper]), { testLayers: new Map([[CORE_TEST, ['core']]]), moduleLayers: new Map([[CORE, ['core']], [helper, []]]) }, MAP)).toEqual({ full: true, why: named })
  expect(selectRun([helper], new Map([[helper, []], ...GRAPH]), NO_TEXT, MAP)).toEqual({ kind: 'full', why: expect.stringContaining(helper) })
})

it('a selection CI would run in full stays layered in the session and still takes what the card reads', () => {
  const layered = layeredOf([NEW_OUTSIDE_SCRIPTS])

  expect(selectRun([NEW_OUTSIDE_SCRIPTS], GRAPH, NO_TEXT, MAP).kind).toBe('full')
  expect(withCardRuns(layered, { layers: ['core'], paths: [], tests: [CORE_TEST] }, GRAPH)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(withCardRuns(layeredOf([CORE]), null, GRAPH)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(sessionCardRunsOf(cardOf([CORE, NEW_OUTSIDE_SCRIPTS]), CATALOG, MAP)).toEqual({ layers: ['core'], paths: [], tests: [CORE_TEST] })
})

it('a glob in the runs of a card expands through the graph, and a name the graph lacks is dropped', () => {
  const selected = layeredOf([CORE])

  expect(withCardRuns(selected, { layers: [], paths: ['scripts/tests/seam/**', 'scripts/tests/gone.test.ts'], tests: ['scripts/tests/seam/**', 'scripts/tests/gone.test.ts'] }, GRAPH)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST, SEAM_A_TEST, SEAM_B_TEST] })
})

it('the card of a branch is read from the bus, and a missing card, bus or database says so', () => {
  const file = busPath()
  const db = openBus(file)
  catalogued(db)
  admit(db, ['core'], [CORE])

  expect(runsSourceOfBranch(db, BRANCH)).toEqual({ touches: [CORE], runs: [], masks: ['core'] })
  expect(runsSourceOfBranch(db, 'feat/no-card')).toBeNull()
  expect(runsSourceOfPr(db, PR)).toBeNull()
  db.close()

  expect(branchCardRuns(BRANCH, file)).toMatchObject({ kind: 'card', reading: { layers: ['core'], tests: [CORE_TEST] } })
  expect(branchCardRuns('feat/no-card', file)).toEqual({ kind: 'no-card' })
  expect(branchCardRuns(BRANCH, path.join(path.dirname(file), 'no-such.db'))).toEqual({ kind: 'no-card' })

  const garbage = path.join(path.dirname(file), 'garbage.db')
  writeFileSync(garbage, 'not a database at all, and long enough to be read as one')
  expect(branchCardRuns(BRANCH, garbage).kind).toBe('unreadable')
})
