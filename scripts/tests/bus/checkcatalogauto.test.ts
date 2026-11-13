import type { Graph } from '../../ci/layers.js'
import type { GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCatalog, MAIN_TIP, rebuildCatalogAt, RERUN_VARIABLE, rerunOf, writeCatalog } from '../../cli/check-catalog.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, COMMAND_EXECUTED, MERGE_DONE, POLICY_DENIED, REVIEW_RECORDED } from '../../core/events.js'
import { NEEDS_UPDATE } from '../../core/queue.js'
import { CATALOG_REBUILD_FAILED, MergeNode } from '../../nodes/merge/merge-worker.js'
import { UpdateNode } from '../../nodes/update/update-worker.js'
import { Meter } from '../../ports/meter.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, MAIN_1, MAIN_2, REPO, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const WORKER = 'scripts/nodes/merge/merge-worker.ts'
const NEW_TEST = 'scripts/tests/bus/a-new-one.test.ts'
const BODY = `${cardBody(970)}\n\n■ 4 □ 1 · 1`
const MERGE_PUT = `${REPO}/pulls/970/merge`
const BY_LAYERS = { [RERUN_VARIABLE]: 'by-layers' }
const NOT_UP_TO_DATE = 'Head branch is not up to date with the base branch'
const REQUIRED_CHECK = 'Required status check "ci" is expected.'
const TREE_OF_MAIN: Graph = new Map([[WORKER, []], [NEW_TEST, [WORKER]]])

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

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  return made
}

function rebuildFromTheTree(made: MergeBench, refs: string[]): (ref: string) => void {
  return (ref) => {
    refs.push(ref)
    writeCatalog(made.db, buildCatalog({ graph: TREE_OF_MAIN, testText: () => '', cards: [], briefs: [], journal: '' }))
  }
}

interface Wiring {
  rebuildCatalog?: (ref: string) => void
  put?: GitHubPut
  gitHub?: GitHub
  env?: NodeJS.ProcessEnv
}

function nodeOf(made: MergeBench, wiring: Wiring = {}): MergeNode {
  return new MergeNode({ silentMs: SILENT_MS, db: made.db, gitHub: wiring.gitHub ?? made.gitHub.client, put: wiring.put ?? made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: wiring.env ?? {}, rebuildCatalog: wiring.rebuildCatalog })
}

async function once(node: MergeNode | UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function catalogRows(made: MergeBench): Record<string, unknown>[] {
  return made.db.prepare('SELECT test, layer FROM check_tests ORDER BY test').all().map(row => ({ ...row }))
}

function aFullCatalog(made: MergeBench): void {
  writeCatalog(made.db, { tests: [{ test: 'tests/cli.test.ts', layer: 'src', kind: 'unit', what: '', witness: '' }], mutations: [] })
}

function aPullRequestOf(made: MergeBench, files: string[]): void {
  made.gitHub.upToDateRequired = false
  made.gitHub.open({ number: 970, review: 'success', files, body: BODY })
  made.tick()
}

function refusingTheFirstMerge(made: MergeBench, text: string): GitHubPut {
  return (endpoint, fields) => {
    if (endpoint !== MERGE_PUT || fields.sha !== sha('a'))
      return made.gitHub.put(endpoint, fields)
    made.gitHub.puts.push({ endpoint, fields })
    return { status: 405, headers: {}, body: { message: text } }
  }
}

function failuresOfTheFirstHead(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT failures FROM tasks WHERE queue = 'merge' AND head = ?`).get(sha('a')) as { failures: number }).failures)
}

describe('the merge node keeps the check catalog', () => {
  it('a merge with a new test puts its layer in the catalog', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [WORKER, NEW_TEST])
    const refs: string[] = []

    await once(nodeOf(made, { rebuildCatalog: rebuildFromTheTree(made, refs) }))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(refs).toEqual([MAIN_2])
    expect(catalogRows(made)).toEqual([{ test: NEW_TEST, layer: 'bus:merge' }])
  })

  it('a merge of the layer map rebuilds it', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, ['scripts/core/layer-map.json'])
    const refs: string[] = []

    await once(nodeOf(made, { rebuildCatalog: rebuildFromTheTree(made, refs) }))

    expect(refs).toEqual([MAIN_2])
  })

  it('a merge of neither a test nor the layer map leaves the catalog alone', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [WORKER])
    const refs: string[] = []

    await once(nodeOf(made, { rebuildCatalog: rebuildFromTheTree(made, refs) }))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(refs).toEqual([])
  })

  it('an empty catalog rebuilds itself', async () => {
    const made = bench()
    const refs: string[] = []

    await once(nodeOf(made, { rebuildCatalog: rebuildFromTheTree(made, refs) }))

    expect(refs).toEqual([MAIN_TIP])
    expect(catalogRows(made)).toEqual([{ test: NEW_TEST, layer: 'bus:merge' }])

    await once(nodeOf(made, { rebuildCatalog: rebuildFromTheTree(made, refs) }))

    expect(refs).toEqual([MAIN_TIP])
  })

  it('a merge of neither a test nor the layer map rebuilds a catalog the start left empty', async () => {
    const made = bench()
    aPullRequestOf(made, [WORKER])
    const refs: string[] = []

    await once(nodeOf(made, { rebuildCatalog: ref => void refs.push(ref) }))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(refs).toEqual([MAIN_TIP, MAIN_2])
  })

  it('a failed rebuild leaves the catalog as it was, records the failure and does not undo the merge', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [NEW_TEST])
    const before = catalogRows(made)

    await once(nodeOf(made, {
      rebuildCatalog: () => {
        throw new Error('depcruise printed no result')
      },
    }))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(catalogRows(made)).toEqual(before)
    expect(eventsOf(made.db, BOARD_ALARM)).toContainEqual(expect.objectContaining({ reason: CATALOG_REBUILD_FAILED, ref: MAIN_2, detail: 'depcruise printed no result' }))
  })

  it('a listing of the merged files that fails is recorded the same way', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [NEW_TEST])
    const failingAfterTheMerge: GitHub = (endpoint) => {
      if (made.gitHub.pulls.get(970)?.state === 'closed')
        throw new Error('gh api: connection refused')
      return made.gitHub.client(endpoint)
    }

    await once(nodeOf(made, { gitHub: failingAfterTheMerge, rebuildCatalog: () => {} }))

    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(eventsOf(made.db, BOARD_ALARM)).toContainEqual(expect.objectContaining({ reason: CATALOG_REBUILD_FAILED, ref: MAIN_2, detail: expect.stringContaining('connection refused') }))
  })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const WRITES_THE_MARK_OF_ITS_TREE = `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.CONSTRUCT_BUS_DB!, readFileSync('mark.txt', 'utf8'))
`

function commitOf(clone: string, mark: string, script = WRITES_THE_MARK_OF_ITS_TREE): string {
  mkdirSync(path.join(clone, 'scripts', 'cli'), { recursive: true })
  writeFileSync(path.join(clone, 'scripts', 'cli', 'check-catalog.ts'), script)
  writeFileSync(path.join(clone, 'mark.txt'), mark)
  git(clone, 'add', 'scripts', 'mark.txt')
  git(clone, 'commit', '-q', '-m', mark)
  git(clone, 'push', '-q', 'origin', 'HEAD:main')
  return git(clone, 'rev-parse', 'HEAD')
}

function aRepository(): { clone: string, bus: string, origin: string, root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'catalog-rebuild-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const clone = path.join(root, 'clone')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' })
  git(clone, 'checkout', '-q', '-B', 'main')
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(clone, 'node_modules'))
  return { clone, bus: path.join(root, 'marked'), origin, root }
}

describe('rebuildCatalogAt', () => {
  it('runs the check-catalog of the tree at the ref against the bus it is given, and leaves no tree', () => {
    const { clone, bus } = aRepository()
    const atTheMerge = commitOf(clone, 'at the merge')
    commitOf(clone, 'later')

    rebuildCatalogAt(atTheMerge, bus, clone)

    expect(readFileSync(bus, 'utf8')).toBe('at the merge')
    expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('fetches main first, so a merge the worker has not pulled is the one read', () => {
    const { clone, bus, origin, root } = aRepository()
    commitOf(clone, 'old')
    const elsewhere = path.join(root, 'elsewhere')
    execFileSync('git', ['clone', '-q', origin, elsewhere], { stdio: 'ignore' })
    commitOf(elsewhere, 'merged on the host')

    rebuildCatalogAt(MAIN_TIP, bus, clone)

    expect(readFileSync(bus, 'utf8')).toBe('merged on the host')
  })

  it('a tree whose check-catalog fails throws with its output and leaves no tree', () => {
    const { clone, bus } = aRepository()
    const commit = commitOf(clone, 'broken', `console.error('no depcruise here')\nprocess.exit(3)\n`)

    expect(() => rebuildCatalogAt(commit, bus, clone)).toThrow('no depcruise here')
    expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

describe('a merge refused with a 405', () => {
  it('a head GitHub refused as not up to date is re-run, and the head after it is not', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [WORKER])
    const meter = new Meter(made.gitHub.client, () => made.clock.now().getTime())
    const merge = nodeOf(made, { put: refusingTheFirstMerge(made, NOT_UP_TO_DATE), env: BY_LAYERS })
    const update = new UpdateNode({ silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-2', mode: 'live', env: BY_LAYERS })

    expect(rerunOf(made.db, meter, 970, MAIN_1).rerun).toBe(false)

    await once(merge)

    expect(rerunOf(made.db, meter, 970, MAIN_1)).toEqual({ rerun: true, why: 'GitHub refused the merge of this head of #970 as not up to date' })

    await once(update)
    made.tick()
    await once(merge)

    expect(eventsOf(made.db, MERGE_DONE)).toEqual([expect.objectContaining({ task_key: expect.stringContaining(sha('d')) })])
    expect(rerunOf(made.db, meter, 970, MAIN_1).rerun).toBe(false)
  })

  it('a 405 keeps the text of GitHub and not up to date goes to update', async () => {
    const made = bench()
    aFullCatalog(made)
    aPullRequestOf(made, [WORKER])
    const merge = nodeOf(made, { put: refusingTheFirstMerge(made, NOT_UP_TO_DATE), env: BY_LAYERS })
    const update = new UpdateNode({ silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-2', mode: 'live', env: BY_LAYERS })

    for (let round = 0; round < 2; round += 1) {
      await once(merge)
      await once(update)
      made.tick()
    }

    expect(made.gitHub.puts.map(put => `${put.endpoint === MERGE_PUT ? 'merge' : 'update'} ${put.fields.sha ?? put.fields.expected_head_sha}`)).toEqual([`merge ${sha('a')}`, `update ${sha('a')}`, `merge ${sha('d')}`])
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ command: 'merge', reason: NEEDS_UPDATE, detail: expect.stringContaining(NOT_UP_TO_DATE) }))
    expect(eventsOf(made.db, COMMAND_EXECUTED)).toContainEqual(expect.objectContaining({ command: 'merge', ok: false, status: 405, text: NOT_UP_TO_DATE }))
    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    expect(failuresOfTheFirstHead(made)).toBe(0)

    const other = bench()
    aFullCatalog(other)
    aPullRequestOf(other, [WORKER])

    await once(nodeOf(other, { put: refusingTheFirstMerge(other, REQUIRED_CHECK) }))

    expect(eventsOf(other.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ command: 'merge', reason: 'github_error', refused: true, detail: expect.stringContaining(REQUIRED_CHECK) }))
    expect(eventsOf(other.db, COMMAND_EXECUTED)).toContainEqual(expect.objectContaining({ status: 405, text: REQUIRED_CHECK }))
    expect(failuresOfTheFirstHead(other)).toBe(1)
    expect(eventsOf(other.db, MERGE_DONE)).toHaveLength(0)
  })
})
