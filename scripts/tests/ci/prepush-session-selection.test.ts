import type { Suite } from '../../ci/prepush.js'
import type { SandboxFailing } from '../../ci/sandbox-failing.js'
import type { VitestRun } from '../../ci/test-command.js'
import type { LayerMap } from '../../core/layer-map.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATE_RUN_SPOOL } from '../../ci/gate-runs.js'
import { NARROW_WHY } from '../../ci/layers.js'
import { CENTRAL_REACH, centralFiles, gateRecorder, gateSelection, SESSION_SLOW_TESTS, sessionRecord, testStep } from '../../ci/prepush.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, GATE_RUN, REVIEW_RECORDED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { ANSWER_TREE_GATE_RUN_SPOOL, AnswerExecutor, drainAnswerTreeGateRuns } from '../../nodes/answer/answer-executor.js'
import { collectReport, TREE_GATE_RUN_SPOOL } from '../../nodes/launch/report-collect.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { mergeBench } from '../bus/merge-bench.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const HEAD = 'b'.repeat(40)
const MAP: LayerMap = { files: {}, folders: { 'scripts/core/': 'core', 'scripts/conveyor/': 'conveyor' } }

const CENTRAL = 'scripts/core/events.ts'
const SUBJECT = 'scripts/conveyor/handover.ts'
const K3 = 'scripts/tests/bus/conveyor/k3-handover-predicate.test.ts'
const K1A = 'scripts/tests/bus/conveyor/k1a-process-records.test.ts'
const PS_TEST = 'scripts/tests/bus/needs-ps.test.ts'
const QUICK = 'scripts/tests/core/events.test.ts'
const WITNESS = 'scripts/tests/ci/prepush-session-selection.test.ts'
const CENTRAL_READERS = Array.from({ length: CENTRAL_REACH }, (_, at) => `scripts/tests/core/reader-${at}.test.ts`)

const GRAPH = new Map<string, string[]>([
  [CENTRAL, []],
  [SUBJECT, [CENTRAL]],
  [K3, [CENTRAL, SUBJECT]],
  [K1A, [CENTRAL]],
  [PS_TEST, [CENTRAL]],
  [QUICK, [CENTRAL]],
  [WITNESS, []],
  ...CENTRAL_READERS.map((test): [string, string[]] => [test, [CENTRAL]]),
])

const NEEDS_PS: SandboxFailing[] = [{ file: PS_TEST, test: 'launch queue > reads the process table [needs ps]', refused: 'spawnSync ps EPERM' }]
const NO_CARD_READING = { layers: [], paths: [], tests: [] }
const card = (touches: string[] = []): { reading: typeof NO_CARD_READING, witnesses: string[], touches: string[] } => ({ reading: NO_CARD_READING, witnesses: [WITNESS], touches })

const ANSWERED_CARD = 2021
const ANSWERED_PR = ANSWERED_CARD - 100

const roots: string[] = []
const benches: MergeBench[] = []

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'prepush-session-'))
  roots.push(root)
  return root
}

function busFilesMode(root: string, mode: number): void {
  for (const file of readdirSync(root).filter(name => name.startsWith('bus.db')))
    chmodSync(path.join(root, file), mode)
}

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0)) {
    busFilesMode(root, 0o644)
    rmSync(root, { recursive: true, force: true })
  }
})

function passing(files: readonly string[]): VitestRun {
  return { status: 0, error: null, report: { testResults: files.map(file => ({ name: path.join(REPO_ROOT, file), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'passes', status: 'passed', failureMessages: [] }] })) } }
}

function suiteOf(lines: string[], record?: Suite['record']): Suite {
  return { vitest: vi.fn((args: readonly string[]) => passing(args.filter(arg => !arg.startsWith('-')))), liveness: () => [], queue: vi.fn(async (step: () => Promise<number>) => step()), log: line => lines.push(line), ...(record === undefined ? {} : { record }) }
}

function gateRunsOn(busPath: string): number {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(GATE_RUN) as { n: number }).n
  }
  finally {
    db.close()
  }
}

describe('the card session prepush leaves out what only CI can afford', () => {
  it('a session prepush skips the needs-ps tests and names them', async () => {
    const selection = gateSelection([SUBJECT], GRAPH, card(), () => '', MAP, { failing: NEEDS_PS, slow: [] })
    expect(selection.run.tests).not.toContain(PS_TEST)
    expect(selection.skipped?.sandbox).toEqual([])

    const reaching = gateSelection([CENTRAL], GRAPH, card(), () => '', MAP, { failing: NEEDS_PS, slow: [] })
    expect(reaching.run.tests).not.toContain(PS_TEST)
    expect(reaching.run.tests).toContain(QUICK)
    expect(reaching.skipped?.sandbox).toEqual([PS_TEST])

    const lines: string[] = []
    const suite = suiteOf(lines)
    expect(await testStep(reaching, suite)).toBe(0)
    const ran = vi.mocked(suite.vitest).mock.calls[0]![0]
    expect(ran).not.toContain(PS_TEST)
    expect(lines.some(line => line.startsWith('prepush: skipped in this card session, 1 test files scripts/ci/sandbox-failing.jsonl lists') && line.endsWith(PS_TEST))).toBe(true)

    const outsideASession = gateSelection([CENTRAL], GRAPH, null, () => '', MAP)
    expect(outsideASession.run.tests).toContain(PS_TEST)
    expect(outsideASession.skipped).toBeUndefined()
  })

  it('a central file alone does not pull the conveyor scenario tests into a session selection', async () => {
    const lists = { failing: [], slow: SESSION_SLOW_TESTS }
    const central = gateSelection([CENTRAL], GRAPH, card(), () => '', MAP, lists)
    expect(central.why).toBe(NARROW_WHY)
    expect(central.run.tests).not.toContain(K3)
    expect(central.run.tests).not.toContain(K1A)
    expect(central.run.tests).toEqual(expect.arrayContaining([QUICK, WITNESS, ...CENTRAL_READERS]))
    expect(central.skipped?.slow).toEqual([K1A, K3])

    const lines: string[] = []
    expect(await testStep(central, suiteOf(lines))).toBe(0)
    expect(lines).toContain(`prepush: skipped in this card session, 2 slow test files reached only through a central file; CI runs them: ${K1A}, ${K3}`)

    expect(gateSelection([CENTRAL, SUBJECT], GRAPH, card(), () => '', MAP, lists).run.tests).toContain(K3)
    expect(gateSelection([CENTRAL], GRAPH, card([K1A]), () => '', MAP, lists).run.tests).toContain(K1A)
    expect(gateSelection([CENTRAL, K3], GRAPH, card(), () => '', MAP, lists).run.tests).toContain(K3)
    expect(gateSelection([CENTRAL], GRAPH, null, () => '', MAP, lists).run.tests).toEqual(expect.arrayContaining([K1A, K3]))
  })

  it('a session end drains the tree gate-run spool into the bus', () => {
    expect(TREE_GATE_RUN_SPOOL).toBe(GATE_RUN_SPOOL)
    expect(ANSWER_TREE_GATE_RUN_SPOOL).toBe(GATE_RUN_SPOOL)

    const busRoot = freshRoot()
    const busPath = path.join(busRoot, 'bus.db')
    openBus(busPath).close()
    const tree = freshRoot()
    busFilesMode(busRoot, 0o444)
    const lines: string[] = []
    gateRecorder(HEAD, HEAD, { kind: 'card', card: 2010, touches: [], reading: NO_CARD_READING, witnesses: [WITNESS] }, sessionRecord(line => lines.push(line), tree, busPath))({ mode: 'layered', reason: NARROW_WHY, seconds: 3, tests: 2 })
    expect(lines[0]).toMatch(/kept in .*the launch or answer node drains it/)
    busFilesMode(busRoot, 0o644)
    expect(gateRunsOn(busPath)).toBe(0)

    mkdirSync(path.join(tree, '.construct'), { recursive: true })
    writeFileSync(path.join(tree, '.construct', 'report.md'), 'card line\n')
    const collected = collectReport(tree, path.join(busRoot, 'reports', '2010.md'), busPath)
    expect(collected).toMatchObject({ kind: 'collected', gateRuns: { kind: 'drained', count: 1 } })
    expect(existsSync(path.join(tree, GATE_RUN_SPOOL))).toBe(false)
    expect(gateRunsOn(busPath)).toBe(1)
    expect(collectReport(tree, path.join(busRoot, 'reports', '2010.md'), busPath)).toEqual({ kind: 'absent', tree: path.join(tree, '.construct', 'report.md') })
    expect(gateRunsOn(busPath)).toBe(1)

    busFilesMode(busRoot, 0o444)
    gateRecorder(HEAD, HEAD, null, sessionRecord(() => {}, tree, busPath))({ mode: 'layered', reason: NARROW_WHY, seconds: 1, tests: 1 })
    busFilesMode(busRoot, 0o644)
    const db = openBus(busPath)
    try {
      expect(drainAnswerTreeGateRuns(db, tree)).toBe(1)
      expect(drainAnswerTreeGateRuns(db, tree)).toBe(0)
    }
    finally {
      db.close()
    }
    expect(gateRunsOn(busPath)).toBe(2)
    expect(readFileSync(path.join(busRoot, 'reports', '2010.md'), 'utf8')).toBe('card line\n')
  })

  it('the answer executor drains the tree gate-run spool when its session ends', async () => {
    const made = mergeBench()
    benches.push(made)
    const spoolBusRoot = freshRoot()
    const spoolBus = path.join(spoolBusRoot, 'bus.db')
    openBus(spoolBus).close()
    const trees = freshRoot()
    const tree = path.join(trees, `mc-${ANSWERED_CARD}`)
    mkdirSync(tree, { recursive: true })
    const ts = made.clock.now().toISOString()
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: ANSWERED_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${ANSWERED_CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${ANSWERED_CARD}` }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: ANSWERED_CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${ANSWERED_CARD}`, payload: { session: 'card-session-1', worktree: tree, branch: `feat/card-${ANSWERED_CARD}`, base: HEAD }, legacy: false })
    made.gitHub.open({ number: ANSWERED_PR, head: HEAD, review: 'failure' })
    appendEvent(made.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: ANSWERED_CARD, pr: ANSWERED_PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${ANSWERED_PR}`, payload: { head: HEAD, verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['name the reader'] }, legacy: false })
    made.tick()
    const lease = leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    expect(lease).toMatchObject({ cardId: ANSWERED_CARD, pr: ANSWERED_PR })
    const answerer: Answerer = async (request) => {
      busFilesMode(spoolBusRoot, 0o444)
      gateRecorder(HEAD, HEAD, { kind: 'card', card: ANSWERED_CARD, touches: [], reading: NO_CARD_READING, witnesses: [WITNESS] }, sessionRecord(() => {}, request.card.worktree, spoolBus))({ mode: 'layered', reason: NARROW_WHY, seconds: 2, tests: 1 })
      busFilesMode(spoolBusRoot, 0o644)
      expect(existsSync(path.join(request.card.worktree, ANSWER_TREE_GATE_RUN_SPOOL))).toBe(true)
      return { session: 'card-session-1', resumed: true, before: HEAD, after: HEAD, owner: null }
    }
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: () => `feat/card-${ANSWERED_CARD}`, recreate: () => {}, bringTo: () => {} }
    const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, prepare: () => {}, mergeMain: () => () => ({ kind: 'refused', why: 'no main in this bench' }), changedInTheTree: () => [], localHead: () => HEAD })
    expect(gateRunsOn(made.busPath)).toBe(0)

    await executor.answer(lease).catch(() => null)

    expect(existsSync(path.join(tree, ANSWER_TREE_GATE_RUN_SPOOL))).toBe(false)
    expect(gateRunsOn(made.busPath)).toBe(1)
  })

  it('a file with exactly CENTRAL_REACH readers is not central', () => {
    const atTheLine = 'scripts/core/at-the-line.ts'
    const pastTheLine = 'scripts/core/past-the-line.ts'
    const readers = (file: string, count: number): [string, string[]][] => Array.from({ length: count }, (_, at) => [`scripts/tests/core/${path.basename(file, '.ts')}-${at}.test.ts`, [file]])
    const graph = new Map<string, string[]>([
      [atTheLine, []],
      [pastTheLine, []],
      ...readers(atTheLine, CENTRAL_REACH),
      ...readers(pastTheLine, CENTRAL_REACH + 1),
    ])
    expect(centralFiles([atTheLine, pastTheLine], graph)).toEqual(new Set([pastTheLine]))
  })

  it('a test both sandbox-failing and slow is skipped once', async () => {
    const failing: SandboxFailing[] = [{ file: K1A, test: 'process records > reads the process table [needs ps]', refused: 'spawnSync ps EPERM' }]
    const selection = gateSelection([CENTRAL], GRAPH, card(), () => '', MAP, { failing, slow: SESSION_SLOW_TESTS })
    expect(selection.skipped).toEqual({ sandbox: [K1A], slow: [K3] })
    expect(selection.run.tests).not.toContain(K1A)
    expect(selection.run.tests).not.toContain(K3)

    const lines: string[] = []
    expect(await testStep(selection, suiteOf(lines))).toBe(0)
    expect(lines.filter(line => line.includes(K1A))).toHaveLength(1)
    expect(lines).toContain(`prepush: skipped in this card session, 1 slow test files reached only through a central file; CI runs them: ${K3}`)
  })
})
