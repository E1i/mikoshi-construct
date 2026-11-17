import type { GitHubPut } from '../../../ports/github.js'
import type { MergeBench } from '../merge-bench.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../../src/card/text-sha.js'
import { appendEvent } from '../../../core/db.js'
import { readDeclarations } from '../../../core/declarations.js'
import { CARD_ADMITTED, OWNER_WAIT_OPENED, POLICY_DENIED, PR_GROUPS, REVIEW_RECORDED } from '../../../core/events.js'
import { answerCandidates } from '../../../nodes/answer/answer-candidates.js'
import { MergeNode } from '../../../nodes/merge/merge-worker.js'
import { updateCandidates } from '../../../nodes/update/update-candidates.js'
import { UpdateNode } from '../../../nodes/update/update-worker.js'
import { recordDecision } from '../../../policy/decisions/index.js'
import { mainMergeInCardTree } from '../../../ports/main-merge.js'
import { answerParts, candidateRules } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { dispatchRequest } from '../../../window/requests/index.js'
import { cardBody, REPO, sha } from '../github-fake.js'
import { eventsOf, mergeBench } from '../merge-bench.js'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const MODULE_FILES = 'contract/module-files.json'
const COUNT_LINE = '■ 4 □ 1 · 1'
const MAIN_STEPS = ['2', '3', '4', '5', '6', '7', '8', '9'].map(sha)

interface Conveyor {
  bench: MergeBench
  merge: MergeNode
  update: UpdateNode
  followMain: () => void
}

interface ConveyorOptions {
  mainFollowsMerges?: boolean
  mergeMainIn?: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function unlistedPath(): string {
  return `o3-${randomUUID()}/${randomUUID()}.cfg`
}

function advanceMain(bench: MergeBench, files: readonly string[]): void {
  const next = MAIN_STEPS.find(step => !(step in bench.gitHub.mainFiles))!
  bench.gitHub.mainFiles[next] = [...files]
  bench.gitHub.main = next
}

function followerOf(bench: MergeBench): () => void {
  const followed = new Set<number>()
  return () => {
    for (const pull of bench.gitHub.pulls.values()) {
      if (pull.merged === true && !followed.has(pull.number)) {
        followed.add(pull.number)
        advanceMain(bench, pull.files ?? [])
      }
    }
  }
}

function conveyor(options: ConveyorOptions = {}): Conveyor {
  const bench = mergeBench()
  benches.push(bench)
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1, pr: 1, head: sha('f'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('f'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  recordDecision(bench.db, { ts, decisionId: 1, text: '[owner] allow-live merge', cards: [] })
  const followMain = followerOf(bench)
  const put: GitHubPut = (endpoint, fields) => {
    const response = bench.gitHub.put(endpoint, fields)
    if (options.mainFollowsMerges !== false)
      followMain()
    return response
  }
  const common = { silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, clock: bench.clock.now, mode: 'live' as const, env: {} }
  const merge = new MergeNode({ ...common, put, session: 'merge-1', run: null })
  const mergeMain = options.mergeMainIn === undefined ? undefined : mainMergeInCardTree(git, () => options.mergeMainIn!)
  const update = new UpdateNode({ ...common, put: bench.gitHub.put, session: 'update-1', settle: () => {}, mergeMain })
  return { bench, merge, update, followMain }
}

function open(bench: MergeBench, pr: number, files: string[], head = sha('a')): void {
  bench.gitHub.open({ number: pr, head, review: 'success', files, body: `${cardBody(pr)}\n\n${COUNT_LINE}` })
}

async function once(node: MergeNode | UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

async function passes(node: MergeNode | UpdateNode, count: number): Promise<void> {
  for (let pass = 0; pass < count; pass += 1)
    await once(node)
}

async function rounds(line: Conveyor, count: number): Promise<void> {
  for (let round = 0; round < count; round += 1) {
    await once(line.merge)
    await once(line.update)
    line.bench.tick()
  }
}

function merged(bench: MergeBench): number[] {
  return [...bench.gitHub.pulls.values()].filter(pull => pull.merged === true).map(pull => pull.number).sort((a, b) => a - b)
}

function mergedHeads(bench: MergeBench): Record<number, string> {
  return Object.fromEntries(bench.gitHub.puts.flatMap((put) => {
    const pr = /\/pulls\/(\d+)\/merge$/.exec(put.endpoint)?.[1]
    return pr === undefined ? [] : [[Number(pr), put.fields.sha]]
  }))
}

function updatesOf(bench: MergeBench, pr?: number): number {
  const row = bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'update' AND (? IS NULL OR pr = ?)`).get(pr ?? null, pr ?? null) as { n: number }
  return Number(row.n)
}

function updatePuts(bench: MergeBench, pr: number): number {
  return bench.gitHub.puts.filter(put => put.endpoint === `${REPO}/pulls/${pr}/update-branch`).length
}

function mergeDenialsByHead(bench: MergeBench): number[] {
  const rows = bench.db.prepare(`SELECT pr, head, count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.command') = 'merge' AND json_extract(payload, '$.reason') = 'needs_update' GROUP BY pr, head`).all(POLICY_DENIED) as { n: number }[]
  return rows.map(row => Number(row.n))
}

function latestGroups(bench: MergeBench): { prs: number[], turn: number | null }[] {
  return (eventsOf(bench.db, PR_GROUPS).at(-1)?.groups ?? []) as { prs: number[], turn: number | null }[]
}

describe('conveyor O3: update and merge act on the turn of each group', () => {
  it('scenario 01: two pass+green PRs with disjoint paths both merge after main moves with a file neither changed, a derived registry both share and a generated path no layer names, with no update', async () => {
    const line = conveyor()
    const { bench } = line
    open(bench, 1601, ['docs/guide/o3-one.md', MODULE_FILES])
    open(bench, 1602, ['docs/guide/o3-two.md', MODULE_FILES])
    bench.tick()
    advanceMain(bench, ['eslint.config.mjs', MODULE_FILES])
    bench.tick()
    advanceMain(bench, [unlistedPath()])
    bench.tick()

    await rounds(line, 3)

    expect(merged(bench)).toEqual([1601, 1602])
    expect(updatesOf(bench)).toBe(0)
    expect(mergeDenialsByHead(bench).every(count => count <= 1)).toBe(true)
  })

  it('scenario 02: when the turn holder is hand-merged, the next member\'s update runs in the same tick and its PR merges, with no update attempted against the closed PR', async () => {
    const line = conveyor()
    const { bench } = line
    const shared = 'docs/guide/o3-shared.md'
    open(bench, 1701, [shared, 'docs/guide/o3-a-only.md'])
    open(bench, 1702, [shared, 'docs/guide/o3-b-only.md'])
    bench.tick()
    advanceMain(bench, ['docs/guide/o3-b-only.md'])
    bench.tick()
    expect(latestGroups(bench)).toEqual([expect.objectContaining({ prs: [1701, 1702], turn: 1701 })])
    await once(line.update)
    expect(updatePuts(bench, 1702)).toBe(0)

    bench.gitHub.close(1701, true)
    line.followMain()
    bench.tick()
    await once(line.update)

    expect(updatePuts(bench, 1702)).toBe(1)
    await rounds(line, 3)
    expect(merged(bench)).toEqual([1701, 1702])
    expect(mergedHeads(bench)).toEqual({ 1702: sha('d') })
    expect(updatesOf(bench, 1701)).toBe(0)
    expect(updatePuts(bench, 1701)).toBe(0)
  })

  it('scenario 10: three independent cards, two of one module adding different files under its pattern, merge in the same pass with no update caused by each other', async () => {
    const line = conveyor()
    const { bench } = line
    const files: Record<number, string[]> = {
      1001: ['docs/guide/o3-first-new-page.md', MODULE_FILES],
      1002: ['docs/guide/o3-second-new-page.md', MODULE_FILES],
      1003: ['templates/base/o3-new-template.md'],
    }
    for (const [pr, changed] of Object.entries(files))
      open(bench, Number(pr), changed)
    bench.tick()
    expect(latestGroups(bench)).toEqual([
      expect.objectContaining({ prs: [1001], turn: 1001 }),
      expect.objectContaining({ prs: [1002], turn: 1002 }),
      expect.objectContaining({ prs: [1003], turn: 1003 }),
    ])

    await passes(line.merge, 3)

    expect(merged(bench)).toEqual([1001, 1002, 1003])
    expect(updatesOf(bench)).toBe(0)
    expect(Object.values(files).flat().filter(file => file.startsWith('declarations/'))).toEqual([])
  })

  it('scenario 11: B, sharing a file with merged A, is refused at its merge lease by the check before merge, its update is queued in the same tick, it is updated once and merged; C merges with no update', async () => {
    const line = conveyor({ mainFollowsMerges: false })
    const { bench } = line
    const same = 'docs/guide/o3-same.md'
    open(bench, 1101, [same])
    open(bench, 1102, [same, 'docs/guide/o3-b.md'])
    open(bench, 1103, ['docs/guide/o3-other.md'])
    bench.tick()

    await passes(line.merge, 2)
    expect(merged(bench)).toEqual([1101, 1103])
    bench.tick()
    line.followMain()
    await once(line.merge)

    expect(merged(bench)).toEqual([1101, 1103])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([expect.objectContaining({ command: 'merge', reason: 'needs_update', detail: expect.stringContaining(same) })])
    expect(updateCandidates(bench.db, bench.clock.now().toISOString(), candidateRules()).map(task => task.pr)).toEqual([1102])
    expect(bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'update' AND pr = 1102`).all()).toEqual([])

    await once(line.update)
    expect(updatePuts(bench, 1102)).toBe(1)
    bench.tick()
    await rounds(line, 2)

    expect(merged(bench)).toEqual([1101, 1102, 1103])
    expect(mergedHeads(bench)).toEqual({ 1101: sha('a'), 1102: sha('d'), 1103: sha('a') })
    expect(updatesOf(bench, 1102)).toBe(1)
    expect(updatesOf(bench, 1103)).toBe(0)
    expect(mergeDenialsByHead(bench)).toEqual([1])
  })
})

describe('conveyor O3: declarations of one kind, and the bus-restart area', () => {
  it('scenario 14: different event declarations merge with no update; the same key is ordered, and the second update meets a real conflict it does not resolve', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-o3-conflict-'))
    roots.push(root)
    const shared = 'declarations/events/o3-c.json'
    const conflict = conflictOn(root, shared, 1504)
    const line = conveyor({ mergeMainIn: conflict.tree })
    const { bench } = line
    admitted(bench, 1504, conflict.branch, shared)
    open(bench, 1401, ['declarations/events/o3-a.json'])
    open(bench, 1402, ['declarations/events/o3-b.json'])
    bench.tick()
    expect(latestGroups(bench).map(group => group.prs)).toEqual([[1401], [1402]])
    await rounds(line, 2)
    expect(merged(bench)).toEqual([1401, 1402])
    expect(updatesOf(bench)).toBe(0)
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toEqual([])

    open(bench, 1403, [shared])
    open(bench, 1404, [shared], conflict.head)
    bench.tick()
    expect(latestGroups(bench)).toEqual([expect.objectContaining({ prs: [1403, 1404], turn: 1403 })])
    await once(line.merge)
    expect(merged(bench)).toEqual([1401, 1402, 1403])
    bench.gitHub.pulls.set(1404, { ...bench.gitHub.pulls.get(1404)!, mergeable_state: 'dirty' })
    bench.tick()
    await once(line.update)

    expect(merged(bench)).toEqual([1401, 1402, 1403])
    expect(eventsOf(bench.db, POLICY_DENIED).at(-1)).toMatchObject({ reason: 'merge_refused', detail: expect.stringContaining(shared) })
    expect(git(conflict.origin, ['rev-parse', `refs/heads/${conflict.branch}`])).toBe(conflict.head)
    expect(updatePuts(bench, 1404)).toBe(0)
    expect(answerCandidates(bench.db, bench.clock.now().toISOString(), answerParts())).toMatchObject([{ queue: 'answer', cardId: 1504, pr: 1404, head: conflict.head }])
  })

  it('scenario 15: two restart-scope PRs with disjoint paths are one group by the bus-restart area and merge one at a time; with contention.suspended for the pair they are two groups', async () => {
    const line = conveyor()
    const { bench } = line
    open(bench, 1501, ['scripts/nodes/o3-one.ts'])
    open(bench, 1502, ['scripts/ports/o3-two.ts'])
    bench.tick()
    expect(latestGroups(bench)).toEqual([expect.objectContaining({ prs: [1501, 1502], turn: 1501 })])
    await once(line.merge)
    expect(merged(bench)).toEqual([1501])
    await rounds(line, 4)
    expect(merged(bench)).toEqual([1501, 1502])

    open(bench, 1503, ['scripts/nodes/o3-three.ts'])
    open(bench, 1504, ['scripts/ports/o3-four.ts'])
    bench.tick()
    expect(latestGroups(bench)).toEqual([expect.objectContaining({ prs: [1503, 1504] })])
    const outcome = dispatchRequest({ db: bench.db, now: () => bench.clock.now().toISOString() } as never, 'contention.suspend', 9150, { kind: 'contention.suspend', ids: [1503, 1504], area: 'bus-restart' })
    expect(outcome.done).toBe(true)
    bench.tick()
    expect(latestGroups(bench)).toEqual([expect.objectContaining({ prs: [1503], turn: 1503 }), expect.objectContaining({ prs: [1504], turn: 1504 })])
  })

  it('scenario 15: a contention area whose until names a check with no slice is refused by the validator', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-o3-area-'))
    roots.push(root)
    mkdirSync(path.join(root, 'declarations', 'contention'), { recursive: true })
    writeFileSync(path.join(root, 'declarations', 'contention', 'o3-area.json'), `${JSON.stringify({ id: 'o3-area', module: 'session', paths: ['scripts/core/'], why: 'a test area', until: 'P-no-such-slice' })}\n`)
    expect(readDeclarations(root).problems.join('\n')).toContain('until names "P-no-such-slice", a check with no slice')
  })
})

interface Conflict {
  tree: string
  origin: string
  branch: string
  head: string
}

function write(tree: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
}

function commitAll(tree: string, message: string): string {
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', message])
  return git(tree, ['rev-parse', 'HEAD'])
}

function conflictOn(root: string, file: string, cardId: number): Conflict {
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const tree = path.join(root, 'tree')
  const branch = `feat/card-${cardId}`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' })
  git(seed, ['checkout', '-q', '-b', 'main'])
  write(seed, 'README.md', 'base\n')
  commitAll(seed, 'base')
  git(seed, ['push', '-q', 'origin', 'main'])
  execFileSync('git', ['clone', '-q', '-b', 'main', origin, tree], { stdio: 'ignore' })
  git(tree, ['checkout', '-q', '-b', branch])
  write(tree, file, '{ "event": "c", "from": "the second card" }\n')
  const head = commitAll(tree, 'card work')
  git(tree, ['push', '-q', 'origin', branch])
  write(seed, file, '{ "event": "c", "from": "the first card" }\n')
  commitAll(seed, 'the first card merges')
  git(seed, ['push', '-q', 'origin', 'main'])
  return { tree, origin, branch, head }
}

function admitted(bench: MergeBench, cardId: number, branch: string, touches: string): void {
  const text = `card: #${cardId} task-${cardId} [implement/construct/S/cheap/owner] · depends — · blocks —\nbranch: ${branch}\ntouches: ${touches}\nwho: shift\n\ndo ${cardId}\n`
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
}

describe('conveyor O3: the merge node as production builds it judges the check before merge by the declarations', () => {
  function mergeDenials(bench: MergeBench): Record<string, unknown>[] {
    return eventsOf(bench.db, POLICY_DENIED).filter(denied => denied.command === 'merge' && denied.reason === 'needs_update')
  }

  it('main moving a derived registry the PR also changes, unseen by the order, is no overlap at the merge lease: merged with no denial', async () => {
    const line = conveyor()
    const { bench } = line
    open(bench, 1801, ['docs/guide/o3-derived.md', MODULE_FILES])
    bench.tick()
    advanceMain(bench, [MODULE_FILES])

    await once(line.merge)

    expect(merged(bench)).toEqual([1801])
    expect(mergeDenials(bench)).toEqual([])
  })

  it('main moving another file of a declared contention area the PR is in, unseen by the order, is an overlap at the merge lease: denied once, not merged', async () => {
    const line = conveyor()
    const { bench } = line
    open(bench, 1802, ['scripts/core/o3-own-file.ts'])
    bench.tick()
    advanceMain(bench, ['scripts/nodes/o3-other-file.ts'])

    await once(line.merge)

    expect(merged(bench)).toEqual([])
    expect(mergeDenials(bench)).toEqual([expect.objectContaining({ detail: expect.stringContaining('scripts/nodes/o3-other-file.ts') })])
  })
})
