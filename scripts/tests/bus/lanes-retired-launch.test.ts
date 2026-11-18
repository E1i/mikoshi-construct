import type { MachineReader } from '../../nodes/launch/launch-candidates.js'
import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { LaunchNodeParts } from '../../nodes/launch/launch-worker.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, POLICY_DENIED } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { launchableCard, launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { busProjections, nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratchDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function bodyOf(cardId: number, touches: string, depends = '—'): string {
  return `card: #${cardId} a-card [implement/construct/S/cheap/auto] · depends ${depends} · blocks —\nbranch: feat/card-${cardId}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nThe card.\n`
}

function admit(made: MergeBench, cardId: number, lane: string | null, touches: string, depends: number[] = []): void {
  const text = bodyOf(cardId, touches, depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', '))
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: `#${cardId}`, lane, decision: 'auto', contour: 'cheap', depends, admission: `admission-${cardId}`, text, textSha: textSha(text) }, legacy: false })
}

class Starter implements CardStarter {
  readonly started: QueuedCard[] = []

  start(card: QueuedCard): CardStart {
    this.started.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

function launchNode(made: MergeBench, starter: Starter, extra: Partial<LaunchNodeParts> = {}): LaunchNode {
  return new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, pidAlive: () => false, machine: new MachineSessions(scratchDir('lanes-retired-machine-'), () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), ...extra })
}

async function runOnce(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
}

const FREE_MACHINE: MachineReader = { free: () => 4, held: () => null, waiting: () => [] }

function candidates(made: MergeBench): number[] {
  reduce(made.db, 'pending', busProjections())
  return launchCandidates(made.db, () => false, () => made.clock.now().getTime(), () => {}, [], () => 4, FREE_MACHINE).map(candidate => candidate.cardId)
}

describe('launch no longer needs a lane', () => {
  it('launch takes an admitted card with no lane', async () => {
    const made = mergeBench()
    try {
      admit(made, 2101, null, 'scripts/a.ts')
      made.tick()
      expect(launchableCard(made.db, 2101)).toEqual({ lane: null, contour: 'cheap' })
      const starter = new Starter()
      await runOnce(launchNode(made, starter))
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      expect(eventsOf(made.db, POLICY_DENIED)).toEqual([])
      expect(starter.started.map(card => card.cardId)).toEqual([2101])
    }
    finally {
      made.close()
    }
  })

  it('launch still takes a card that carries a lane', async () => {
    const made = mergeBench()
    try {
      admit(made, 2102, 'lane-1', 'scripts/b.ts')
      made.tick()
      expect(launchableCard(made.db, 2102)).toEqual({ lane: 'lane-1', contour: 'cheap' })
      const starter = new Starter()
      await runOnce(launchNode(made, starter))
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      expect(starter.started).toMatchObject([{ cardId: 2102, lane: 'lane-1' }])
    }
    finally {
      made.close()
    }
  })

  it('a lane-less card is selected without any lane laid, and waits on a dependency that is not merged', () => {
    const made = mergeBench()
    try {
      admit(made, 2103, null, 'scripts/c.ts')
      admit(made, 2104, null, 'scripts/d.ts', [2103])
      expect(candidates(made)).toEqual([2103])
    }
    finally {
      made.close()
    }
  })

  it('two lane-less cards on the same touches start one at a time, the first admitted first', () => {
    const made = mergeBench()
    try {
      admit(made, 2105, null, 'scripts/e.ts')
      admit(made, 2106, null, 'scripts/e.ts')
      admit(made, 2107, null, 'scripts/f.ts')
      expect(candidates(made)).toEqual([2105, 2107])
    }
    finally {
      made.close()
    }
  })
})
