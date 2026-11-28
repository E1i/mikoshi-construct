import type { TestWeights } from '../../ci/shard.js'
import type { ArtifactDownload } from '../../ci/weights-law.js'
import type { GhResponse, GitHub } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_WEIGHTS_NAME } from '../../ci/file-weights-reporter.js'
import { MAX_DRIFTED_SHARE, RECOMPUTE_COMMAND, RECOMPUTE_DRIFTED_SHARE, recomputedTable, WEIGHTS_PATH } from '../../ci/test-weights.js'
import { driftOfRun } from '../../ci/weights-law.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, MERGE_DONE, OWNER_WAIT_OPENED, REVIEW_RECORDED } from '../../core/events.js'
import { BusWeightsRecompute, WEIGHTS_DRIFT_SOURCE, WEIGHTS_DRIFT_UNREAD } from '../../intake/intake.js'
import { handFile, ShiftCardStarter } from '../../nodes/launch/launch-starter.js'
import { liveMergeRun, MergeNode } from '../../nodes/merge/merge-worker.js'
import { WeightsDriftWatch } from '../../nodes/merge/weights-drift.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { claudeClient } from '../client/claude-client.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const FILES = Array.from({ length: 80 }, (_, at) => `scripts/tests/w/f${String(at).padStart(2, '0')}.test.ts`)
const HEAVY = FILES[0]!
const HEAD = 'c'.repeat(40)
const LATEST_ON_GITHUB = 500
const TABLE: TestWeights = Object.fromEntries(FILES.map(file => [file, 1]))
const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function measuredWith(heavySeconds: number): TestWeights {
  return { ...TABLE, [HEAVY]: heavySeconds }
}

interface TableHistory { change: string, comparedFromHead: string }

const TABLE_CHANGED_AT_HEAD: TableHistory = { change: HEAD, comparedFromHead: 'identical' }

function gitHubAt(table: TestWeights, history: TableHistory = TABLE_CHANGED_AT_HEAD): GitHub {
  return (endpoint): GhResponse => {
    if (endpoint.includes(`/commits?path=${WEIGHTS_PATH}`))
      return { status: 200, headers: {}, body: [{ sha: history.change }] }
    if (endpoint.endsWith(`/compare/${history.change}...${HEAD}`))
      return { status: 200, headers: {}, body: { status: history.comparedFromHead } }
    if (endpoint.includes('/issues?'))
      return { status: 200, headers: {}, body: [{ number: LATEST_ON_GITHUB }] }
    if (endpoint.includes(`/contents/${WEIGHTS_PATH}?ref=${HEAD}`))
      return { status: 200, headers: {}, body: { content: Buffer.from(JSON.stringify(table)).toString('base64') } }
    if (endpoint.includes(`/git/trees/${HEAD}`))
      return { status: 200, headers: {}, body: { tree: [...FILES, WEIGHTS_PATH].map(file => ({ path: file })), truncated: false } }
    return { status: 404, headers: {}, body: null }
  }
}

interface World {
  runs: number[]
  measured: Record<number, TestWeights | null>
  history?: TableHistory
}

function downloadOf(world: World): ArtifactDownload {
  return (run, artifact) => {
    const measured = world.measured[run]
    if (measured === null || measured === undefined)
      return { done: false, reason: `no artifact ${artifact.name} on run ${run}` }
    writeFileSync(path.join(artifact.dir, FILE_WEIGHTS_NAME), JSON.stringify(measured))
    return { done: true }
  }
}

function fixture(world: World): { bench: MergeBench, launchDir: string, watch: () => WeightsDriftWatch } {
  const bench = mergeBench()
  benches.push(bench)
  const launchDir = mkdtempSync(path.join(tmpdir(), 'weights-launch-'))
  roots.push(launchDir)
  const gitHub = gitHubAt(TABLE, world.history)
  const watch = (): WeightsDriftWatch => new WeightsDriftWatch({
    latestRuns: () => ({ kind: 'read', value: world.runs.map(databaseId => ({ databaseId, headSha: HEAD })) }),
    measure: run => driftOfRun(downloadOf(world), gitHub, run),
    ledger: new BusWeightsRecompute({ db: bench.db, gitHub, hand: (cardId, file, text) => handFile(launchDir, cardId, file, text), clock: bench.clock.now }),
  })
  return { bench, launchDir, watch }
}

function admitted(bench: MergeBench): Record<string, unknown>[] {
  return eventsOf(bench.db, CARD_ADMITTED).filter(payload => payload.source === WEIGHTS_DRIFT_SOURCE)
}

describe('the drift of a green main run admits one recompute card (D-600)', () => {
  it('the law has its own line, apart from the freshness threshold', () => {
    expect(RECOMPUTE_DRIFTED_SHARE).toBe(0.3)
    expect(MAX_DRIFTED_SHARE).toBe(0.05)
  })

  it('a run drifting above 0.30 of the longest shard admits exactly one S card, once per run id', () => {
    const { bench, watch } = fixture({ runs: [7001], measured: { 7001: measuredWith(5) } })
    const first = watch().watch()
    expect(first).toMatchObject({ kind: 'admitted', run: 7001, card: LATEST_ON_GITHUB + 1 })
    expect(watch().watch()).toEqual({ kind: 'seen', run: 7001 })
    const cards = admitted(bench)
    expect(cards).toHaveLength(1)
    bench.tick()
    const text = cardBodyText(bench.db, LATEST_ON_GITHUB + 1)!
    expect(text).toContain('[implement/construct/S/cheap/auto]')
    expect(text).toContain(`touches: ${WEIGHTS_PATH}\n`)
    expect(text).toContain('who: shift')
    expect(text).toContain('priority: p1')
    expect(text).toContain('CI run 7001')
    expect(text).toContain('35.7%')
    expect(text).toContain('5.0 s')
  })

  it('a run at or below 0.30 admits nothing, though it is past the 0.05 freshness line', () => {
    const { bench, watch } = fixture({ runs: [7002], measured: { 7002: measuredWith(2.5) } })
    const outcome = watch().watch()
    expect(outcome.kind).toBe('fresh')
    expect(outcome.kind === 'fresh' && outcome.share > MAX_DRIFTED_SHARE && outcome.share <= RECOMPUTE_DRIFTED_SHARE).toBe(true)
    expect(admitted(bench)).toEqual([])
  })

  it('a run with no artifact admits nothing and records why', () => {
    const { bench, watch } = fixture({ runs: [7003], measured: { 7003: null } })
    expect(watch().watch()).toMatchObject({ kind: 'unread', run: 7003 })
    expect(admitted(bench)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM).map(payload => payload.reason)).toContain(WEIGHTS_DRIFT_UNREAD)
    expect(watch().watch()).toEqual({ kind: 'seen', run: 7003 })
  })

  it('a later stale run admits nothing while the recompute card is admitted and unmerged', () => {
    const world: World = { runs: [7004], measured: { 7004: measuredWith(5), 7005: measuredWith(6) } }
    const { bench, watch } = fixture(world)
    expect(watch().watch().kind).toBe('admitted')
    bench.tick()
    world.runs = [7005]
    expect(watch().watch()).toEqual({ kind: 'held', run: 7005, card: LATEST_ON_GITHUB + 1 })
    expect(admitted(bench)).toHaveLength(1)
  })

  it('a run older than the last change of the weights table admits nothing', () => {
    const recompute = 'd'.repeat(40)
    const { bench, watch } = fixture({ runs: [7009], measured: { 7009: measuredWith(5) }, history: { change: recompute, comparedFromHead: 'behind' } })
    const node = watch()
    expect(node.watch()).toEqual({ kind: 'superseded', run: 7009, change: recompute })
    expect(admitted(bench)).toEqual([])
    expect(node.watch()).toEqual({ kind: 'seen', run: 7009 })
    expect(watch().watch()).toEqual({ kind: 'superseded', run: 7009, change: recompute })
    expect(admitted(bench)).toEqual([])
  })

  it('a run whose head is after the last change of the weights table is measured and admits', () => {
    const { bench, watch } = fixture({ runs: [7010], measured: { 7010: measuredWith(5) }, history: { change: 'e'.repeat(40), comparedFromHead: 'ahead' } })
    expect(watch().watch()).toMatchObject({ kind: 'admitted', run: 7010 })
    expect(admitted(bench)).toHaveLength(1)
  })

  it('a last change that cannot be read admits nothing and records why', () => {
    const { bench, watch } = fixture({ runs: [7011], measured: { 7011: measuredWith(5) }, history: { change: 'f'.repeat(40), comparedFromHead: '' } })
    expect(watch().watch()).toMatchObject({ kind: 'unread', run: 7011 })
    expect(admitted(bench)).toEqual([])
  })
})

interface StarterView { table: string | null, prompt: string }

function starterOf(bench: MergeBench, launchDir: string, worktree: string, changed: string[], seen: StarterView): ShiftCardStarter {
  return new ShiftCardStarter({ launchDir, claude: 'client-binary', treePr: 'true' }, {
    client: claudeClient,
    read: id => cardBodyText(bench.db, id),
    cut: () => {
      mkdirSync(worktree, { recursive: true })
      return worktree
    },
    base: () => 'b'.repeat(40),
    freshen: () => ({ kind: 'fresh', base: 'b'.repeat(40) }),
    spawnDetached: () => {
      const file = path.join(worktree, WEIGHTS_PATH)
      seen.table = existsSync(file) ? readFileSync(file, 'utf8') : null
      return 4242
    },
    pgidOf: pid => pid,
    kill: () => {},
    uuid: () => 'sess-weights',
    envOf: () => ({}),
    prompt: (task) => {
      seen.prompt = task.body
      return task.body
    },
    changedPaths: () => changed,
    readReport: () => null,
    cardSessions: () => [],
    readTranscript: () => null,
    treeFile: () => null,
  })
}

function admittedCard(world: World): { bench: MergeBench, launchDir: string, cardId: number, worktree: string } {
  const { bench, launchDir, watch } = fixture(world)
  const outcome = watch().watch()
  expect(outcome.kind).toBe('admitted')
  bench.tick()
  const worktree = mkdtempSync(path.join(tmpdir(), 'weights-tree-'))
  roots.push(worktree)
  return { bench, launchDir, cardId: outcome.kind === 'admitted' ? outcome.card : 0, worktree }
}

describe('the recompute card passes without an owner wait (owner s692)', () => {
  it('recompute card passes without an owner wait', () => {
    const measured = measuredWith(5)
    const { bench, launchDir, cardId, worktree } = admittedCard({ runs: [7006], measured: { 7006: measured } })
    const seen: StarterView = { table: null, prompt: '' }
    expect(starterOf(bench, launchDir, worktree, [], seen).start({ cardId, lane: 'lane-1' }).kind).toBe('started')
    expect(seen.table).toBe(recomputedTable(TABLE, measured, () => true).text)
    expect(seen.prompt).not.toContain('test:weights')
    expect(seen.prompt).not.toContain(RECOMPUTE_COMMAND)
    expect(seen.prompt).toContain('needs no network')
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a held recompute tree whose only change is the handed table is continued, not refused as an unnamed change', () => {
    const { bench, launchDir, cardId, worktree } = admittedCard({ runs: [7007], measured: { 7007: measuredWith(5) } })
    const seen: StarterView = { table: null, prompt: '' }
    const relaunched = starterOf(bench, launchDir, worktree, [WEIGHTS_PATH], seen).start({ cardId, lane: 'lane-1', continueIn: { worktree, base: 'b'.repeat(40) } })
    expect(relaunched.kind).toBe('started')
    const foreign = starterOf(bench, launchDir, worktree, [WEIGHTS_PATH, 'scripts/ci/shard.ts'], seen).start({ cardId, lane: 'lane-1', continueIn: { worktree, base: 'b'.repeat(40) } })
    expect(foreign).toMatchObject({ kind: 'refused', denial: { paths: ['scripts/ci/shard.ts'] } })
  })
})

describe('the merge node watches the weights after main advances (D-600)', () => {
  it('a merge the node makes measures the latest green main run and admits the recompute card', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { bench, watch } = fixture({ runs: [7008], measured: { 7008: measuredWith(5) } })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    bench.gitHub.upToDateRequired = false
    bench.gitHub.open({ number: 970, review: 'success', files: ['scripts/nodes/merge/merge-worker.ts'], body: `${cardBody(970)}\n\n■ 4 □ 1 · 1` })
    bench.tick()
    const node = new MergeNode({ silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, session: 'node-1', run: null, mode: 'live', env: {}, weights: watch() })
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    expect(eventsOf(bench.db, MERGE_DONE)).toHaveLength(1)
    expect(admitted(bench)).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('the live merge worker is wired with the weights watch', () => {
    const { bench } = fixture({ runs: [], measured: {} })
    const weights = liveMergeRun(bench.busPath, bench.busPath).weights
    expect(weights).toBeTypeOf('function')
    expect(weights!(bench.db)).toBeInstanceOf(WeightsDriftWatch)
  })
})
