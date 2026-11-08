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
import { branchCardRuns, cardRunsOf, runsSourceOfBranch, runsSourceOfPr } from '../../ci/card-runs.js'
import { CHANGESET_READERS, selectRun } from '../../ci/layers.js'
import { withCardRuns } from '../../ci/prepush.js'
import { buildCatalog, overlapWithMain, rerunOf, writeCatalog } from '../../cli/check-catalog.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { Meter } from '../../ports/meter.js'
import { cardBody, MAIN_1, MAIN_2 } from '../bus/github-fake.js'
import { mergeBench } from '../bus/merge-bench.js'

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

function catalogDb(): DatabaseSync {
  const db = openBus(busPath())
  buses.push(db)
  return catalogued(db)
}

function cardOf(touches: string[], masks: string[] = [], runs: string[] = []): CardRunsSource {
  return { touches, runs, masks }
}

function readingOf(source: CardRunsSource): CardRuns {
  return cardRunsOf(source, CATALOG, MAP)
}

function prepushOf(changed: string[], source: CardRunsSource) {
  return withCardRuns(selectRun(changed, GRAPH, NO_TEXT, MAP), readingOf(source), GRAPH)
}

function mergeOf(db: DatabaseSync, pr: string[], main: string[], card: CardRunsSource | null = null): string | null {
  return overlapWithMain(db, pr, main, () => null, { card, map: MAP })
}

function admit(db: DatabaseSync, masks: string[], touches: string[] = [WORKER]): void {
  const text = parkingFileText({ card: CARD_LINE, branch: BRANCH, touches, continue: 'stop', who: 'shift', body: `Do it.\n\n${runsLine(masks.map(mask => `layer:${mask}`))}` })
  appendCardEvent(db, 'owner', { ts: '2026-11-05T00:00:00.000Z', type: CARD_ADMITTED, cardId: CARD_ID, dedupeKey: `${CARD_ADMITTED}:${CARD_ID}`, payload: { text, textSha: textSha(text) } })
  reduce(db)
}

function liveBenchOf(files: string[], mainFiles: string[]): MergeBench {
  const made = mergeBench()
  benches.push(made)
  const graph = new Map<string, string[]>([[WORKER, []], [CLI, []], [WORKER_TEST, [WORKER]], [CLI_TEST, [CLI]]])
  writeCatalog(made.db, buildCatalog({ graph, testText: NO_TEXT, cards: [], briefs: [], journal: '' }))
  made.gitHub.upToDateRequired = false
  made.gitHub.mainFiles = { [MAIN_2]: mainFiles }
  made.gitHub.main = MAIN_2
  made.gitHub.open({ number: PR, review: 'success', mergeable_state: 'behind', files, body: cardBody(PR) })
  made.tick()
  return made
}

function rerunThrough(made: MergeBench): boolean {
  return rerunOf(made.db, new Meter(made.gitHub.client, () => made.clock.now().getTime()), PR, MAIN_1).rerun
}

it('prepush adds the tests of a masked layer and never removes a selected one', () => {
  const selected = selectRun([CORE], GRAPH, NO_TEXT, MAP)

  expect(selected).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(withCardRuns(selected, readingOf(cardOf([], ['other'])), GRAPH)).toEqual({ kind: 'layers', layers: ['core', 'other'], tests: [CORE_TEST, OTHER_TEST] })
  expect(withCardRuns(selected, { layers: [], paths: [], tests: [] }, GRAPH)).toEqual(selected)
})

it('main reaching a masked layer reruns the pull request', () => {
  const made = liveBenchOf([WORKER], [CLI])
  admit(made.db, ['src'])

  expect(runsSourceOfPr(made.db, PR)).toMatchObject({ masks: ['src'] })
  expect(rerunThrough(made)).toBe(true)
  expect(rerunOf(made.db, new Meter(made.gitHub.client, () => made.clock.now().getTime()), PR, MAIN_1).why).toBe('main changed the layer src since the base')
})

it('a branch and a pull request with no card select as before', () => {
  const graph = new Map<string, string[]>([[WORKER, []], [WORKER_TEST, [WORKER]], [CLI, []], [CLI_TEST, [CLI]]])

  expect(selectRun([WORKER], graph, NO_TEXT)).toEqual({ kind: 'layers', layers: ['bus:merge'], tests: [WORKER_TEST] })
  expect(selectRun(['CONTRIBUTING.md'], graph, NO_TEXT).kind).toBe('full')
  expect(rerunThrough(liveBenchOf([WORKER], [CLI]))).toBe(false)
  expect(rerunThrough(liveBenchOf([WORKER, CLI], [CLI]))).toBe(true)
})

it('a new file in a known folder gets the same layers from the card reading prepush and merge', () => {
  const db = catalogDb()
  const card = cardOf([NEW_IN_KNOWN_FOLDER])

  expect(readingOf(card)).toEqual({ layers: ['core'], paths: [], tests: [CORE_TEST] })
  expect(prepushOf([NEW_IN_KNOWN_FOLDER], card)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(mergeOf(db, [NEW_IN_KNOWN_FOLDER], [CORE], card)).toBe('main changed the layer core since the base')
  expect(mergeOf(db, [NEW_IN_KNOWN_FOLDER], [OTHER], card)).toBeNull()
})

it('a new file in an unknown folder is a full run with a named reason in the card reading prepush and merge', () => {
  const db = catalogDb()

  for (const file of [NEW_OUTSIDE_SCRIPTS, NEW_IN_UNKNOWN_SCRIPTS_FOLDER]) {
    const card = cardOf([file])
    const named = expect.stringContaining(file)

    expect(readingOf(card)).toEqual({ full: true, why: named })
    expect(prepushOf([file], card)).toEqual({ kind: 'full', why: named })
    expect(mergeOf(db, [file], [CORE], card)).toEqual(named)
  }
  expect(selectRun([NEW_OUTSIDE_SCRIPTS], GRAPH, NO_TEXT, MAP)).toEqual({ kind: 'full', why: expect.stringContaining(NEW_OUTSIDE_SCRIPTS) })
  expect(mergeOf(db, [NEW_OUTSIDE_SCRIPTS], [CORE])).toBe(`${NEW_OUTSIDE_SCRIPTS} belongs to no layer of the check catalog`)
})

it('a seam file runs the union of its layers in the card reading prepush and merge', () => {
  const db = catalogDb()
  const newSeam = 'scripts/seam/shared/new-thing.ts'

  for (const file of [SEAM, newSeam]) {
    const card = cardOf([file])

    expect(readingOf(card)).toEqual({ layers: ['seam-a', 'seam-b'], paths: [], tests: [SEAM_A_TEST, SEAM_B_TEST] })
    expect(selectRun([file], GRAPH, NO_TEXT, MAP)).toEqual({ kind: 'layers', layers: ['seam-a', 'seam-b'], tests: [SEAM_A_TEST, SEAM_B_TEST] })
    expect(prepushOf([file], card)).toEqual({ kind: 'layers', layers: ['seam-a', 'seam-b'], tests: [SEAM_A_TEST, SEAM_B_TEST] })
    expect(mergeOf(db, [file], [SEAM_A])).toBe('main changed the layer seam-a since the base')
    expect(mergeOf(db, [file], [SEAM_B])).toBe('main changed the layer seam-b since the base')
    expect(mergeOf(db, [SEAM_B], [file])).toBe('main changed the layer seam-b since the base')
  }
})

it('explicit runs add the layers of a touched file no run covers', () => {
  const db = catalogDb()
  const card = cardOf([CORE, OTHER], [], [CORE_TEST])

  expect(readingOf(card)).toEqual({ layers: ['other'], paths: [CORE_TEST], tests: [CORE_TEST, OTHER_TEST] })
  expect(readingOf(cardOf([CORE], [], [CORE_TEST]))).toEqual({ layers: [], paths: [CORE_TEST], tests: [CORE_TEST] })
  expect(prepushOf([CORE], card)).toEqual({ kind: 'layers', layers: ['core', 'other'], tests: [CORE_TEST, OTHER_TEST] })
  expect(mergeOf(db, [CORE], [OTHER], card)).toBe('main changed the layer other since the base')
  expect(mergeOf(db, [CORE], [OTHER], cardOf([CORE], [], [CORE_TEST]))).toBeNull()
})

it('a changeset note in touches does not make the card a full run', () => {
  const db = catalogDb()

  for (const note of ['.changeset/**', NOTE]) {
    const card = cardOf([CORE, note])

    expect(readingOf(card)).toEqual({ layers: ['core'], paths: [], tests: [CORE_TEST, CHANGESET_READER] })
    expect(prepushOf([CORE, NOTE], card)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST, CHANGESET_READER] })
    expect(mergeOf(db, [CORE, NOTE], [OTHER], card)).toBeNull()
  }
  expect(readingOf(cardOf(['.changeset/**'], [], [CORE_TEST]))).toEqual({ layers: [], paths: [CORE_TEST], tests: [CORE_TEST, CHANGESET_READER] })
})

it('a helper under a test root is no test and no layer, and reads full in the card reading prepush and merge', () => {
  const helper = 'tests/cost-bus.ts'
  const db = openBus(busPath())
  buses.push(db)
  writeCatalog(db, { tests: [{ test: CORE_TEST, layer: 'core', kind: 'unit', what: '', witness: '' }], mutations: [], modules: [{ module: CORE, layers: ['core'] }, { module: helper, layers: [] }] })
  const named = `${helper} belongs to no layer of the check catalog`

  expect(cardRunsOf(cardOf([helper]), { testLayers: new Map([[CORE_TEST, ['core']]]), moduleLayers: new Map([[CORE, ['core']], [helper, []]]) }, MAP)).toEqual({ full: true, why: named })
  expect(selectRun([helper], new Map([[helper, []], ...GRAPH]), NO_TEXT, MAP)).toEqual({ kind: 'full', why: expect.stringContaining(helper) })
  expect(mergeOf(db, [helper], [CORE])).toBe(named)
})

it('a full selection stays full whatever the card reads, and a full card reading makes the selection full', () => {
  const full = selectRun([NEW_OUTSIDE_SCRIPTS], GRAPH, NO_TEXT, MAP)

  expect(withCardRuns(full, { layers: ['core'], paths: [], tests: [CORE_TEST] }, GRAPH)).toEqual(full)
  expect(withCardRuns(selectRun([CORE], GRAPH, NO_TEXT, MAP), null, GRAPH)).toEqual({ kind: 'layers', layers: ['core'], tests: [CORE_TEST] })
  expect(withCardRuns(selectRun([CORE], GRAPH, NO_TEXT, MAP), { full: true, why: 'a reason' }, GRAPH)).toEqual({ kind: 'full', why: expect.stringContaining('a reason') })
})

it('a glob in the runs of a card expands through the graph, and a name the graph lacks is dropped', () => {
  const selected = selectRun([CORE], GRAPH, NO_TEXT, MAP)

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
