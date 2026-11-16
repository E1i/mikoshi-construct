import type { Graph } from '../../ci/layers.js'
import type { Suite } from '../../ci/prepush.js'
import type { VitestRun } from '../../ci/test-command.js'
import type { LayerMap } from '../../core/layer-map.js'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { witnessTestsOf } from '../../ci/card-runs.js'
import { GATE_RUN_SPOOL, recordGateRun } from '../../ci/gate-runs.js'
import { NARROW_WHY } from '../../ci/layers.js'
import { gateRecorder, narrowSelection, reachCount, reachLine, sessionSelection, testStep } from '../../ci/prepush.js'
import { openBus } from '../../core/db.js'
import { GATE_RUN } from '../../core/events.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const LEASE = 'scripts/core/lease.ts'
const LEASE_TEST = 'scripts/tests/core/lease.test.ts'
const LEASE_TAKEN_TEST = 'scripts/tests/core/lease-taken.test.ts'
const QUEUE = 'scripts/core/queue.ts'
const QUEUE_TEST = 'scripts/tests/core/queue.test.ts'
const NODE = 'scripts/core/node.ts'
const NODE_TEST = 'scripts/tests/core/node.test.ts'
const WITNESS = 'scripts/tests/ci/prepush-narrow.test.ts'
const PRINT = 'scripts/notes/print.ts'
const PRINT_TEST = 'scripts/tests/notes/print.test.ts'
const HEAD = 'a'.repeat(40)
const READ_ONLY = 0o444
const WRITABLE = 0o644

const MAP: LayerMap = { files: {}, folders: { 'scripts/core/': 'core', 'scripts/notes/': 'notes' } }

const GRAPH: Graph = new Map<string, string[]>([
  [LEASE, []],
  [LEASE_TEST, [LEASE]],
  [LEASE_TAKEN_TEST, [LEASE, QUEUE]],
  [QUEUE, [LEASE]],
  [QUEUE_TEST, [QUEUE]],
  [NODE, [QUEUE]],
  [NODE_TEST, [NODE]],
  [WITNESS, []],
  [PRINT, []],
  [PRINT_TEST, [PRINT]],
])

const CARD_TEXT = [
  'Owner. The session gate runs the direct importers.',
  `witnesses: ${JSON.stringify([
    { id: 'W1', run: `pnpm exec vitest run ${WITNESS}`, test: 'narrow', head: 'pass', base: 'fail', proves: 'items 1 and 4' },
    { id: 'W2', run: `pnpm exec vitest run ${WITNESS}`, test: 'recorded', head: 'pass', base: 'fail', proves: 'item 3' },
  ])}`,
].join('\n')

const roots: string[] = []

function busFilesMode(root: string, mode: number): void {
  for (const file of readdirSync(root).filter(name => name.startsWith('bus.db')))
    chmodSync(path.join(root, file), mode)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    busFilesMode(root, WRITABLE)
    rmSync(root, { recursive: true, force: true })
  }
})

function passing(files: readonly string[]): VitestRun {
  return { status: 0, error: null, report: { testResults: files.map(file => ({ name: path.join(REPO_ROOT, file), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'passes', status: 'passed', failureMessages: [] }] })) } }
}

function suiteOf(lines: string[], record?: Suite['record']): Suite {
  return { vitest: vi.fn((args: readonly string[]) => passing(args.filter(arg => !arg.startsWith('-')))), liveness: () => [], queue: vi.fn(async (step: () => Promise<number>) => step()), log: line => lines.push(line), ...(record === undefined ? {} : { record }) }
}

function gateRunsOn(busPath: string): { payload: Record<string, unknown> }[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(GATE_RUN) as { payload: string }[]).map(row => ({ payload: JSON.parse(row.payload) as Record<string, unknown> }))
  }
  finally {
    db.close()
  }
}

describe('the session prepush runs the narrow selection and records every run', () => {
  it('a change to scripts/core/lease.ts selects its direct tests plus the witnesses and not the whole suite', async () => {
    const witnesses = witnessTestsOf(CARD_TEXT)
    expect(witnesses).toEqual([WITNESS])

    const reachSelection = sessionSelection([LEASE], GRAPH, () => '', null, MAP)
    expect(reachSelection.run.tests).toEqual(expect.arrayContaining([LEASE_TEST, LEASE_TAKEN_TEST, QUEUE_TEST, NODE_TEST]))
    const reach = reachCount(() => reachSelection)

    const narrow = narrowSelection([LEASE], GRAPH, witnesses, reach, MAP)
    expect(narrow.run).toEqual({ kind: 'layers', layers: ['core'], tests: [WITNESS, LEASE_TAKEN_TEST, LEASE_TEST].sort() })
    expect(narrow.why).toBe(NARROW_WHY)
    expect(narrow.run.tests).not.toContain(QUEUE_TEST)
    expect(narrow.run.tests).not.toContain(PRINT_TEST)
    expect(narrow.run.tests.length).toBeLessThan(reach!)

    const lines: string[] = []
    const suite = suiteOf(lines)
    expect(await testStep(narrow, suite)).toBe(0)
    const args = vi.mocked(suite.vitest).mock.calls[0]![0]
    expect(args.filter(arg => !arg.startsWith('-') && arg.endsWith('.ts'))).toEqual(narrow.run.tests)
    expect(lines).toContain(reachLine(3, reach))
    expect(reachLine(3, reach)).toBe(`prepush: the narrow selection picked 3 test files; the reach selection would have picked ${reach}.`)
    expect(vi.mocked(suite.queue)).not.toHaveBeenCalled()

    expect(reachCount(() => {
      throw new Error('no graph')
    })).toBeNull()
    expect(reachLine(0, null)).toBe('prepush: the narrow selection picked 0 test files; the reach selection could not be counted.')

    const changedTest = narrowSelection([PRINT_TEST, 'scripts/tests/gone.test.ts'], GRAPH, ['scripts/tests/gone-witness.test.ts'], null, MAP)
    expect(changedTest.run.tests).toEqual([PRINT_TEST])
  })

  it('a gate.run event is written per prepush run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-narrow-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    const spool = path.join(root, GATE_RUN_SPOOL)
    openBus(busPath).close()
    const lines: string[] = []
    let at = 0
    const record = gateRecorder(null, HEAD, null, run => lines.push(recordGateRun(run, new Date(Date.UTC(2026, 10, 17, 0, 0, at++)).toISOString(), busPath, spool)))
    const selection = narrowSelection([LEASE], GRAPH, [WITNESS], 7, MAP)

    busFilesMode(root, READ_ONLY)
    expect(await testStep(selection, suiteOf([], record))).toBe(0)
    expect(await testStep(selection, suiteOf([], record))).toBe(0)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.startsWith(`prepush: ${GATE_RUN} kept in ${GATE_RUN_SPOOL}`))).toBe(true)
    expect(readFileSync(spool, 'utf8').trim().split('\n')).toHaveLength(2)

    busFilesMode(root, WRITABLE)
    expect(gateRunsOn(busPath)).toEqual([])
    expect(await testStep(selection, suiteOf([], record))).toBe(0)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(new RegExp(`recorded on the bus .*; 2 earlier runs kept in ${GATE_RUN_SPOOL.replaceAll('.', '\\.')} recorded with it$`))
    expect(existsSync(spool)).toBe(false)

    const events = gateRunsOn(busPath)
    expect(events).toHaveLength(3)
    expect(events.map(event => [event.payload.source, event.payload.mode, event.payload.reason, event.payload.tests])).toEqual(Array.from({ length: 3 }, () => ['prepush', 'layered', NARROW_WHY, selection.run.tests.length]))

    expect(await testStep(selection, suiteOf([], record))).toBe(0)
    expect(gateRunsOn(busPath)).toHaveLength(4)
  })
})
