import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { pendingPathsOf } from '../../nodes/answer/duties/index.js'
import { mainAdvanceToUpdateFirst } from '../../policy/policy.js'
import { busContract, busProjections, cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { claudeClient } from '../client/claude-client.js'
import { ranTheGreenGate } from './gate-stream.js'
import { MAIN_1, MAIN_2, sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'

vi.mock('../../ports/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ports/git.js')>()
  const { existsSync: exists, writeFileSync: write } = await import('node:fs')
  const { join } = await import('node:path')
  return {
    ...original,
    pnpmRerun: (cwd: string) => {
      if (exists(join(cwd, 'contract/ratchet.json')))
        write(join(cwd, 'contract/ratchet.json'), '{\n  "boundary:ladder->cost": 13,\n  "boundary:session->cost": 6\n}\n')
      return { status: 0, stderr: '' }
    },
  }
})

const RATCHET = 'contract/ratchet.json'
const DECLARATION = 'declarations/modules/ladder.json'
const ROWS = (cost: number, ladder: number): string => `{\n  "boundary:ladder->cost": ${ladder},\n  "boundary:session->cost": ${cost}\n}\n`
const MAIN_SHRANK_THE_ROW = '@@ -1,4 +1,4 @@\n {\n   "boundary:ladder->cost": 13,\n-  "boundary:session->cost": 2\n+  "boundary:session->cost": 6\n }\n'
const MEASURED_ON_THE_UPDATE = '@@ -1,4 +1,4 @@\n {\n   "boundary:ladder->cost": 13,\n-  "boundary:session->cost": 2\n+  "boundary:session->cost": 1\n }\n'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function ownerMergeWaits(bench: MergeBench): Record<string, unknown>[] {
  return eventsOf(bench.db, OWNER_WAIT_OPENED).filter(wait => wait.need === 'merge')
}

function admitted(bench: MergeBench, pr: number): void {
  const card = pr + 100
  const text = `card: #${card} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${card}\ntouches: scripts/other.ts, ${RATCHET}\ncontinue: stop\nwho: shift\n\nThe card.\n`
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}:merge`, payload: { card: `#${card}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${card}`, text, textSha: textSha(text), bodySha: 'merge' }, legacy: false })
  reduce(bench.db, 'pending', busProjections())
}

function mainMovedAModule(bench: MergeBench): void {
  bench.gitHub.mainFiles[MAIN_2] = [DECLARATION, 'scripts/ladder/hash.ts']
  bench.gitHub.main = MAIN_2
}

describe('ratchet growth is measured on a head that holds main (F-update-measures-growth-before-merging-main)', () => {
  it('a PR measured after an unrelated module move on main opens no growth wait', () => {
    const bench = liveBench()
    benches.push(bench)
    const pr = 2395
    admitted(bench, pr)
    bench.gitHub.open({ number: pr, review: 'success', baseSha: MAIN_1, files: [RATCHET, 'scripts/other.ts'], patches: { [RATCHET]: MAIN_SHRANK_THE_ROW } })
    mainMovedAModule(bench)
    bench.tick()

    const judged = bench.merge(bench.lease()!)

    expect(judged).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: busContract().needsUpdate, parkedUntil: 'new_head' } })
    expect(JSON.stringify(judged)).toContain(DECLARATION)
    expect(ownerMergeWaits(bench)).toEqual([])

    bench.gitHub.open({ number: pr, review: 'success', head: sha('d'), baseSha: MAIN_2, files: [RATCHET, 'scripts/other.ts'], patches: { [RATCHET]: MEASURED_ON_THE_UPDATE } })
    bench.tick()
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged' })
    expect(ownerMergeWaits(bench)).toEqual([])
  })

  it('an updated head that grows a row still waits for the owner', () => {
    const bench = liveBench()
    benches.push(bench)
    const pr = 2396
    admitted(bench, pr)
    bench.gitHub.open({ number: pr, review: 'success', baseSha: MAIN_1, files: [RATCHET], patches: { [RATCHET]: MAIN_SHRANK_THE_ROW } })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'ratchet_grows' } })
    expect(ownerMergeWaits(bench)).toHaveLength(1)
  })

  it('main has to touch the ratchet or a module declaration, and the PR a derived or declared file, before the merge updates first', () => {
    expect(mainAdvanceToUpdateFirst([RATCHET], [RATCHET, DECLARATION, 'scripts/a.ts'])).toEqual([RATCHET, DECLARATION])
    expect(mainAdvanceToUpdateFirst([DECLARATION], [RATCHET])).toEqual([RATCHET])
    expect(mainAdvanceToUpdateFirst([RATCHET], ['scripts/a.ts', 'docs/b.md'])).toEqual([])
    expect(mainAdvanceToUpdateFirst(['scripts/a.ts'], [RATCHET, DECLARATION])).toEqual([])
  })

  it('a truncated compare of main is not read as a file list: the check before merge counts it as an overlap and updates', () => {
    const bench = liveBench()
    benches.push(bench)
    const pr = 2397
    admitted(bench, pr)
    bench.gitHub.open({ number: pr, review: 'success', baseSha: MAIN_1, files: [RATCHET, 'scripts/other.ts'], patches: { [RATCHET]: MAIN_SHRANK_THE_ROW } })
    mainMovedAModule(bench)
    bench.gitHub.commitsBeyondTheCompare = 1
    bench.tick()

    const judged = bench.merge(bench.lease()!)

    expect(judged).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: busContract().needsUpdate, parkedUntil: 'new_head' } })
    expect(JSON.stringify(judged)).toContain('which counts as an overlap')
    expect(JSON.stringify(judged)).not.toContain('judged on the updated head')
    expect(ownerMergeWaits(bench)).toEqual([])
  })
})

const CARD = 2497
const SESSION = 'card-session-1'
const TOUCHED = 'scripts/core/lease.ts'
const NOT_DERIVED = 'scripts/core/other.ts'
const CARD_TEXT = `card: #${CARD} reset-derived [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nDrop the import.\n`

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
}

function room(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reset-derived-'))
  roots.push(root)
  return root
}

function branchThatChangedTheRatchet(worktree: string, staleOutside: boolean): void {
  const files = { 'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`, [TOUCHED]: 'export const lease = 1\n', [NOT_DERIVED]: 'export const other = 1\n', [RATCHET]: ROWS(2, 13) }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
  execFileSync('git', ['init', '-q', worktree])
  gitIn(worktree, ['add', '-A'])
  gitIn(worktree, ['commit', '-q', '-m', 'base'])
  gitIn(worktree, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  writeFileSync(path.join(worktree, RATCHET), ROWS(6, 13))
  if (staleOutside)
    writeFileSync(path.join(worktree, NOT_DERIVED), 'export const other = 2\n')
  gitIn(worktree, ['commit', '-q', '-am', 'stale rows'])
}

async function answerWith(round: (worktree: string) => void, staleOutside = false): Promise<{ made: MergeBench, outcome: AnswerOutcome, published: number, ratchet: string }> {
  const made = mergeBench()
  benches.push(made)
  const home = room()
  const worktree = path.join(home, `mc-${CARD}`)
  branchThatChangedTheRatchet(worktree, staleOutside)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text: CARD_TEXT, textSha: textSha(CARD_TEXT) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'the stale rows go' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  const lease = leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  const heads = [sha('a'), sha('e')]
  let published = 0
  const answerer = claudeAnswerer(path.join(home, 'answers'), {
    client: claudeClient,
    cardText: () => CARD_TEXT,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      round(worktree)
      ranTheGreenGate(run)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: () => {
      published += 1
    },
    pending: pendingPathsOf,
  })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: card => `feat/card-${card}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  const outcome = await executor.answer(lease)
  return { made, outcome, published, ratchet: readFileSync(path.join(worktree, RATCHET), 'utf8') }
}

describe('an answer that resets a derived file to the branch base changes nothing outside the touches', () => {
  it('a derived file reset to base opens no outside-touch wait', async () => {
    const { made, outcome, published, ratchet } = await answerWith((worktree) => {
      writeFileSync(path.join(worktree, TOUCHED), 'export const lease = 2\n')
      gitIn(worktree, ['checkout', 'origin/main', '--', RATCHET])
    })

    expect(ratchet).toBe(ROWS(2, 13))
    expect(outcome).toMatchObject({ kind: 'answered' })
    expect(published).toBe(1)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a derived file the answer edits away from its base by hand is still refused', async () => {
    const { outcome, published } = await answerWith((worktree) => {
      writeFileSync(path.join(worktree, TOUCHED), 'export const lease = 2\n')
      writeFileSync(path.join(worktree, RATCHET), ROWS(7, 13))
    })

    expect(outcome).not.toMatchObject({ kind: 'answered' })
    expect(published).toBe(0)
  })

  it('a file outside the touches that is not derived stays refused when the answer resets it to the branch base', async () => {
    const { outcome, published } = await answerWith((worktree) => {
      writeFileSync(path.join(worktree, TOUCHED), 'export const lease = 2\n')
      gitIn(worktree, ['checkout', 'origin/main', '--', RATCHET, NOT_DERIVED])
    }, true)

    expect(outcome).not.toMatchObject({ kind: 'answered' })
    expect(JSON.stringify(outcome)).toContain(NOT_DERIVED)
    expect(published).toBe(0)
  })
})
