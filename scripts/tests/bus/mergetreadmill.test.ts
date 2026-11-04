import type { GitHub } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCatalog, overlapWithMain, rerunOf, writeCatalog } from '../../cli/check-catalog.js'
import { appendEvent } from '../../core/db.js'
import { MERGE_DONE, REVIEW_RECORDED, UPDATE_DONE } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { AN_UPDATED_PR_HOLDS_MS, updateCandidates } from '../../core/queue.js'
import { openDatabase } from '../../core/sqlite.js'
import { MergeExecutor } from '../../nodes/merge/merge-executor.js'
import { manualUpdateDone, UpdateExecutor, WAITS_ITS_TURN } from '../../nodes/update/update-executor.js'
import { Meter } from '../../ports/meter.js'
import { cardBody, MAIN_1, MAIN_2, MAIN_3, REPO, sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const WORKER = 'scripts/nodes/merge/merge-worker.ts'
const CLI = 'src/cli.ts'
const UNREAD_DOCUMENT = 'architecture/a-plan-nobody-tests.md'
const READ_DOCUMENT = 'architecture/a-read-law.md'
const ADDED_TEST = 'tests/an-added-one.test.ts'
const ADDED_BUS_TEST = 'scripts/tests/bus/an-added-one.test.ts'
const BODY = `${cardBody(970)}\n\n■ 4 □ 1 · 1`

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function catalogDb(): ReturnType<typeof openDatabase> {
  const root = mkdtempSync(path.join(tmpdir(), 'treadmill-'))
  roots.push(root)
  return openDatabase(path.join(root, 'bus.db'))
}

function aCatalogOf(db: Parameters<typeof writeCatalog>[0], texts: Record<string, string> = {}): void {
  const graph = new Map<string, string[]>([
    [WORKER, []],
    [CLI, []],
    ['scripts/tests/bus/merge-node.test.ts', [WORKER]],
    ['tests/cli.test.ts', [CLI]],
    ['scripts/tests/bus/helper.ts', [WORKER]],
    ...Object.keys(texts).filter(file => !(file === WORKER || file === CLI)).map(file => [file, []] as [string, string[]]),
  ])
  writeCatalog(db, buildCatalog({ graph, testText: file => texts[file] ?? '', cards: [], briefs: [], journal: '' }))
}

function benchOfMerges(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  made.gitHub.upToDateRequired = false
  return made
}

function afterAnotherMerge(made: MergeBench, files: string[], mainFiles: string[]): void {
  made.gitHub.mainFiles = { [MAIN_2]: mainFiles }
  made.gitHub.main = MAIN_2
  made.gitHub.open({ number: 970, review: 'success', mergeable_state: 'behind', files, body: BODY })
  made.tick()
}

function mergedByLayers(made: MergeBench, gitHub: GitHub = made.gitHub.client): ReturnType<MergeExecutor['merge']> {
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'merge', 'worker:merge:worker-1')
  if (lease !== null)
    return new MergeExecutor({ db: made.db, gitHub, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, run: null, rerun: 'by-layers' }).merge(lease)
  throw new Error('no merge was leased')
}

function contentsAnswering(made: MergeBench, files: Record<string, string>): GitHub {
  return (endpoint) => {
    const found = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(endpoint)
    if (found === null || !(found[1]! in files))
      return made.gitHub.client(endpoint)
    return { status: 200, headers: {}, body: { content: Buffer.from(files[found[1]!]!).toString('base64') } }
  }
}

describe('a pull request of documents and the update', () => {
  it('a PR of only documents merges with no update after another merge', () => {
    const made = benchOfMerges()
    aCatalogOf(made.db)
    afterAnotherMerge(made, [UNREAD_DOCUMENT], [CLI])
    detectQueued(made)

    const outcome = mergedByLayers(made)

    expect(outcome).toMatchObject({ kind: 'merged' })
    expect(made.gitHub.puts.map(put => put.endpoint)).toEqual([`${REPO}/pulls/970/merge`])
  })

  it('a document a test names by path still forces the update, on either side', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'tests/law.test.ts': `readFileSync('${READ_DOCUMENT}')` })

    expect(overlapWithMain(db, [READ_DOCUMENT], [CLI])).toBe(`${READ_DOCUMENT} is read by tests/law.test.ts`)
    expect(overlapWithMain(db, [WORKER], [READ_DOCUMENT])).toBe(`${READ_DOCUMENT} is read by tests/law.test.ts`)
  })

  it('a document named only by its file name, or reached through a helper a test imports, is read', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'scripts/tests/bus/fake.ts': `readFileSync(path.join(root, '..', 'architecture', 'a-read-law.md'))` })

    expect(overlapWithMain(db, [READ_DOCUMENT], [CLI])).toBe(`${READ_DOCUMENT} is read by scripts/tests/bus/fake.ts`)
  })

  it('a test walking a document tree forces the update only when both sides changed a document in it', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'tests/links.test.ts': `readdirSync(path.join(ROOT, 'architecture'))` })

    expect(overlapWithMain(db, [UNREAD_DOCUMENT], [CLI])).toBeNull()
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['architecture/another-plan.md'])).toBe('tests/links.test.ts walks architecture, and both sides changed a document in it')
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['docs/guide.md'])).toBeNull()
  })

  it('a file that is neither under architecture and docs nor markdown stays outside the catalog', () => {
    const db = catalogDb()
    aCatalogOf(db)

    expect(overlapWithMain(db, ['README.md'], [CLI])).toBe('README.md belongs to no layer of the check catalog')
    expect(overlapWithMain(db, ['architecture/composition/init.yaml'], [CLI])).toBe('architecture/composition/init.yaml belongs to no layer of the check catalog')
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['docs/.vitepress/config.ts'])).toBe('docs/.vitepress/config.ts belongs to no layer of the check catalog')
  })

  it('a catalog written before the reads were recorded keeps every document outside it', () => {
    const db = catalogDb()
    aCatalogOf(db)
    db.exec('DROP TABLE check_document_reads')

    expect(overlapWithMain(db, [UNREAD_DOCUMENT], [CLI])).toBe(`${UNREAD_DOCUMENT} belongs to no layer of the check catalog`)
  })

  it('a document beside code keeps the code gate: the layer of the code still overlaps', () => {
    const db = catalogDb()
    aCatalogOf(db)

    expect(overlapWithMain(db, [UNREAD_DOCUMENT, CLI], [CLI])).toBe('main changed the layer src since the base')
  })
})

function detectQueued(made: MergeBench): void {
  detectMergeTask(made)
}

function detectMergeTask(made: MergeBench): void {
  const key = taskKey({ queue: 'merge', cardId: 1070, pr: 970, head: sha('a') })
  if (made.db.prepare('SELECT 1 FROM tasks WHERE task_key LIKE ?').get(`${key}%`) === undefined)
    queueMerge(made)
}

function queueMerge(made: MergeBench): void {
  const db = made.db
  const ts = made.clock.now().toISOString()
  for (const task of mergeTasks(made))
    queueTaskOf(db, ts, task)
}

describe('a test the pull request adds', () => {
  const importing = (...modules: string[]): string => modules.map(module => `import { x } from '${module}'`).join('\n')

  it('a test the PR adds takes the layers of its imports', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const texts: Record<string, string> = { [ADDED_TEST]: importing('../scripts/nodes/merge/merge-worker.js') }
    const read = (file: string): string | null => texts[file] ?? null

    expect(overlapWithMain(db, [ADDED_TEST], [CLI], read)).toBeNull()
    expect(overlapWithMain(db, [ADDED_TEST], [WORKER], read)).toBe('main changed the layer bus:merge since the base')
  })

  it('takes the layers its imports reach, through a helper and through a module the catalog has not seen', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const texts: Record<string, string> = {
      [ADDED_TEST]: importing('./a-new-helper.js'),
      'tests/a-new-helper.ts': importing('../scripts/tests/bus/helper.js'),
    }
    const read = (file: string): string | null => texts[file] ?? null

    expect(overlapWithMain(db, [ADDED_TEST, 'scripts/nodes/merge/merge-worker.ts'], [CLI], read)).toBeNull()
    expect(overlapWithMain(db, [ADDED_TEST], [WORKER], read)).toBe('main changed the layer bus:merge since the base')
  })

  it('takes the layer of a script it names by path, as the catalog does for one it spawns', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = (file: string): string | null => file === ADDED_TEST ? `${importing('../scripts/tests/bus/helper.js')}\nexecFileSync(tsx, ['src/cli.ts'])` : null

    expect(overlapWithMain(db, [ADDED_TEST], [CLI], read)).toBe('main changed the layer src since the base')
  })

  it('an added bus test takes the layers of the shared bus modules, as the selector runs every bus test for them', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = (file: string): string | null => file === ADDED_BUS_TEST ? importing('./helper.js') : null

    expect(overlapWithMain(db, [ADDED_BUS_TEST], ['scripts/core/db.ts'], read)).toBe('main changed the layer bus-core since the base')
  })

  it('stays outside the catalog when its text cannot be read, an import cannot be read, it scans a tree or it reaches no layer', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const outside = `${ADDED_TEST} belongs to no layer of the check catalog`

    expect(overlapWithMain(db, [ADDED_TEST], [CLI])).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], file => file === ADDED_TEST ? importing('./gone.js') : null)).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], () => `readdirSync(path.join(REPO_ROOT, 'src'))`)).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], () => `import { it } from 'vitest'`)).toBe(outside)
  })

  it('a test the catalog already places as reaching no layer is not read again', () => {
    const db = catalogDb()
    writeCatalog(db, { tests: [{ test: 'tests/orphan.test.ts', layer: 'none', kind: 'unit', what: '', witness: '' }, { test: 'tests/cli.test.ts', layer: 'src', kind: 'unit', what: '', witness: '' }], mutations: [], modules: [{ module: WORKER, layers: ['bus:merge'] }] })
    const read = vi.fn(() => importing('../scripts/nodes/merge/merge-worker.js'))

    expect(overlapWithMain(db, ['tests/orphan.test.ts'], [CLI], read)).toBe('tests/orphan.test.ts belongs to no layer of the check catalog')
    expect(read).not.toHaveBeenCalled()
  })

  it('rerunOf reads the added test at the head of the pull request', () => {
    const made = benchOfMerges()
    aCatalogOf(made.db)
    afterAnotherMerge(made, [ADDED_TEST], [CLI])
    const gitHub = contentsAnswering(made, { [ADDED_TEST]: importing('../scripts/nodes/merge/merge-worker.js') })
    const meter = new Meter(gitHub, () => made.clock.now().getTime())

    expect(rerunOf(made.db, meter, 970, MAIN_1, sha('a')).rerun).toBe(false)
    expect(rerunOf(made.db, meter, 970, MAIN_1).rerun).toBe(true)
  })
})

const FIRST = 950
const SECOND = 951
const FIRST_HEAD = sha('e')
const SECOND_HEAD = sha('f')
const FIRST_UPDATED = sha('d')
const SECOND_UPDATED = sha('c')

function queueBench() {
  const bench = liveBench()
  benches.push(bench)
  const executor = new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
  bench.gitHub.open({ number: FIRST, head: FIRST_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/a.ts'] })
  bench.gitHub.open({ number: SECOND, head: SECOND_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/b.ts'] })
  bench.tick()
  const candidates = (): (number | undefined)[] => updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)
  const updateTheNext = (): void => {
    detectUpdate(bench)
    executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)
  }
  const firstUpdated = (): void => {
    bench.gitHub.updatedHead = FIRST_UPDATED
    updateTheNext()
    bench.gitHub.pulls.get(FIRST)!.required = 'pending'
    bench.tick()
  }
  return { bench, executor, candidates, updateTheNext, firstUpdated }
}

describe('the update turn', () => {
  it('two green PRs needing an update are updated one after the other', () => {
    const { bench, candidates, updateTheNext, firstUpdated } = queueBench()
    expect(candidates()).toEqual([FIRST])

    firstUpdated()
    expect(candidates()).toEqual([])
    detectUpdate(bench)
    expect(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')).toBeNull()

    bench.gitHub.pulls.get(FIRST)!.required = 'success'
    bench.tick()
    expect(candidates()).toEqual([])

    bench.gitHub.close(FIRST, true)
    bench.gitHub.main = MAIN_2
    bench.tick()
    expect(candidates()).toEqual([SECOND])

    bench.gitHub.updatedHead = SECOND_UPDATED
    updateTheNext()
    expect(eventsOf(bench.db, UPDATE_DONE).map(done => done.to)).toEqual([FIRST_UPDATED, SECOND_UPDATED])
  })

  it('the PR holding the turn is itself updated again when main moves past it once more', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.gitHub.pulls.get(FIRST)!.required = 'success'
    bench.gitHub.pulls.get(FIRST)!.mergeable_state = 'behind'
    bench.gitHub.main = MAIN_3
    bench.tick()

    expect(candidates()).toEqual([FIRST])
  })

  it('the turn passes on when the updated PR goes red', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.gitHub.pulls.get(FIRST)!.required = 'failure'
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('the turn passes on when the updated PR is parked by the owner\'s authority', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.gitHub.pulls.get(FIRST)!.required = 'success'
    bench.tick()
    const lease = bench.lease()!
    expect(lease.pr).toBe(FIRST)
    bench.merge(lease)
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('the turn passes on after the hold runs out, so a head CI never settles does not stop the queue', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.clock.advance(AN_UPDATED_PR_HOLDS_MS + 1)

    expect(candidates()).toEqual([SECOND])
  })

  it('a conflicting PR is still taken while the turn is held', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.gitHub.open({ number: 952, head: sha('b'), mergeable_state: 'dirty' })
    bench.tick()

    expect(candidates()).toEqual([952])
  })

  it('a manual update the window records holds no turn', () => {
    const { bench, candidates } = queueBench()
    appendEvent(bench.db, manualUpdateDone({ ts: bench.clock.now().toISOString(), session: 'window', cardId: FIRST + 100, pr: FIRST, from: FIRST_HEAD, to: FIRST_UPDATED }))
    bench.gitHub.pulls.get(FIRST)!.head = FIRST_UPDATED
    bench.gitHub.pulls.get(FIRST)!.mergeable_state = 'clean'
    bench.gitHub.pulls.get(FIRST)!.required = 'pending'
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('an update already queued before the turn was taken waits, with no failure counted and nothing sent', () => {
    const { bench, executor, firstUpdated } = queueBench()
    detectUpdate(bench)
    const queued = taskKey({ queue: 'update', cardId: SECOND + 100, pr: SECOND, head: SECOND_HEAD })
    bench.db.prepare(`UPDATE tasks SET task_key = task_key WHERE task_key = ?`).run(queued)
    firstUpdated()
    bench.gitHub.puts.length = 0
    enqueueDirectly(bench, SECOND, SECOND_HEAD)

    const outcome = executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: WAITS_ITS_TURN }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
  })

  it('the turn is not held by an update of a PR merged since', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId: FIRST + 100, pr: FIRST, head: FIRST_UPDATED, dedupeKey: `${MERGE_DONE}:${FIRST}`, payload: { commit: MAIN_2, rule: 'auto' }, legacy: false })
    bench.gitHub.close(FIRST, true)
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })
})
