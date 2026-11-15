import type { CheckCatalog } from '../../ci/card-runs.js'
import type { GateRun } from '../../ci/gate-runs.js'
import type { Graph } from '../../ci/layers.js'
import type { Suite } from '../../ci/prepush.js'
import type { VitestRun } from '../../ci/test-command.js'
import type { LayerMap } from '../../core/layer-map.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionCardRunsOf } from '../../ci/card-runs.js'
import { modeOfArgs, recordGateRun, sourceOf, touchesModuleFiles } from '../../ci/gate-runs.js'
import { gateRecorder, sessionSelection, testStep } from '../../ci/prepush.js'
import { openBus } from '../../core/db.js'
import { GATE_RUN } from '../../core/events.js'
import { GENERATED_FILES } from '../../core/generated-files.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const MODULE_FILES = GENERATED_FILES.moduleFiles.path
const SOURCE = 'src/commands/board/drain.ts'
const SOURCE_TEST = 'tests/board/drain.test.ts'
const ROUND = 'f'.repeat(40)
const CARD = 1938
const AT = '2026-11-15T10:00:00.000Z'
const LATER = '2026-11-15T10:05:00.000Z'

const MAP: LayerMap = { files: {}, folders: { 'src/commands/board/': 'board' } }
const GRAPH: Graph = new Map<string, string[]>([[SOURCE, []], [SOURCE_TEST, [SOURCE]]])
const CATALOG: CheckCatalog = { testLayers: new Map([[SOURCE_TEST, ['board']]]), moduleLayers: new Map([[SOURCE, ['board']]]) }
const TOUCHES = [SOURCE, MODULE_FILES]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function dir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-runs-'))
  roots.push(root)
  return root
}

function passing(): VitestRun {
  return { status: 0, error: null, report: { testResults: [{ name: path.join(REPO_ROOT, SOURCE_TEST), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'passes', status: 'passed', failureMessages: [] }] }] } }
}

async function ranRound(round: string | null, record: (run: GateRun) => void): Promise<readonly string[]> {
  const card = { kind: 'card' as const, card: CARD, touches: TOUCHES, reading: sessionCardRunsOf({ touches: TOUCHES, runs: [], masks: [] }, CATALOG, MAP) }
  const selection = sessionSelection(TOUCHES, GRAPH, () => '', card.reading, MAP)
  const suite: Suite = { vitest: vi.fn(passing), liveness: () => [], queue: vi.fn(async (step: () => Promise<number>) => step()), log: () => {}, record: gateRecorder(round, ROUND, card, record) }
  expect(await testStep(selection, suite)).toBe(0)
  return vi.mocked(suite.vitest).mock.calls[0]![0]
}

function eventsOf(busPath: string): { type: string, card_id: number | null, head: string | null, payload: Record<string, unknown> }[] {
  const db = openBus(busPath)
  try {
    return (db.prepare(`SELECT type, card_id, head, payload FROM events WHERE type = ? ORDER BY id`).all(GATE_RUN) as { type: string, card_id: number | null, head: string | null, payload: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
  }
  finally {
    db.close()
  }
}

describe('every session gate and prepush run leaves one gate.run event', () => {
  it('a gate run on a card touching contract/module-files.json records layered with the tests it really ran', async () => {
    const root = dir()
    const busPath = path.join(root, 'bus.db')
    openBus(busPath).close()

    const gateRuns: GateRun[] = []
    const gateArgs = await ranRound(ROUND, run => gateRuns.push(run))
    const prepushRuns: GateRun[] = []
    const prepushArgs = await ranRound(null, run => prepushRuns.push(run))

    expect(gateArgs).toContain(SOURCE_TEST)
    expect(gateRuns).toEqual([{ source: 'gate', mode: modeOfArgs(gateArgs), reason: expect.stringMatching(/\S/), seconds: expect.any(Number), round: ROUND, card: CARD, moduleFiles: true, tests: 1 }])
    expect(gateRuns[0]!.mode).toBe('layered')
    expect(prepushRuns).toEqual([{ ...gateRuns[0]!, source: 'prepush', mode: modeOfArgs(prepushArgs), seconds: expect.any(Number) }])

    recordGateRun(gateRuns[0]!, AT, busPath)
    recordGateRun(prepushRuns[0]!, LATER, busPath)
    const events = eventsOf(busPath)
    expect(events.map(event => [event.payload.source, event.payload.mode, event.payload.round, event.payload.moduleFiles, event.card_id, event.head])).toEqual([
      ['gate', 'layered', ROUND, true, CARD, ROUND],
      ['prepush', 'layered', ROUND, true, CARD, ROUND],
    ])
    expect(events.every(event => typeof event.payload.seconds === 'number' && typeof event.payload.reason === 'string')).toBe(true)
  })

  it('the mode follows the arguments vitest got, not a recorded field', () => {
    expect(modeOfArgs([SOURCE_TEST, '--passWithNoTests'])).toBe('layered')
    expect(modeOfArgs(['--retry=1'])).toBe('full')
    expect(modeOfArgs([])).toBe('full')
    expect(modeOfArgs(null)).toBe('layered')
    expect(sourceOf(null)).toBe('prepush')
    expect(sourceOf(ROUND)).toBe('gate')
    expect(touchesModuleFiles([SOURCE])).toBe(false)
  })

  it('a run with no bus to write prints its event in the log and writes no file', () => {
    const root = dir()
    const busPath = path.join(root, 'absent', 'bus.db')
    const run: GateRun = { source: 'prepush', mode: 'layered', reason: 'the layers the change reaches', seconds: 3, round: ROUND, card: null, moduleFiles: false, tests: 0 }
    const line = recordGateRun(run, AT, busPath)
    expect(line).toContain(`${GATE_RUN} not recorded, no bus is reachable from here`)
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ source: 'prepush', mode: 'layered', round: ROUND })
    expect(existsSync(busPath)).toBe(false)
  })
})
