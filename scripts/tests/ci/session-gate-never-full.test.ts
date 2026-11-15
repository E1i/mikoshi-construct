import type { CardRunsSource, CheckCatalog } from '../../ci/card-runs.js'
import type { Graph } from '../../ci/layers.js'
import type { Selection, Suite } from '../../ci/prepush.js'
import type { VitestRun } from '../../ci/test-command.js'
import type { LayerMap } from '../../core/layer-map.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cardRunsOf, sessionCardRunsOf } from '../../ci/card-runs.js'
import { selectRun } from '../../ci/layers.js'
import { sessionSelection, testStep } from '../../ci/prepush.js'
import { GENERATED_FILES } from '../../core/generated-files.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const MANIFEST = 'package.json'
const MODULE_FILES = GENERATED_FILES.moduleFiles.path
const SOURCE = 'src/commands/board/drain.ts'
const SOURCE_TEST = 'tests/board/drain.test.ts'
const UNRELATED = 'src/commands/cost/ledger.ts'
const UNRELATED_TEST = 'tests/cost/ledger.test.ts'
const GENERATOR = 'scripts/core/declarations.ts'
const GENERATOR_TEST = 'scripts/tests/bus/conveyor/r0-declarations.test.ts'
const OWNERSHIP = 'scripts/contract/factory/modules.ts'
const OWNERSHIP_TEST = 'scripts/tests/contract/module-ownership-generated.test.ts'
const READER = 'scripts/conveyor/registries.ts'
const READER_TEST = 'scripts/tests/conveyor/registries.test.ts'
const GLOBAL_FILE = 'tsconfig.json'
const PIPELINE_FILE = 'vitest.config.ts'
const PIPELINE_TEST = 'scripts/tests/ci/vitest-config.test.ts'
const FULL_READING = /reads in full/

const MAP: LayerMap = {
  files: {},
  folders: { 'src/commands/board/': 'board', 'src/commands/cost/': 'cost', 'scripts/core/': 'core', 'scripts/contract/': 'contract', 'scripts/conveyor/': 'conveyor' },
  globals: [GLOBAL_FILE],
}

const GRAPH: Graph = new Map<string, string[]>([
  [SOURCE, []],
  [SOURCE_TEST, [SOURCE]],
  [UNRELATED, []],
  [UNRELATED_TEST, [UNRELATED]],
  [GENERATOR, []],
  [GENERATOR_TEST, [GENERATOR]],
  [OWNERSHIP, []],
  [OWNERSHIP_TEST, [OWNERSHIP]],
  [READER, []],
  [READER_TEST, [READER]],
  [PIPELINE_TEST, []],
])

const CATALOG: CheckCatalog = {
  testLayers: new Map([[SOURCE_TEST, ['board']], [UNRELATED_TEST, ['cost']], [GENERATOR_TEST, ['core']], [OWNERSHIP_TEST, ['contract']], [READER_TEST, ['conveyor']]]),
  moduleLayers: new Map([[SOURCE, ['board']], [UNRELATED, ['cost']], [GENERATOR, ['core']], [OWNERSHIP, ['contract']], [READER, ['conveyor']]]),
}
const EMPTY_CATALOG: CheckCatalog = { testLayers: new Map(), moduleLayers: new Map() }

const TEXTS: Readonly<Record<string, string>> = {
  [MANIFEST]: readFileSync(path.join(REPO_ROOT, MANIFEST), 'utf8'),
  [READER]: `const REGISTRY = '${MODULE_FILES}'`,
  [PIPELINE_TEST]: `readFileSync('${PIPELINE_FILE}')`,
}

function text(file: string): string {
  return TEXTS[file] ?? ''
}

function generatedPath(): string {
  return `generated-${randomUUID()}/${randomUUID().slice(0, 8)}.json`
}

function cardOf(touches: string[], runs: string[] = []): CardRunsSource {
  return { touches, runs, masks: [] }
}

function selectionOf(changed: string[], source: CardRunsSource, catalog: CheckCatalog = CATALOG): Selection {
  return sessionSelection(changed, GRAPH, text, sessionCardRunsOf(source, catalog, MAP), MAP)
}

function passing(): VitestRun {
  return { status: 0, error: null, report: { testResults: [{ name: path.join(REPO_ROOT, SOURCE_TEST), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'passes', status: 'passed', failureMessages: [] }] }] } }
}

function suite(): Suite & { lines: string[] } {
  const lines: string[] = []
  return { lines, vitest: vi.fn(passing), liveness: () => [], queue: vi.fn(async (step: () => Promise<number>) => step()), log: line => lines.push(line) }
}

describe('a session gate never runs the full suite', () => {
  it('a src change with contract/module-files.json runs a layered gate and no full reading', async () => {
    const touches = [SOURCE, MODULE_FILES]
    expect(cardRunsOf(cardOf(touches), CATALOG, MAP)).toEqual({ full: true, why: expect.stringContaining(MODULE_FILES) })

    const selection = selectionOf(touches, cardOf(touches))
    expect(selection.run.kind).toBe('layers')
    expect(selection.run.tests).toContain(SOURCE_TEST)

    const gate = suite()
    expect(await testStep(selection, gate)).toBe(0)
    const args = vi.mocked(gate.vitest).mock.calls[0]![0]
    expect(args).toContain(SOURCE_TEST)
    expect(args).not.toContain(UNRELATED_TEST)
    expect(gate.lines.join('\n')).not.toMatch(FULL_READING)
  })

  it('a path with no layer in the catalog runs only the tests that read it', () => {
    expect(cardRunsOf(cardOf([MODULE_FILES]), CATALOG, MAP)).toEqual({ full: true, why: expect.stringContaining(MODULE_FILES) })
    expect(selectRun([MODULE_FILES], GRAPH, text, MAP)).toEqual({ kind: 'layers', layers: ['conveyor'], tests: [READER_TEST] })
    expect(selectionOf([MODULE_FILES], cardOf([MODULE_FILES])).run).toEqual({ kind: 'layers', layers: ['conveyor'], tests: [READER_TEST, GENERATOR_TEST, OWNERSHIP_TEST].sort() })

    const unread = generatedPath()
    expect(selectionOf([unread], cardOf([unread])).run).toEqual({ kind: 'layers', layers: [], tests: [] })
    expect(selectionOf([PIPELINE_FILE], cardOf([PIPELINE_FILE])).run).toEqual({ kind: 'layers', layers: [], tests: [PIPELINE_TEST] })
  })

  it('no branch of the session gate selects the full suite', async () => {
    const generated = generatedPath()
    const readings: { name: string, changed: string[], catalog: CheckCatalog }[] = [
      { name: 'card reading', changed: [SOURCE], catalog: CATALOG },
      { name: 'dependency graph', changed: [SOURCE, MODULE_FILES, generated], catalog: CATALOG },
      { name: 'global file', changed: [SOURCE, GLOBAL_FILE], catalog: CATALOG },
      { name: 'check pipeline', changed: [SOURCE, PIPELINE_FILE], catalog: CATALOG },
      { name: 'empty catalog', changed: [SOURCE, MODULE_FILES], catalog: EMPTY_CATALOG },
      { name: 'nothing changed', changed: [], catalog: CATALOG },
    ]
    for (const unlayered of [MODULE_FILES, generated, GLOBAL_FILE, PIPELINE_FILE]) {
      for (const { name, changed, catalog } of readings) {
        const touches = [...new Set([...changed, unlayered])]
        const selection = selectionOf(touches, cardOf(touches), catalog)
        expect(selection.run.kind, `${name} with ${unlayered}`).toBe('layers')
        expect(selection.run.tests, `${name} with ${unlayered}`).not.toContain(UNRELATED_TEST)
        const gate = suite()
        await testStep(selection, gate)
        const args = vi.mocked(gate.vitest).mock.calls[0]?.[0] ?? []
        expect(args.length === 0 || selection.run.tests.every(test => args.includes(test)), `${name} with ${unlayered}`).toBe(true)
        expect(!args.some(arg => !arg.startsWith('-')) && args.length > 0, `${name} with ${unlayered} hands vitest no test file`).toBe(false)
        expect(gate.lines.join('\n'), `${name} with ${unlayered}`).not.toMatch(FULL_READING)
      }
    }
  })
})
