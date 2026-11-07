import type { Graph, Run } from '../../ci/layers.js'
import type { Selection, Suite } from '../../ci/prepush.js'
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
const PARSE = 'scripts/notes/parse.ts'
const PARSE_TEST = 'scripts/tests/notes/parse.test.ts'
const GRAPH: Graph = new Map([[PRINT, []], [PRINT_TEST, [PRINT]], [PARSE, []], [PARSE_TEST, [PARSE]]])

function select(files: readonly string[]): Run {
  return selectRun(files, GRAPH, () => '')
}

function selection(changed: string[], reading: Selection['reading'] = null): Selection {
  return { changed, run: reportedRun(select(changed)), graph: GRAPH, select, reading }
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
    expect(selection([NO_LAYER]).run.kind).toBe('full')
    const round = suite()
    expect(await testStep(selection([NO_LAYER]), ROUND, round)).toBe(0)
    expect(round.vitest).not.toHaveBeenCalled()
    expect(round.queue).not.toHaveBeenCalled()
    expect(round.lines.join('\n')).toMatch(/0 tests of the layers this round reaches ran; the full suite is CI's/)
  })

  it('without a round the same change still runs the full suite through the quality lock', async () => {
    const session = suite()
    expect(await testStep(selection([NO_LAYER]), null, session)).toBe(0)
    expect(session.queue).toHaveBeenCalledTimes(1)
    expect(session.vitest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(session.vitest).mock.calls[0]![0]).not.toContain(PRINT_TEST)
    expect(session.lines.join('\n')).toMatch(/prepush: green — 1 tests ran; the push may go\./)
  })

  it('a round that runs in full for one path still runs the tests the rest of its change reaches, outside the lock', async () => {
    expect(selection([NO_LAYER, PRINT]).run.kind).toBe('full')
    expect(roundRun(selection([NO_LAYER, PRINT]))).toEqual({ kind: 'layers', layers: ['notes'], tests: [PRINT_TEST] })
    const round = suite()
    expect(await testStep(selection([NO_LAYER, PRINT]), ROUND, round)).toBe(0)
    expect(round.queue).not.toHaveBeenCalled()
    expect(vi.mocked(round.vitest).mock.calls[0]![0]).toContain(PRINT_TEST)
  })

  it('a full path of a round still runs the tests that import it', () => {
    const infra = 'scripts/ci/gate.ts'
    const graph: Graph = new Map([[infra, []], ['scripts/tests/ci/gate.test.ts', [infra]]])
    const full = selectRun([infra], graph, () => '')
    expect(full.kind).toBe('full')
    expect(roundRun({ changed: [infra], run: full, graph, select: files => selectRun(files, graph, () => ''), reading: null })).toEqual({ kind: 'layers', layers: [], tests: ['scripts/tests/ci/gate.test.ts'] })
  })

  it('a layered round keeps the selection it already has', () => {
    const layered = selection([PRINT])
    expect(roundRun(layered)).toBe(layered.run)
  })

  it('a round that would run in full still runs the tests and layers the card names in its Runs', async () => {
    const card = selection([NO_LAYER], { layers: ['parse'], paths: [PARSE_TEST], tests: [PARSE_TEST] })
    expect(roundRun(card)).toEqual({ kind: 'layers', layers: ['parse'], tests: [PARSE_TEST] })
    const round = suite()
    expect(await testStep(card, ROUND, round)).toBe(0)
    expect(round.queue).not.toHaveBeenCalled()
    expect(vi.mocked(round.vitest).mock.calls[0]![0]).toContain(PARSE_TEST)
  })

  it('a card that reads in full names no test, so its round runs the layers its change reaches', () => {
    expect(roundRun(selection([NO_LAYER, PRINT], { full: true, why: 'an unknown folder' }))).toEqual({ kind: 'layers', layers: ['notes'], tests: [PRINT_TEST] })
  })
})
