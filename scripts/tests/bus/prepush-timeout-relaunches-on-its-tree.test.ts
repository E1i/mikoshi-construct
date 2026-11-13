import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED, OWNER_WAIT_OPENED, WINDOW_REQUEST } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { LaunchNode, PREPUSH_TIMEOUT, prepushTimedOutOverGreenWitnesses, SESSION_DEATH_CAP } from '../../nodes/launch/launch-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1749
const GREEN_TIMEOUT = 'W1 and W2 pass, typecheck and lint green; prepush timed out at 600 s under load, so nothing was pushed'
const RED_WITNESS = 'W1 fails on its assertion; prepush timed out at 600 s under load'
const NO_TIMEOUT = 'W1 and W2 pass; prepush red on scripts/tests/bus/launch-node.test.ts'

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

class TreeStarter implements CardStarter {
  starts: QueuedCard[] = []

  constructor(private readonly worktree: string) {}

  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}-${this.starts.length}`, worktree: this.worktree, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

interface Ended {
  made: MergeBench
  worktree: string
  node: LaunchNode
  starter: TreeStarter
  run: () => Promise<void>
}

async function sessionThatEnded(result: string, report = `#${CARD} a-card\nresult: ${result}\n`): Promise<Ended> {
  const made = mergeBench()
  benches.push(made)
  const machineDir = mkdtempSync(path.join(tmpdir(), 'prepush-timeout-'))
  roots.push(machineDir)
  const text = parkingFileText({ card: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: ['scripts/nodes/launch/**'], continue: 'auto', who: 'shift', body: 'the card' })
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}`, text, textSha: textSha(text) }, legacy: false })
  made.tick()
  const worktree = mkdtempSync(path.join(tmpdir(), 'prepush-tree-'))
  roots.push(worktree)
  const starter = new TreeStarter(worktree)
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, resulted: () => true, handedOff: () => false, reportOf: () => report, committed: () => false, machine: new MachineSessions(machineDir, () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  const run = async (): Promise<void> => {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
  }
  await run()
  return { made, worktree, node, starter, run }
}

function readmissions(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, CARD_ADMITTED).filter(admitted => String(admitted.admission).startsWith(`${PREPUSH_TIMEOUT}:`))
}

describe('a session that ends with no pull request on a prepush timeout over green witnesses', () => {
  it('queues its launch task again on the tree as it stands, with no board alarm and no window request', async () => {
    const { made, worktree, node, starter, run } = await sessionThatEnded(GREEN_TIMEOUT)
    expect(starter.starts).toHaveLength(1)

    expect(node.stopOverdue()).toEqual([CARD])
    made.tick()

    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', code: PREPUSH_TIMEOUT, detail: expect.stringContaining(`${worktree} as it stands`) })])
    expect(readmissions(made)).toEqual([expect.objectContaining({ lane: 'lane-a', contour: 'cheap' })])
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])
    expect(eventsOf(made.db, WINDOW_REQUEST)).toEqual([])
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])

    await run()
    expect(starter.starts.map(card => card.cardId)).toEqual([CARD, CARD])
    expect(starter.starts[1]?.continueIn).toEqual(expect.objectContaining({ worktree }))
  })

  it('stops with a board alarm once the relaunches reach the cap', async () => {
    const { made, node, run } = await sessionThatEnded(GREEN_TIMEOUT)
    for (let relaunch = 0; relaunch < SESSION_DEATH_CAP; relaunch++) {
      expect(node.stopOverdue()).toEqual([CARD])
      made.tick()
      await run()
    }
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])

    expect(node.stopOverdue()).toEqual([CARD])
    made.tick()

    expect(eventsOf(made.db, CARD_STOPPED).filter(stop => stop.code === PREPUSH_TIMEOUT)).toHaveLength(SESSION_DEATH_CAP)
    expect(eventsOf(made.db, BOARD_ALARM)).toHaveLength(1)
  })

  it('a red witness or no timeout stays a stop with a board alarm', async () => {
    for (const result of [RED_WITNESS, NO_TIMEOUT]) {
      const { made, node } = await sessionThatEnded(result)
      expect(node.stopOverdue()).toEqual([CARD])
      made.tick()
      expect(readmissions(made)).toEqual([])
      expect(eventsOf(made.db, BOARD_ALARM)).toHaveLength(1)
    }
  })

  it('a question that is not about the timeout still stops on the question', async () => {
    const { made, node } = await sessionThatEnded(GREEN_TIMEOUT, `#${CARD} a-card\nresult: ${GREEN_TIMEOUT}\nquestion: does the owner want the flag renamed?\n`)
    expect(node.stopOverdue()).toEqual([CARD])
    made.tick()
    expect(readmissions(made)).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'question.agent' })])
  })

  it('reads green witnesses and a prepush timeout from the result line', () => {
    expect(prepushTimedOutOverGreenWitnesses(GREEN_TIMEOUT)).toBe(true)
    expect(prepushTimedOutOverGreenWitnesses('the witnesses are green; pre-push timed out under load')).toBe(true)
    expect(prepushTimedOutOverGreenWitnesses('свидетели зелёные, prepush: таймаут под нагрузкой')).toBe(true)
    expect(prepushTimedOutOverGreenWitnesses(RED_WITNESS)).toBe(false)
    expect(prepushTimedOutOverGreenWitnesses(NO_TIMEOUT)).toBe(false)
    expect(prepushTimedOutOverGreenWitnesses('W1 passes; vitest timed out')).toBe(false)
  })
})
