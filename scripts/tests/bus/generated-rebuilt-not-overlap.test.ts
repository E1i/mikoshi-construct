import type { ShiftTask } from '../../../src/card/task-file.js'
import type { Lease } from '../../core/lease.js'
import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_STOPPED, POLICY_DENIED, UPDATE_DONE } from '../../core/events.js'
import { GENERATED_FILES } from '../../core/generated-files.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { currentLane, layLanes, withoutDerived } from '../../nodes/launch/lane-assign.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { sharedAppendFiles } from '../../nodes/launch/shared-files.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { mainMergeInCardTree } from '../../ports/main-merge.js'
import { cardTransitions, updateParts } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, liveBench, mergeBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const MODULE_FILES = GENERATED_FILES.moduleFiles.path
const KNOWN_VIOLATIONS = GENERATED_FILES.knownViolations.path
const HAND_WRITTEN = 'scripts/core/queue.ts'
const CHANGESET = '.changeset/**'
const OWN = 'scripts/own.ts'
const REBUILT_TEXT = '{"rebuilt":true}\n'
const LANES = 3

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const admission = (cardId: number): string => `admission-${cardId}`
const launchKey = (cardId: number): string => taskKey({ queue: 'launch', cardId, generation: admission(cardId) })

class RecordingStarter implements CardStarter {
  starts: QueuedCard[] = []
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

function launchBench() {
  const bench = mergeBench()
  const starter = new RecordingStarter()
  const executor = new LaunchExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: bench.db, starter, clock: bench.clock.now, disk: roomy, isolation: sandboxed })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    starter,
    admitTouching: (cardId: number, touches: string[]): void => {
      const text = parkingFileText({ card: `#${cardId} card-${cardId} [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${cardId}`, touches, continue: 'stop', who: 'shift', body: 'Do the card.' })
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: admission(cardId), text }, legacy: false })
    },
    layOut: (): void => {
      layLanes(bench.db, LANES, ts(), 'policy')
    },
    startQueued: (): void => {
      for (let lease = leaseNext(bench.db, ts(), 'launch', 'worker:launch:worker-1'); lease !== null; lease = leaseNext(bench.db, ts(), 'launch', 'worker:launch:worker-1'))
        executor.launch(lease)
    },
    closeCard: (cardId: number): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_CLOSED, actor: 'worker:close:worker-1', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { reason: 'merged' }, legacy: false })
    },
  }
}

function startedCards(bench: ReturnType<typeof launchBench>): number[] {
  return bench.starter.starts.map(card => card.cardId).sort()
}

function twoCardsSharing(file: string) {
  const bench = launchBench()
  bench.admitTouching(1, ['scripts/first/**', file, CHANGESET])
  bench.admitTouching(2, ['scripts/second/**', file, CHANGESET])
  bench.layOut()
  bench.tick()
  bench.startQueued()
  return bench
}

function startsOneAtATime(file: string): void {
  expect(withoutDerived({ touches: ['scripts/first/**', file] } as unknown as ShiftTask).touches).toEqual(['scripts/first/**', file].sort())
  const bench = twoCardsSharing(file)
  expect(currentLane(bench.db, 1)).toBe(currentLane(bench.db, 2))
  expect(startedCards(bench)).toEqual([1])
  expect(taskState(bench.db, launchKey(2))).toBeUndefined()
  bench.closeCard(1)
  bench.tick()
  bench.startQueued()
  expect(startedCards(bench)).toEqual([1, 2])
  bench.close()
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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

function secondCardBehindTheFirst(cardId: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'generated-rebuilt-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const tree = path.join(root, 'tree')
  const branch = `feat/card-${cardId}`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' })
  git(seed, ['checkout', '-q', '-b', 'main'])
  write(seed, OWN, 'base\n')
  write(seed, MODULE_FILES, '{"base":true}\n')
  commitAll(seed, 'base')
  git(seed, ['push', '-q', 'origin', 'main'])
  execFileSync('git', ['clone', '-q', '-b', 'main', origin, tree], { stdio: 'ignore' })
  git(tree, ['checkout', '-q', '-b', branch])
  write(tree, OWN, 'second card\n')
  write(tree, MODULE_FILES, '{"second":true}\n')
  const head = commitAll(tree, 'second card')
  git(tree, ['push', '-q', 'origin', branch])
  write(seed, 'scripts/first.ts', 'first card\n')
  write(seed, MODULE_FILES, '{"first":true}\n')
  commitAll(seed, 'the first card merges')
  git(seed, ['push', '-q', 'origin', 'main'])
  return { tree, origin, branch, head }
}

describe('a generated file the update rebuilds is no overlap at launch', () => {
  it('two cards sharing only contract/module-files.json start at once', () => {
    expect(withoutDerived({ touches: ['scripts/first/**', MODULE_FILES] } as unknown as ShiftTask).touches).toEqual(['scripts/first/**'])
    const bench = twoCardsSharing(MODULE_FILES)
    expect(currentLane(bench.db, 1)).not.toBe(currentLane(bench.db, 2))
    expect(startedCards(bench)).toEqual([1, 2])
    bench.close()
  })

  it('after the first merges the update of the second rebuilds contract/module-files.json and passes without a stop', () => {
    const pr = 1201
    const cardId = pr + 100
    const second = secondCardBehindTheFirst(cardId)
    const bench = liveBench()
    const text = `card: #${cardId} task-${cardId} [implement/construct/S/cheap/owner] · depends — · blocks —\nbranch: ${second.branch}\ntouches: ${OWN}, ${MODULE_FILES}\nwho: shift\n\ndo ${cardId}\n`
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
    bench.gitHub.open({ number: pr, head: second.head, mergeable_state: 'dirty' })
    bench.tick()
    detectUpdate(bench)
    const rebuilds: (readonly string[])[] = []
    const rebuild = (cwd: string, args: readonly string[]) => {
      rebuilds.push(args)
      write(cwd, MODULE_FILES, REBUILT_TEXT)
      return { status: 0, stderr: '' }
    }
    const executor = new UpdateExecutor({ cards: cardTransitions(), source: updateParts(), silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, mergeMain: mainMergeInCardTree(git, () => second.tree, rebuild) })
    const leased: Lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!
    expect(leased).toMatchObject({ queue: 'update', cardId, pr, head: second.head })

    expect(executor.update(leased)).toMatchObject({ kind: 'updated', from: second.head })

    const merged = git(second.tree, ['rev-parse', 'HEAD'])
    expect(rebuilds).toEqual([GENERATED_FILES.moduleFiles.rebuild])
    expect(readFileSync(path.join(second.tree, MODULE_FILES), 'utf8')).toBe(REBUILT_TEXT)
    expect(git(second.origin, ['rev-parse', `refs/heads/${second.branch}`])).toBe(merged)
    expect(eventsOf(bench.db, UPDATE_DONE)).toMatchObject([{ from: second.head, to: merged, rebuilt: [MODULE_FILES] }])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([])
    bench.close()
  })

  it('two cards sharing a hand-written file start one at a time', () => {
    startsOneAtATime(HAND_WRITTEN)
  })

  it('two cards sharing only .dependency-cruiser-known-violations.json, a generated row the shared-file declaration names, start at once', () => {
    expect(KNOWN_VIOLATIONS).toBe('.dependency-cruiser-known-violations.json')
    expect(sharedAppendFiles()).toContain(KNOWN_VIOLATIONS)
    const bench = twoCardsSharing(KNOWN_VIOLATIONS)
    expect(currentLane(bench.db, 1)).not.toBe(currentLane(bench.db, 2))
    expect(startedCards(bench)).toEqual([1, 2])
    bench.close()
  })
})
