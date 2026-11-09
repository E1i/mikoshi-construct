import type { Graph, Run } from '../../ci/layers.js'
import type { Git, Selection, Suite } from '../../ci/prepush.js'
import type { VitestRun } from '../../ci/test-command.js'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { selectRun } from '../../ci/layers.js'
import { changesSince, gateBase, roundRun, testStep } from '../../ci/prepush.js'
import { reportedRun } from '../../ci/select.js'
import { InMemoryCi } from '../../ports/ci-reading.js'

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

const MERGE_BASE = 'a'.repeat(40)
const GREEN_MAIN = 'b'.repeat(40)
const NEWER_GREEN_OFF_BRANCH = 'c'.repeat(40)

const branch: Git = (args) => {
  if (args[0] === 'merge-base' && args[1] === 'HEAD')
    return `${MERGE_BASE}\n`
  if (args[0] === 'merge-base')
    return `${args[1] === GREEN_MAIN ? GREEN_MAIN : MERGE_BASE}\n`
  if (args[0] === 'diff')
    return args.at(-1) === GREEN_MAIN ? `${PRINT}\0` : `${PRINT}\0${NO_LAYER}\0`
  return ''
}

describe('the window gate reads its base from the last green main and leaves the full run to CI', () => {
  it('the window gate diffs from the last main commit with green CI and runs only the layers its change reaches', async () => {
    const ci = new InMemoryCi({ runsOnMain: [{ databaseId: 2, headSha: NEWER_GREEN_OFF_BRANCH }, { databaseId: 1, headSha: GREEN_MAIN }] })
    const base = gateBase(branch, null, ci)
    expect(base).toEqual({ sha: GREEN_MAIN, why: expect.stringContaining('the last main commit with green CI') })
    const changed = changesSince(branch, base.sha)
    expect(changed).toEqual([PRINT])
    const gate = suite()
    expect(await testStep(selection(changed), gate)).toBe(0)
    expect(vi.mocked(gate.vitest).mock.calls[0]![0]).toContain(PRINT_TEST)
    expect(vi.mocked(gate.vitest).mock.calls[0]![0]).not.toContain(PARSE_TEST)
    expect(gateBase(branch, ROUND, ci)).toEqual({ sha: ROUND, why: 'the head the round started on' })
    expect(gateBase(branch, null, { successfulRunsOnMain: () => ({ kind: 'failed', reason: 'gh timed out', cause: 'timeout' }) })).toEqual({ sha: MERGE_BASE, why: expect.stringContaining('gh timed out') })
    expect(gateBase(branch, null, new InMemoryCi({ runsOnMain: [{ databaseId: 2, headSha: NEWER_GREEN_OFF_BRANCH }] })).sha).toBe(MERGE_BASE)
  })

  it('the window gate never runs the full suite and names CI as the full run', async () => {
    for (const changed of [[NO_LAYER], [NO_LAYER, PRINT]]) {
      expect(selection(changed).run.kind).toBe('full')
      const gate = suite()
      expect(await testStep(selection(changed), gate)).toBe(0)
      expect(gate.queue).not.toHaveBeenCalled()
      for (const [args] of vi.mocked(gate.vitest).mock.calls)
        expect(args).toContain(PRINT_TEST)
      expect(gate.lines.join('\n')).toMatch(/prepush: green — \d+ tests of the layers this change reaches ran; the full suite is CI's, and the merge waits for its green run; the push may go\./)
    }
  })
})

describe('the gate answer round runs only the layers its change reaches', () => {
  it('a round whose change belongs to no layer runs no full suite and never takes the quality lock', async () => {
    expect(selection([NO_LAYER]).run.kind).toBe('full')
    const round = suite()
    expect(await testStep(selection([NO_LAYER]), round)).toBe(0)
    expect(round.vitest).not.toHaveBeenCalled()
    expect(round.queue).not.toHaveBeenCalled()
    expect(round.lines.join('\n')).toMatch(/0 tests of the layers this change reaches ran; the full suite is CI's/)
  })

  it('a round that runs in full for one path still runs the tests the rest of its change reaches, outside the lock', async () => {
    expect(selection([NO_LAYER, PRINT]).run.kind).toBe('full')
    expect(roundRun(selection([NO_LAYER, PRINT]))).toEqual({ kind: 'layers', layers: ['notes'], tests: [PRINT_TEST] })
    const round = suite()
    expect(await testStep(selection([NO_LAYER, PRINT]), round)).toBe(0)
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
    expect(await testStep(card, round)).toBe(0)
    expect(round.queue).not.toHaveBeenCalled()
    expect(vi.mocked(round.vitest).mock.calls[0]![0]).toContain(PARSE_TEST)
  })

  it('a card that reads in full names no test, so its round runs the layers its change reaches', () => {
    expect(roundRun(selection([NO_LAYER, PRINT], { full: true, why: 'an unknown folder' }))).toEqual({ kind: 'layers', layers: ['notes'], tests: [PRINT_TEST] })
  })
})
