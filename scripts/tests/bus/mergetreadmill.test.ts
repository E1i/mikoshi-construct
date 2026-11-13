import type { GitHub } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCatalog, catalogDocumentReads, overlapWithMain, RERUN_VARIABLE, rerunOf, writeCatalog } from '../../cli/check-catalog.js'
import { appendEvent, openBus } from '../../core/db.js'
import { MERGE_DONE, REVIEW_RECORDED, UPDATE_DONE } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { AN_UPDATED_PR_HOLDS_MS, updateCandidates } from '../../core/queue.js'
import { MergeNode } from '../../nodes/merge/merge-worker.js'
import { manualUpdateDone, UpdateExecutor, WAITS_ITS_TURN } from '../../nodes/update/update-executor.js'
import { Meter } from '../../ports/meter.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, MAIN_1, MAIN_2, MAIN_3, REPO, sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const WORKER = 'scripts/nodes/merge/merge-worker.ts'
const CLI = 'src/cli.ts'
const UNREAD_DOCUMENT = 'architecture/a-plan-nobody-tests.md'
const READ_DOCUMENT = 'architecture/a-read-law.md'
const ADDED_TEST = 'tests/an-added-one.test.ts'
const ADDED_BUS_TEST = 'scripts/tests/bus/an-added-one.test.ts'
const BODY = `${cardBody(970)}\n\n■ 4 □ 1 · 1`
const TREE_WALK = ['readdir', 'Sync'].join('')

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

function catalogDb(): MergeBench['db'] {
  const root = mkdtempSync(path.join(tmpdir(), 'treadmill-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function aCatalogOf(db: MergeBench['db'], texts: Record<string, string> = {}): void {
  const graph = new Map<string, string[]>([
    [WORKER, []],
    [CLI, []],
    ['scripts/tests/bus/merge-node.test.ts', [WORKER]],
    ['tests/cli.test.ts', [CLI]],
    ['scripts/tests/bus/helper.ts', [WORKER]],
    ...Object.keys(texts).map(file => [file, []] as [string, string[]]),
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

async function once(node: MergeNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function mergeNodeOf(made: MergeBench): MergeNode {
  return new MergeNode({ silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: { [RERUN_VARIABLE]: 'by-layers' }, rebuildCatalog: () => {} })
}

function answeringContents(made: MergeBench, files: Record<string, string>): GitHub {
  return (endpoint) => {
    const found = /\/contents\/(.+)\?ref=[0-9a-f]{40}$/.exec(endpoint)
    if (found === null)
      return made.gitHub.client(endpoint)
    const text = files[found[1]!]
    return text === undefined
      ? { status: 404, headers: {}, body: { message: 'Not Found' } }
      : { status: 200, headers: {}, body: { content: Buffer.from(text).toString('base64') } }
  }
}

describe('a pull request of documents and the update', () => {
  it('a PR of only documents merges with no update after another merge', async () => {
    const made = benchOfMerges()
    aCatalogOf(made.db)
    afterAnotherMerge(made, [UNREAD_DOCUMENT], [CLI])

    await once(mergeNodeOf(made))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(made.gitHub.puts.map(put => put.endpoint)).toEqual([`${REPO}/pulls/970/merge`])
  })

  it('a document a test names by path still forces the update, on either side', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'tests/law.test.ts': `read('${READ_DOCUMENT}')` })

    expect(overlapWithMain(db, [READ_DOCUMENT], [CLI])).toBe(`${READ_DOCUMENT} is read by tests/law.test.ts`)
    expect(overlapWithMain(db, [WORKER], [READ_DOCUMENT])).toBe(`${READ_DOCUMENT} is read by tests/law.test.ts`)
  })

  it('an entry of the import graph that is no file of the repository is not read for documents', () => {
    const graph = new Map<string, string[]>([['@/format', []], ['tests/cli.test.ts', [CLI]]])
    const read = vi.fn((file: string) => {
      if (file === '@/format')
        throw new Error('ENOENT')
      return ''
    })

    expect(catalogDocumentReads(graph, read)).toEqual([])
    expect(read).toHaveBeenCalledWith('tests/cli.test.ts')
  })

  it('a document named only by its file name in a helper is read', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'scripts/tests/bus/fake.ts': `read(join(root, '..', 'architecture', 'a-read-law.md'))` })

    expect(overlapWithMain(db, [READ_DOCUMENT], [CLI])).toBe(`${READ_DOCUMENT} is read by scripts/tests/bus/fake.ts`)
  })

  it('a test walking a document tree forces the update only when each side changed the walker or a document in it', () => {
    const db = catalogDb()
    aCatalogOf(db, { 'tests/links.test.ts': `${TREE_WALK}(join(ROOT, 'architecture'))` })
    const forced = 'tests/links.test.ts walks architecture, and each side changed the walker or a document in it'

    expect(overlapWithMain(db, [UNREAD_DOCUMENT], [CLI])).toBeNull()
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['docs/guide.md'])).toBeNull()
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['architecture/another-plan.md'])).toBe(forced)
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['tests/links.test.ts'])).toBe(forced)
    expect(overlapWithMain(db, ['tests/links.test.ts'], [UNREAD_DOCUMENT])).toBe(forced)
  })

  it('a file outside architecture and docs stays outside the catalog, and any file under them is in the docs layer', () => {
    const db = catalogDb()
    aCatalogOf(db)

    expect(overlapWithMain(db, ['CONTRIBUTING.md'], [CLI])).toBe('CONTRIBUTING.md belongs to no layer of the check catalog')
    expect(overlapWithMain(db, ['architecture/composition/init.yaml'], [CLI])).toBeNull()
    expect(overlapWithMain(db, [UNREAD_DOCUMENT], ['docs/.vitepress/config.ts'])).toBeNull()
  })

  it('a catalog written before the reads were recorded still puts a document in the docs layer', () => {
    const db = catalogDb()
    aCatalogOf(db)
    db.exec('DROP TABLE check_document_reads')

    expect(overlapWithMain(db, [UNREAD_DOCUMENT], [CLI])).toBeNull()
  })

  it('a document beside code keeps the gate of the code', () => {
    const db = catalogDb()
    aCatalogOf(db)

    expect(overlapWithMain(db, [UNREAD_DOCUMENT, CLI], [CLI])).toBe('main changed the layer src since the base')
  })
})

describe('a test the pull request adds', () => {
  const importing = (...modules: string[]): string => modules.map(module => `import { x } from '${module}'`).join('\n')
  const reading = (texts: Record<string, string>) => (file: string): string | null => texts[file] ?? null

  it('a test the PR adds takes the layers of its imports', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = reading({ [ADDED_TEST]: importing('../scripts/nodes/merge/merge-worker.js') })

    expect(overlapWithMain(db, [ADDED_TEST], [CLI], read)).toBeNull()
    expect(overlapWithMain(db, [ADDED_TEST], [WORKER], read)).toBe('main changed the layer bus:merge since the base')
  })

  it('takes the layers its imports reach through a helper the catalog has not seen', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = reading({ [ADDED_TEST]: importing('./a-new-helper.js'), 'tests/a-new-helper.ts': importing('../scripts/tests/bus/helper.js') })

    expect(overlapWithMain(db, [ADDED_TEST], [WORKER], read)).toBe('main changed the layer bus:merge since the base')
  })

  it('takes the layer of a script it names by path', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = reading({ [ADDED_TEST]: `${importing('../scripts/tests/bus/helper.js')}\nrun(['src/cli.ts'])` })

    expect(overlapWithMain(db, [ADDED_TEST], [CLI], read)).toBe('main changed the layer src since the base')
  })

  it('an added bus test also takes the layers of the shared bus modules', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const read = reading({ [ADDED_BUS_TEST]: importing('./helper.js') })

    expect(overlapWithMain(db, [ADDED_BUS_TEST], ['scripts/core/db.ts'], read)).toMatch(/^main changed the layer /)
  })

  it('stays outside the catalog when its text or an import cannot be read or it scans a tree, and runs itself when it reaches no layer', () => {
    const db = catalogDb()
    aCatalogOf(db)
    const outside = `${ADDED_TEST} belongs to no layer of the check catalog`

    expect(overlapWithMain(db, [ADDED_TEST], [CLI])).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], reading({ [ADDED_TEST]: importing('./gone.js') }))).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], reading({ [ADDED_TEST]: `${TREE_WALK}(join(REPO_ROOT, 'src'))` }))).toBe(outside)
    expect(overlapWithMain(db, [ADDED_TEST], [CLI], reading({ [ADDED_TEST]: `import { it } from 'vitest'` }))).toBeNull()
  })

  it('a test the catalog already holds as reaching no layer is not read', () => {
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
    const gitHub = answeringContents(made, { [ADDED_TEST]: importing('../scripts/nodes/merge/merge-worker.js') })
    const meter = new Meter(gitHub, () => made.clock.now().getTime())

    expect(rerunOf(made.db, meter, 970, MAIN_1, sha('a')).rerun).toBe(false)
    expect(rerunOf(made.db, meter, 970, MAIN_1).rerun).toBe(true)
  })

  it('a contents read GitHub answers with a failure leaves the test outside the catalog', () => {
    const made = benchOfMerges()
    aCatalogOf(made.db)
    afterAnotherMerge(made, [ADDED_TEST], [CLI])
    const meter = new Meter(answeringContents(made, {}), () => made.clock.now().getTime())

    expect(rerunOf(made.db, meter, 970, MAIN_1, sha('a'))).toEqual({ rerun: true, why: `${ADDED_TEST} belongs to no layer of the check catalog` })
  })
})

const FIRST = 950
const SECOND = 951
const FIRST_HEAD = sha('e')
const SECOND_HEAD = sha('f')
const FIRST_UPDATED = sha('d')
const SECOND_UPDATED = sha('c')

function queueBench(firstBody = cardBody(FIRST)) {
  const bench = liveBench()
  benches.push(bench)
  const executor = new UpdateExecutor({ silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
  bench.gitHub.open({ number: FIRST, head: FIRST_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/a.ts'], body: firstBody })
  bench.gitHub.open({ number: SECOND, head: SECOND_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/b.ts'] })
  bench.tick()
  const pull = (pr: number) => bench.gitHub.pulls.get(pr)!
  const candidates = (): (number | undefined)[] => updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)
  const leaseUpdate = () => leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')
  const updateTheNext = (): void => {
    detectUpdate(bench)
    executor.update(leaseUpdate()!)
  }
  const firstUpdated = (): void => {
    bench.gitHub.updatedHead = FIRST_UPDATED
    updateTheNext()
    pull(FIRST).required = 'pending'
    bench.tick()
  }
  return { bench, executor, pull, candidates, leaseUpdate, updateTheNext, firstUpdated }
}

describe('the update turn', () => {
  it('two green PRs needing an update are updated one after the other', () => {
    const { bench, pull, candidates, leaseUpdate, updateTheNext, firstUpdated } = queueBench()
    expect(candidates()).toEqual([FIRST])

    firstUpdated()
    expect(candidates()).toEqual([])
    detectUpdate(bench)
    expect(leaseUpdate()).toBeNull()

    pull(FIRST).required = 'success'
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

  it('the turn is taken as soon as the update is done, before the next look at GitHub', () => {
    const { bench, candidates, updateTheNext } = queueBench()
    bench.gitHub.updatedHead = FIRST_UPDATED
    updateTheNext()

    expect(candidates()).not.toContain(SECOND)
  })

  it('the PR holding the turn is itself updated again when main moves past it once more', () => {
    const { bench, pull, candidates, firstUpdated } = queueBench()
    firstUpdated()
    pull(FIRST).required = 'success'
    pull(FIRST).mergeable_state = 'behind'
    bench.gitHub.main = MAIN_3
    bench.tick()

    expect(candidates()).toEqual([FIRST])
  })

  it('the turn passes on when the updated PR goes red', () => {
    const { bench, pull, candidates, firstUpdated } = queueBench()
    firstUpdated()
    pull(FIRST).required = 'failure'
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('the turn passes on when the updated PR gets a new head', () => {
    const { bench, pull, candidates, firstUpdated } = queueBench()
    firstUpdated()
    pull(FIRST).head = sha('b')
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('the turn passes on when the merge of the updated PR is withdrawn', () => {
    const { bench, pull, candidates, firstUpdated } = queueBench(cardBody(FIRST, 'owner'))
    firstUpdated()
    pull(FIRST).required = 'success'
    bench.tick()
    expect(candidates()).toEqual([])

    bench.merge(bench.lease()!)

    expect(bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'merge' AND pr = ?`).get(FIRST)).toEqual({ state: 'withdrawn' })
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

  it('an update the window records holds no turn', () => {
    const { bench, pull, candidates } = queueBench()
    appendEvent(bench.db, manualUpdateDone({ ts: bench.clock.now().toISOString(), session: 'window', cardId: FIRST + 100, pr: FIRST, from: FIRST_HEAD, to: FIRST_UPDATED }))
    pull(FIRST).head = FIRST_UPDATED
    pull(FIRST).mergeable_state = 'clean'
    pull(FIRST).required = 'pending'
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })

  it('an update already queued before the turn was taken waits, with no failure counted and nothing sent', () => {
    const { bench, executor, pull, leaseUpdate } = queueBench()
    pull(FIRST).required = 'pending'
    bench.tick()
    detectUpdate(bench)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: UPDATE_DONE, actor: 'worker:update:worker-0', cardId: FIRST + 100, pr: FIRST, head: FIRST_HEAD, dedupeKey: `${UPDATE_DONE}:first`, payload: { from: FIRST_HEAD, to: FIRST_UPDATED, carried: 'pass', clean: true, task_key: 'an-earlier-task', lease_gen: 1 }, legacy: false })

    const lease = leaseUpdate()!
    const outcome = executor.update(lease)

    expect(lease.pr).toBe(SECOND)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: WAITS_ITS_TURN }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    expect(taskState(bench.db, lease.taskKey)).toMatchObject({ state: 'queued', failures: 0 })
  })

  it('the turn is not held by a PR merged since', () => {
    const { bench, candidates, firstUpdated } = queueBench()
    firstUpdated()
    bench.gitHub.close(FIRST, true)
    bench.tick()

    expect(candidates()).toEqual([SECOND])
  })
})
