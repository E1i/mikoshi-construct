import type { MergeNodeParts } from '../../nodes/merge/merge-worker.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RERUN_VARIABLE, writeCatalog } from '../../cli/check-catalog.js'
import { appendEvent } from '../../core/db.js'
import { MERGE_DONE, POLICY_DENIED, REVIEW_RECORDED } from '../../core/events.js'
import { NEEDS_UPDATE } from '../../core/queue.js'
import { MergeNode } from '../../nodes/merge/merge-worker.js'
import { UpdateNode } from '../../nodes/update/update-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, MAIN_2, REPO, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const BY_LAYERS = { [RERUN_VARIABLE]: 'by-layers' }
const MERGE_PUT = `${REPO}/pulls/970/merge`
const PR_FILES = ['scripts/nodes/merge/merge-worker.ts', 'scripts/tests/bus/merge-node.test.ts']
const CATALOG = [
  { test: 'scripts/tests/bus/merge-node.test.ts', layer: 'bus-core,bus:merge', kind: 'unit', what: '', witness: '' },
  { test: 'tests/cli.test.ts', layer: 'src', kind: 'unit', what: '', witness: '' },
]
const UPDATED_THEN_MERGED = [`update ${sha('a')}`, `merge ${sha('d')}`]
const MERGED_THE_LEASED_HEAD = [`merge ${sha('a')}`]

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

function onThisHostAfterMainMerged(mainFiles: string[], prFiles = PR_FILES): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  writeCatalog(made.db, { tests: CATALOG, mutations: [] })
  made.gitHub.upToDateRequired = true
  made.gitHub.requiredContexts = []
  made.gitHub.requiredChecks = []
  made.gitHub.main = MAIN_2
  made.gitHub.mainFiles = { [MAIN_2]: mainFiles }
  made.gitHub.open({ number: 970, review: 'success', mergeable_state: 'clean', files: prFiles, body: `${cardBody(970)}\n\n■ 4 □ 1 · 1` })
  made.tick()
  return made
}

async function once(node: MergeNode | UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

async function mergeAndUpdate(made: MergeBench): Promise<string[]> {
  const parts: MergeNodeParts = { silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: BY_LAYERS }
  const merge = new MergeNode(parts)
  const update = new UpdateNode({ silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-2', mode: 'live', env: BY_LAYERS })
  for (let round = 0; round < 2; round += 1) {
    await once(merge)
    await once(update)
    made.tick()
  }
  return made.gitHub.puts.map(each => `${each.endpoint === MERGE_PUT ? 'merge' : 'update'} ${each.fields.sha ?? each.fields.expected_head_sha}`)
}

describe('by layers on a strict main with no required contexts and no required checks', () => {
  it('by layers, a PR on an old base after main merged a change to scripts/ci/layers.ts is updated, not merged', async () => {
    const made = onThisHostAfterMainMerged(['scripts/ci/layers.ts'])

    expect(await mergeAndUpdate(made)).toEqual(UPDATED_THEN_MERGED)
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ command: 'merge', reason: NEEDS_UPDATE, detail: expect.stringContaining('scripts/ci/layers.ts chooses or runs the tests') }))
  })

  it('by layers, a PR on an old base after main merged a change to another layer merges without an update', async () => {
    const made = onThisHostAfterMainMerged(['src/cli.ts', 'tests/cli.test.ts'])

    expect(await mergeAndUpdate(made)).toEqual(MERGED_THE_LEASED_HEAD)
    expect(eventsOf(made.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'auto' })])
  })

  it('by layers, a PR that changes the test infrastructure itself is updated after main moved in another layer', async () => {
    const made = onThisHostAfterMainMerged(['src/cli.ts'], [...PR_FILES, 'vitest.config.ts'])

    expect(await mergeAndUpdate(made)).toEqual(UPDATED_THEN_MERGED)
  })

  it('by layers, a PR on an old base after main merged another layer and its changeset merges without an update', async () => {
    const made = onThisHostAfterMainMerged(['src/cli.ts', '.changeset/answerfault.md'])

    expect(await mergeAndUpdate(made)).toEqual(MERGED_THE_LEASED_HEAD)
  })

  it('by layers, a PR holding only a card changeset merges without an update after main merged another card changeset', async () => {
    const made = onThisHostAfterMainMerged(['.changeset/y.md'], ['.changeset/x.md'])

    expect(await mergeAndUpdate(made)).toEqual(MERGED_THE_LEASED_HEAD)
    expect(eventsOf(made.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'auto' })])
  })
})
