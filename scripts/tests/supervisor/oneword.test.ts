import type { DatabaseSync } from 'node:sqlite'
import type { ModeParts } from '../../supervisor/start.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decisionsFileOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { OWNER_WAIT_OPENED, REVIEW_RECORDED, SHARD_ISSUED, SHARD_REVOKED } from '../../core/events.js'
import { LIVE_FLAG } from '../../core/node.js'
import { reduce } from '../../core/reducer.js'
import { MERGE_QUEUE } from '../../nodes/merge/merge-executor.js'
import { MergeNode } from '../../nodes/merge/merge-worker.js'
import { sayToOwnerChannel } from '../../owner/channel.js'
import { decisionsIntake } from '../../policy/decisions-import.js'
import { allowLiveCommand, liveDecisionOf } from '../../policy/live-decision.js'
import { activeWindowShards, decisionsInForceAt, windowShardEnded } from '../../policy/shards.js'
import { busDecisionsAdder, busDecisionsText, ghostProtocolWord, runMode, startCommandOf } from '../../supervisor/start.js'
import { liveWorkers, returnToWindowAtTermEnd, switchDetection, switchedOn, switchWorker, termEndOf, wantedLaunches } from '../../supervisor/workers.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const NOW = new Date('2026-10-29T12:00:00.000Z')
const HOURS = '8'
const TERM_END = new Date('2026-10-29T20:00:00.000Z')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  busDb: string
  parts: ModeParts
  onBus: <T>(read: (db: DatabaseSync) => T) => T
}

function bench(decisionsUnreadable = false): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'oneword-'))
  roots.push(root)
  const busDb = path.join(root, 'bus', 'bus.db')
  mkdirSync(path.dirname(busDb), { recursive: true })
  if (decisionsUnreadable)
    mkdirSync(decisionsFileOf(busDb))
  const onBus = <T>(read: (db: DatabaseSync) => T): T => {
    const db = openBus(busDb)
    try {
      return read(db)
    }
    finally {
      db.close()
    }
  }
  const channel = path.join(root, 'answers')
  sayToOwnerChannel(channel, ghostProtocolWord(Number(HOURS)), NOW)
  return {
    busDb,
    onBus,
    parts: {
      busDir: path.join(root, 'bus', 'workers'),
      channel,
      now: () => NOW,
      uuid: () => 'shard-1',
      record: event => onBus(db => appendEvent(db, event)),
      activeWindows: now => onBus(db => activeWindowShards(db, now)),
      addDecision: busDecisionsAdder(busDb, () => NOW),
      decisionsText: busDecisionsText(busDb),
    },
  }
}

function command(...argv: string[]) {
  const parsed = startCommandOf(argv)
  if (parsed === null || parsed.kind === 'start')
    throw new Error(`${argv.join(' ')} is not a mode command`)
  return parsed
}

function ghostProtocol(parts: ModeParts) {
  return runMode(command('--mode', 'ghost-protocol', '--hours', HOURS), parts)
}

function liveScripts(busDir: string, now: Date = NOW): string[] {
  return wantedLaunches(busDir, () => [], [], now).filter(launch => launch.args.includes(LIVE_FLAG)).map(launch => launch.script)
}

describe('oneword: the ghost-protocol word is the only owner word', () => {
  it('ghost-protocol with a shard seeds merge and update live', () => {
    const { parts, onBus } = bench()
    runMode(command('--mode', 'window'), parts)

    const result = ghostProtocol(parts)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(onBus(db => activeWindowShards(db, NOW)).map(shard => shard.id)).toEqual(['shard-1'])
    expect(liveWorkers(parts.busDir)).toEqual(expect.arrayContaining(['merge', 'update']))
    expect(liveScripts(parts.busDir)).toEqual(expect.arrayContaining(['bus:merge', 'bus:update']))
    onBus(db => reduce(db))
    const decisions = onBus(db => decisionsInForceAt(db, NOW))
    expect(liveDecisionOf(decisions, 'merge')).not.toBeNull()
    expect(liveDecisionOf(decisions, 'update')).not.toBeNull()
    expect(liveDecisionOf(onBus(db => decisionsInForceAt(db, TERM_END)), 'merge')).toBeNull()
  })

  it('ghost-protocol seeds close and restart live', () => {
    const { parts } = bench()

    expect(ghostProtocol(parts).exitCode).toBe(0)

    expect(switchedOn(parts.busDir)).toEqual(expect.arrayContaining(['close', 'restart']))
    expect(liveWorkers(parts.busDir)).toEqual(switchedOn(parts.busDir))
    expect(liveScripts(parts.busDir)).toEqual(expect.arrayContaining(['bus:close', 'bus:restart']))
  })

  it('an early return to window ends the live merge and update decisions with the shard', () => {
    const { parts, onBus, busDb } = bench()
    ghostProtocol(parts)
    const liveAfterImport = (): (number | null)[] => onBus((db) => {
      decisionsIntake(db, decisionsFileOf(busDb), () => NOW)()
      reduce(db)
      const decisions = decisionsInForceAt(db, NOW)
      return [liveDecisionOf(decisions, 'merge'), liveDecisionOf(decisions, 'update')]
    })
    expect(liveAfterImport()).not.toContain(null)

    const result = runMode(command('--mode', 'window'), parts)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(onBus(db => activeWindowShards(db, NOW))).toEqual([])
    expect(liveAfterImport()).toEqual([null, null])
  })

  it('a window to window switch takes a worker it switches off out of live', () => {
    const { parts } = bench()
    runMode(command('--mode', 'window'), parts)
    switchWorker(parts.busDir, 'merge', true)
    switchDetection(parts.busDir, 'merge', true)

    runMode(command('--mode', 'window'), parts)
    switchWorker(parts.busDir, 'merge', true)

    expect(liveWorkers(parts.busDir)).not.toContain('merge')
  })

  it('the return to window at the term end leaves no switched-off worker live, so merge switched on later is in shadow', () => {
    const { parts } = bench()
    ghostProtocol(parts)

    expect(returnToWindowAtTermEnd(parts.busDir, new Date(Date.parse(termEndOf(parts.busDir)!) + 1))).toBe(true)
    switchWorker(parts.busDir, 'merge', true)

    expect(liveWorkers(parts.busDir)).not.toContain('merge')
    expect(liveScripts(parts.busDir, TERM_END)).not.toContain('bus:merge')
  })

  it('a live decision that could not be written is named and the mode stays switched', () => {
    const { parts } = bench(true)

    const result = ghostProtocol(parts)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('allow-live merge was not written')
    expect(result.stderr.join('\n')).toContain('allow-live update was not written')
    expect(liveWorkers(parts.busDir)).toEqual(expect.arrayContaining(['merge', 'update']))
  })
})

describe('oneword: the merge node asks for no second word under the owner\'s shard', () => {
  const merges: MergeBench[] = []

  afterEach(() => {
    for (const made of merges.splice(0))
      made.close()
  })

  function passedPullRequest(): MergeBench {
    const made = mergeBench()
    merges.push(made)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    return made
  }

  function windowShard(made: MergeBench, ended: boolean): void {
    const ts = made.clock.now().toISOString()
    const until = new Date(Date.parse(ts) + Number(HOURS) * 3_600_000).toISOString()
    appendEvent(made.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:window-1`, payload: { id: 'window-1', by: 'owner', run: null, window: true, scope: MERGE_QUEUE, until }, legacy: false })
    if (ended)
      appendEvent(made.db, windowShardEnded(SHARD_REVOKED, 'policy', 'window-1', made.clock.now()))
  }

  async function liveMergeRounds(made: MergeBench): Promise<void> {
    made.gitHub.open({ number: 970, review: 'success' })
    made.tick()
    const node = new MergeNode({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: {} })
    for (let round = 0; round < 3; round += 1) {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    }
  }

  it('a live merge under the owner\'s ghost-protocol shard opens no allow-live wait', async () => {
    const made = passedPullRequest()
    windowShard(made, false)

    await liveMergeRounds(made)

    expect(eventsOf(made.db, OWNER_WAIT_OPENED).filter(wait => wait.command === allowLiveCommand(MERGE_QUEUE))).toEqual([])
  })

  it('a live merge after the shard is revoked asks for allow-live again', async () => {
    const made = passedPullRequest()
    windowShard(made, true)

    await liveMergeRounds(made)

    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual(expect.arrayContaining([expect.objectContaining({ need: 'command', command: allowLiveCommand(MERGE_QUEUE) })]))
  })
})
