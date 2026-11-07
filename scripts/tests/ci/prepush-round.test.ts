import type { Graph, Run } from '../../ci/layers.js'
import type { Suite } from '../../ci/prepush.js'
import type { VitestRun } from '../../ci/test-command.js'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { selectRun } from '../../ci/layers.js'
import { roundRun, testStep } from '../../ci/prepush.js'
import { reportedRun } from '../../ci/select.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ROUND = 'abc1234'
const NO_LAYER = 'notes/loose.txt'
const PRINT = 'scripts/notes/print.ts'
const PRINT_TEST = 'scripts/tests/notes/print.test.ts'
const GRAPH: Graph = new Map([[PRINT, []], [PRINT_TEST, [PRINT]]])

function select(files: readonly string[]): Run {
  return selectRun(files, GRAPH, () => '')
}

function passing(file: string): VitestRun {
  return {
    status: 0,
    error: null,
    report: { testResults: [{ name: path.join(REPO_ROOT, file), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'passes', status: 'passed', failureMessages: [] }] }] },
  }
}

function suite(): Suite & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    vitest: vi.fn(() => passing(PRINT_TEST)),
    liveness: () => [],
    queue: vi.fn(async (step: () => Promise<number>) => step()),
    log: line => lines.push(line),
  }
}

describe('the gate answer round runs only the layers its change reaches', () => {
  it('a round whose change belongs to no layer runs no full suite and never takes the quality lock', async () => {
    const selected = reportedRun(select([NO_LAYER]))
    expect(selected.kind).toBe('full')
    const round = suite()
    expect(await testStep([NO_LAYER], selected, ROUND, GRAPH, select, round)).toBe(0)
    expect(round.vitest).not.toHaveBeenCalled()
    expect(round.queue).not.toHaveBeenCalled()
    expect(round.lines.join('\n')).toMatch(/0 tests of the layers this round reaches ran; the full suite is CI's/)
  })

  it('without a round the same change still runs the full suite through the quality lock', async () => {
    const selected = reportedRun(select([NO_LAYER]))
    const session = suite()
    expect(await testStep([NO_LAYER], selected, null, GRAPH, select, session)).toBe(0)
    expect(session.queue).toHaveBeenCalledTimes(1)
    expect(session.vitest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(session.vitest).mock.calls[0]![0]).not.toContain(PRINT_TEST)
    expect(session.lines.join('\n')).toMatch(/prepush: green — 1 tests ran; the push may go\./)
  })

  it('a round that runs in full for one path still runs the tests the rest of its change reaches, outside the lock', async () => {
    const selected = reportedRun(select([NO_LAYER, PRINT]))
    expect(selected.kind).toBe('full')
    expect(roundRun(selected, [NO_LAYER, PRINT], GRAPH, select)).toEqual({ kind: 'layers', layers: ['notes'], tests: [PRINT_TEST] })
    const round = suite()
    expect(await testStep([NO_LAYER, PRINT], selected, ROUND, GRAPH, select, round)).toBe(0)
    expect(round.queue).not.toHaveBeenCalled()
    expect(vi.mocked(round.vitest).mock.calls[0]![0]).toContain(PRINT_TEST)
  })

  it('a full path of a round still runs the tests that import it', () => {
    const infra = 'scripts/ci/gate.ts'
    const graph: Graph = new Map([[infra, []], ['scripts/tests/ci/gate.test.ts', [infra]]])
    const full = selectRun([infra], graph, () => '')
    expect(full.kind).toBe('full')
    expect(roundRun(full, [infra], graph, files => selectRun(files, graph, () => ''))).toEqual({ kind: 'layers', layers: [], tests: ['scripts/tests/ci/gate.test.ts'] })
  })

  it('a layered round keeps the selection it already has', () => {
    const layered = select([PRINT])
    expect(roundRun(layered, [PRINT], GRAPH, select)).toBe(layered)
  })
})
