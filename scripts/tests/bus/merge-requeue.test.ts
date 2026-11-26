import type { DatabaseSync } from 'node:sqlite'
import type { TimedShellResult } from '../../nodes/witness/witness-executor.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { lastEventId } from '../../core/events-query.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STARTED, POLICY_DENIED, PR_OBSERVED, REVIEW_RECORDED, SHARD_ISSUED, TASK_FAILED, UPDATE_DONE, WITNESS_RECORDED } from '../../core/events.js'
import { anOpenPrOnTheHead } from '../../core/pr-readings.js'
import { keyOf, queueTask, reviewCandidates, WITHDRAWN } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { answerCandidates } from '../../nodes/answer/answer-candidates.js'
import { mergeSource } from '../../nodes/merge/merge-candidates.js'
import { manualUpdateDone, recordedVerdictOn } from '../../nodes/update/update-executor.js'
import { witnessCandidates, witnessSource } from '../../nodes/witness/witness-candidates.js'
import { UNFIT } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { prBodySha } from '../../ports/identifier-shapes.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { answerParts, busProjections, candidateRules, mergeParts, witnessParts } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, taskState } from './merge-bench.js'

const PR = 977
const UNREADABLE_BODY = cardBody(PR, 'none')
const benches: MergeBench[] = []
const TREE_MS = 120_000
const TS = '2026-11-26T10:00:00.000Z'
const CARD = 4101
const OTHER_CARD = 4102
const READS_PR = 5101
const OTHER_PR = 5102
const fullSha = (digit: string): string => digit.repeat(40)
const HEAD = fullSha('a')
const OLD_HEAD = fullSha('b')
const BASE = fullSha('1')
const OTHER_BASE = fullSha('2')
const CARD_BODY = 'c'.repeat(40)
const dbs: DatabaseSync[] = []
const roots: string[] = []
let serial = 0

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function withdrawnOnTheBody(): MergeBench & { withdrawnKey: string } {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, review: 'success', body: UNREADABLE_BODY })
  bench.tick()
  const lease = bench.lease()!
  expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'decision_unread' } })
  return { ...bench, withdrawnKey: lease.taskKey }
}

function mergeTasks(bench: MergeBench): { task_key: string, state: string }[] {
  return bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'merge' AND pr = ? ORDER BY id`).all(PR) as { task_key: string, state: string }[]
}

describe('a merge task withdrawn on the pull request body', () => {
  it('carries the sha of the body in its key', () => {
    const bench = withdrawnOnTheBody()

    expect(bench.withdrawnKey.endsWith(`:pr-body-${prBodySha(UNREADABLE_BODY)}`)).toBe(true)
    expect(taskState(bench.db, bench.withdrawnKey).state).toBe('withdrawn')
  })

  it('is named by a board.alarm that carries the task key', () => {
    const bench = withdrawnOnTheBody()

    expect(eventsOf(bench.db, BOARD_ALARM)).toMatchObject([{ task_key: bench.withdrawnKey, reason: 'decision_unread' }])
  })

  it('is queued again under a new key after the body is edited', () => {
    const bench = withdrawnOnTheBody()
    bench.gitHub.pulls.get(PR)!.body = cardBody(PR)
    bench.tick()

    const tasks = mergeTasks(bench)
    const queued = tasks.filter(task => task.state === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.task_key).not.toBe(bench.withdrawnKey)
    expect(queued[0]!.task_key.endsWith(`:pr-body-${prBodySha(cardBody(PR))}`)).toBe(true)
    expect(taskState(bench.db, bench.withdrawnKey).state).toBe('withdrawn')
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged' })
  })

  it('stays withdrawn while the body is unchanged', () => {
    const bench = withdrawnOnTheBody()
    bench.tick()

    expect(mergeTasks(bench)).toEqual([{ task_key: bench.withdrawnKey, state: 'withdrawn' }])
  })
})

describe('a merge task of a pull request whose body was edited', () => {
  function queuedBench(): MergeBench {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, review: 'success', body: cardBody(PR) })
    bench.tick()
    return bench
  }

  function editBody(bench: MergeBench): void {
    bench.gitHub.pulls.get(PR)!.body = `${cardBody(PR)}\nedited`
    bench.tick()
  }

  it('supersedes the queued task and queues one under the new body', () => {
    const bench = queuedBench()
    const [old] = mergeTasks(bench)
    editBody(bench)

    expect(taskState(bench.db, old!.task_key).state).toBe('superseded')
    const queued = mergeTasks(bench).filter(task => task.state === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.task_key.endsWith(`:pr-body-${prBodySha(`${cardBody(PR)}\nedited`)}`)).toBe(true)
  })

  it('supersedes the leased task', () => {
    const bench = queuedBench()
    const lease = bench.lease()!
    editBody(bench)

    expect(taskState(bench.db, lease.taskKey).state).toBe('superseded')
  })

  it('supersedes a task whose key has no body suffix and keeps the one under the current body', () => {
    const bench = queuedBench()
    const [current] = mergeTasks(bench)
    const { card_id: cardId, head } = bench.db.prepare('SELECT card_id, head FROM tasks WHERE task_key = ?').get(current!.task_key) as { card_id: number, head: string }
    const legacy = { queue: 'merge' as const, cardId, pr: PR, head }
    expect(queueTask(bench.db, bench.clock.now().toISOString(), legacy)).toBe(true)
    bench.tick()

    expect(taskState(bench.db, keyOf(legacy)).state).toBe('superseded')
    expect(taskState(bench.db, current!.task_key).state).toBe('queued')
  })

  it('keys the merge task by the pull request body alone, never by a review input', () => {
    const bench = queuedBench()
    const [queued] = mergeTasks(bench)
    const { card_id: cardId, head } = bench.db.prepare('SELECT card_id, head FROM tasks WHERE task_key = ?').get(queued!.task_key) as { card_id: number, head: string }

    expect(queued!.task_key).toBe(`merge:${cardId}:${PR}:${head}:pr-body-${prBodySha(cardBody(PR))}`)
    expect(queued!.task_key).not.toContain(':card-body-')
  })

  it('keys the review task by the pull request body and the card body', () => {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, body: cardBody(PR) })
    bench.tick()
    const [review] = bench.db.prepare('SELECT task_key FROM tasks WHERE queue = \'review\' AND pr = ?').all(PR) as { task_key: string }[]

    expect(review!.task_key).toMatch(new RegExp(`:pr-body-${prBodySha(cardBody(PR))}:card-body--$`))
  })

  it('leaves a task alone while its body is the pull request body', () => {
    const bench = queuedBench()
    const before = mergeTasks(bench)
    bench.tick()

    expect(mergeTasks(bench)).toEqual(before)
    expect(before[0]!.state).toBe('queued')
  })
})

describe('the review input segment of a task key', () => {
  const CARD = PR + 100
  const CARD_BODY_SHA = 'c'.repeat(40)
  const HEAD = 'd'.repeat(40)

  function benchWithAPullRequest(ci: string, verdict: string | null): MergeBench {
    const bench = mergeBench()
    benches.push(bench)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { bodySha: CARD_BODY_SHA, depends: [] }, legacy: false })
    bench.db.prepare('INSERT INTO prs (pr, card_id, base, head, state, ci, verdict_on_head, body_sha, draft, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, (SELECT max(id) FROM events))')
      .run(PR, CARD, 'main', HEAD, 'open', ci, verdict, prBodySha(cardBody(PR)))
    return bench
  }

  it('is absent from the key of an answer candidate whose row carries a pull request body sha', () => {
    const bench = benchWithAPullRequest('red', 'changes')
    const keys = answerCandidates(bench.db, bench.clock.now().toISOString(), answerParts()).map(keyOf)

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key).not.toContain(':pr-body-')
      expect(key).toContain(`:card-body-${CARD_BODY_SHA}`)
    }
  })

  it('is absent from the key of a witness candidate', () => {
    const bench = benchWithAPullRequest('green', null)
    const keys = witnessCandidates(bench.db, bench.clock.now().toISOString(), witnessParts()).map(keyOf)

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys)
      expect(key).not.toContain(':pr-body-')
  })

  it('is kept in the key of a review candidate', () => {
    const bench = benchWithAPullRequest('green', null)
    const keys = reviewCandidates(bench.db, bench.clock.now().toISOString(), candidateRules()).map(keyOf)

    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain(`:pr-body-${prBodySha(cardBody(PR))}`)
  })
})

describe('an authority denial of a merge task', () => {
  function deniedBench(body: string, files: string[]): { bench: MergeBench, key: string, result: unknown } {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, review: 'success', body, files })
    bench.tick()
    const lease = bench.lease()!
    return { bench, key: lease.taskKey, result: bench.merge(lease) }
  }

  it('no_matrix_count_line is named by a board.alarm that carries the task key', () => {
    const { bench, key, result } = deniedBench(cardBody(PR), ['src/cli.ts'])

    expect(result).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'no_matrix_count_line' } })
    expect(eventsOf(bench.db, BOARD_ALARM)).toMatchObject([{ task_key: key, reason: 'no_matrix_count_line' }])
  })

  it('a rule outside the withdrawn-on-the-body set raises no board.alarm', () => {
    const { bench, result } = deniedBench(cardBody(PR, 'owner'), [])

    expect(result).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_without_shard' } })
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  dbs.push(db)
  return db
}

interface EventFields { cardId?: number | null, pr?: number | null, head?: string | null, payload?: Record<string, unknown> }

function recorded(db: DatabaseSync, type: string, fields: EventFields = {}): number {
  serial += 1
  appendEvent(db, { ts: TS, type, actor: 'owner', cardId: fields.cardId ?? null, pr: fields.pr ?? null, head: fields.head ?? null, dedupeKey: `${type}:owner-reads-${serial}`, payload: fields.payload ?? {}, legacy: false })
  return lastEventId(db)
}

interface WithdrawnTask { key: string, queue: 'merge' | 'close', cardId: number, pr: number | null, head: string }

function withdrawn(db: DatabaseSync, task: WithdrawnTask): number {
  const id = recorded(db, TASK_FAILED, { cardId: task.cardId, pr: task.pr, head: task.head, payload: { task_key: task.key, reason: 'technical' } })
  db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(task.key, task.queue, task.cardId, task.pr, task.head, WITHDRAWN, id)
  return id
}

function pullRequest(db: DatabaseSync, pr: number, cardId: number, head: string, state = 'open'): void {
  const id = recorded(db, PR_OBSERVED, { cardId, pr, head })
  db.prepare('INSERT OR REPLACE INTO prs (pr, card_id, base, head, state, draft, event_id) VALUES (?, ?, ?, ?, ?, 0, ?)').run(pr, cardId, 'main', head, state, id)
}

function shardIssued(db: DatabaseSync, cardId: number): void {
  recorded(db, SHARD_ISSUED, { cardId, payload: { id: `shard-${serial}` } })
}

function requeuedMerges(db: DatabaseSync): string[] {
  return mergeSource(mergeParts()).requeue!(db, TS).map(row => row.task_key)
}

const MERGE_KEY = `merge:${CARD}:${READS_PR}:${HEAD}`

describe('a withdrawn merge is requeued by a later shard only on its open head', () => {
  it('a shard issued after the withdrawal requeues it', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([MERGE_KEY])
  })

  it('a shard issued before the withdrawal does not requeue it', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)
    shardIssued(db, CARD)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })

    expect(requeuedMerges(db)).toEqual([])
  })

  it('a later shard does not requeue a merge whose pull request closed', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD, 'closed')
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([])
  })

  it('a later shard does not requeue a merge withdrawn on a head the pull request has moved past', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)
    const oldKey = `merge:${CARD}:${READS_PR}:${OLD_HEAD}`
    withdrawn(db, { key: oldKey, queue: 'merge', cardId: CARD, pr: READS_PR, head: OLD_HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([])
  })

  it('requeues by task key, not by the order the tasks were withdrawn in', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)
    pullRequest(db, OTHER_PR, CARD, OLD_HEAD)
    const later = `merge:${CARD}:${OTHER_PR}:${OLD_HEAD}`
    withdrawn(db, { key: later, queue: 'merge', cardId: CARD, pr: OTHER_PR, head: OLD_HEAD })
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([MERGE_KEY, later])
  })
})

describe('an open pull request on the head', () => {
  it('is on the head it was observed on and on no other', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)

    expect(anOpenPrOnTheHead(db, READS_PR, HEAD)).toBe(true)
    expect(anOpenPrOnTheHead(db, READS_PR, OLD_HEAD)).toBe(false)
  })
})

function reviewed(db: DatabaseSync, head: string, verdict: string): void {
  recorded(db, REVIEW_RECORDED, { cardId: CARD, pr: READS_PR, head, payload: { head, verdict } })
}

describe('the verdict recorded on a head', () => {
  it('is the newest review on that head', () => {
    const db = bus()
    reviewed(db, HEAD, 'changes')
    reviewed(db, HEAD, 'pass')

    expect(recordedVerdictOn(db, READS_PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is not a newer review on another head', () => {
    const db = bus()
    reviewed(db, HEAD, 'pass')
    reviewed(db, OLD_HEAD, 'changes')

    expect(recordedVerdictOn(db, READS_PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is not an update onto the head that carried nothing', () => {
    const db = bus()
    reviewed(db, HEAD, 'pass')
    appendEvent(db, manualUpdateDone({ ts: TS, session: 'window', cardId: CARD, pr: READS_PR, from: OLD_HEAD, to: HEAD }))

    expect(recordedVerdictOn(db, READS_PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is the verdict an update onto the head carried', () => {
    const db = bus()
    reviewed(db, HEAD, 'changes')
    recorded(db, UPDATE_DONE, { cardId: CARD, pr: READS_PR, head: OLD_HEAD, payload: { from: OLD_HEAD, to: HEAD, carried: 'pass' } })

    expect(recordedVerdictOn(db, READS_PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })
})

function witnessDenied(db: DatabaseSync, cardId: number, head: string, payload: Record<string, unknown>, pr: number | null = null): void {
  recorded(db, POLICY_DENIED, { cardId, pr, head, payload: { reason: 'witness', ...payload } })
}

function witnessRecorded(db: DatabaseSync, cardId: number, head: string, payload: Record<string, unknown>): void {
  recorded(db, WITNESS_RECORDED, { cardId, head, payload: { head, cardBody: CARD_BODY, ...payload } })
}

function requeuedOnAWitness(db: DatabaseSync): string[] {
  return witnessSource().requeue!(db, TS).map(row => row.task_key)
}

const CLOSE_KEY = `close:${CARD}:-:${HEAD}`

describe('a task withdrawn on a witness is requeued once the witness is green on the denied base', () => {
  it('a green record after the withdrawal requeues a withdrawn close', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([CLOSE_KEY])
  })

  it('a red record after the withdrawal does not requeue it', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'red' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a green record from before the withdrawal does not requeue it', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a witness denial of the other command does not decide this queue', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a green witness requeues a withdrawn merge on its open head', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, READS_PR)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([MERGE_KEY])
  })

  it('a green witness does not requeue a withdrawn merge whose pull request closed', () => {
    const db = bus()
    pullRequest(db, READS_PR, CARD, HEAD, 'closed')
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, READS_PR)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: READS_PR, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })
})

function admitted(db: DatabaseSync, cardId: number, bodySha = CARD_BODY): void {
  recorded(db, CARD_ADMITTED, { cardId, payload: { card: `#${cardId}`, bodySha } })
}

describe('a witness candidate on a denied base', () => {
  it('opens only on the latest witness denial of the card on the head', () => {
    const db = bus()
    admitted(db, CARD)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: OTHER_BASE }, READS_PR)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, READS_PR)

    expect(witnessCandidates(db, TS, witnessParts()).map(task => task.base)).toEqual([BASE])
  })
})

const WITNESSED_BODY = 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main'

function startedOnMain(db: DatabaseSync, cardId: number): void {
  const text = parkingFileText({ card: `#${cardId} witnessed [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/witnessed-${cardId}`, touches: ['done.txt'], continue: 'stop', who: 'shift', body: WITNESSED_BODY })
  admitted(db, cardId)
  const admission = lastEventId(db)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha) VALUES (?, ?, ?, ?)').run(cardId, admission, text, textSha(text))
  recorded(db, CARD_STARTED, { cardId })
}

function mainRecorded(db: DatabaseSync): void {
  const id = recorded(db, 'main.advanced', { head: BASE })
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, 0, ?)').run(BASE, id)
}

function cardIn(db: DatabaseSync, cardId: number, state: string): void {
  db.prepare('INSERT OR REPLACE INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(cardId, state, lastEventId(db))
}

function witnessedOnMain(db: DatabaseSync): number[] {
  return witnessCandidates(db, TS, witnessParts()).filter(task => task.pr === undefined).map(task => task.cardId)
}

describe('a witness candidate on main', () => {
  it('opens for a started card with witnesses and no pull request', () => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)

    expect(witnessedOnMain(db)).toEqual([CARD])
  })

  it('does not open for a card that has a pull request', () => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)
    pullRequest(db, READS_PR, CARD, HEAD, 'closed')

    expect(witnessedOnMain(db)).toEqual([])
  })

  it.each(['dropped', 'merged'])('does not open for a %s card', (state) => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)
    startedOnMain(db, OTHER_CARD)
    cardIn(db, CARD, state)

    expect(witnessedOnMain(db)).toEqual([OTHER_CARD])
  })
})

const ADDED_TEST = 'tests/newdir/a.test.ts'
const FOREIGN_TEST = 'tests/other/b.test.ts'
const VITEST_RUN = /vitest run (\S+)/
const NOW = '2026-11-26T10:02:00.000Z'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function committed(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

async function vitestLike(command: string, cwd: string): Promise<TimedShellResult> {
  const target = VITEST_RUN.exec(command)?.[1]
  const found = target !== undefined && existsSync(path.join(cwd, target))
  return found ? { status: 0, output: ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n', timedOut: false } : { status: 1, output: `No test files found, exiting with code 1\nfilter: ${target ?? ''}\n`, timedOut: false }
}

function admittedWith(db: DatabaseSync, touches: string[], at: string, suffix: string): void {
  const witness = { id: 'W1', run: `pnpm exec vitest run ${FOREIGN_TEST}`, test: null, head: 'pass', base: 'fail', proves: 'a test outside the latest touches' }
  const text = parkingFileText({ card: `#${CARD} scoped [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/scoped', touches, continue: 'stop', who: 'shift', body: `Add the tests.\n\nwitnesses: ${JSON.stringify([witness])}` })
  appendEvent(db, { ts: at, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${suffix}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
}

describe('the witness node judges a witness against the latest admission of the card', () => {
  it('a file the first admission touched and the latest does not is outside the card', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'owner-reads-witness-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    const base = committed(repo, { 'README.md': 'base\n' }, 'base')
    const head = committed(repo, { [ADDED_TEST]: 'it passes\n' }, 'head')
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    admittedWith(db, ['tests/newdir/**', 'tests/other/**'], '2026-11-26T09:00:00.000Z', 'first')
    admittedWith(db, ['tests/newdir/**'], '2026-11-26T09:30:00.000Z', 'latest')
    appendEvent(db, { ts: '2026-11-26T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: READS_PR, head, dedupeKey: `${PR_OBSERVED}:${READS_PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
    reduce(db, 'pending', busProjections())
    const turns = new SetupTurns()
    const trees = { baseOf: async () => base, withTree: <T>(at: string, run: (tree: string) => Promise<T>) => withWorktreeAsync(repo, at, run, turns) }
    const node = new WitnessNode({ silentMs: SILENT_MS, db, clock: () => new Date(NOW), session: 'witness-1', mode: 'live', env: {}, shell: vitestLike, trees })
    for (let round = 0; round < 2; round += 1) {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    }

    const records = (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WITNESS_RECORDED) as { payload: string }[]).map(row => JSON.parse(row.payload) as { verdict: string, detail: string })
    expect(records.map(record => record.verdict)).toEqual([UNFIT])
    expect(records[0]!.detail).toContain(`names ${FOREIGN_TEST}`)
    expect(records[0]!.detail).toContain('outside the card\'s touches')
  }, TREE_MS)
})
