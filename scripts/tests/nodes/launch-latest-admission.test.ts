import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { LaunchNodeParts } from '../../nodes/launch/launch-worker.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_VERIFIED, CARD_WAITING } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { AMENDED_AFTER_START, LaunchNode } from '../../nodes/launch/launch-worker.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1781
const LANE = 'lane-1'
const ADMITTED = 'The text admitted at 14:59.'
const AMENDED = 'The widening amended at 15:35.'
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

function bodyOf(prose: string, kind = 'implement', decision = 'auto'): string {
  return `card: #${CARD} a-card [${kind}/construct/S/cheap/${decision}] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\n${prose}\n`
}

function admit(made: MergeBench, key: string, text?: string): void {
  const body = text === undefined ? {} : { text, textSha: textSha(text) }
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${key}`, payload: { card: `#${CARD}`, lane: LANE, decision: 'auto', contour: 'cheap', depends: [], admission: key, ...body }, legacy: false })
}

class Starter implements CardStarter, SessionContinuer {
  continued = 0

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c${this.continued}` } }
  }
}

function launchNode(made: MergeBench, starter: Starter, extra: Partial<LaunchNodeParts> = {}): LaunchNode {
  return new LaunchNode({ db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, pidAlive: () => false, machine: new MachineSessions(scratchDir('launch-latest-machine-'), () => false, 16), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), ...extra })
}

async function runOnce(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

describe('launch takes the card body from the latest card.admitted, never from a fold behind it', () => {
  it('a launch after an amend starts on the amended body', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      made.tick()
      const starter = new Starter()
      const handoffs: (string | null)[] = []
      const node = launchNode(made, starter, { collected: () => null, atContextLine: () => true, handedOff: () => handoffs.length > 0, buildHandoff: (_card, _start, body) => handoffs.push(body) })
      await runOnce(node)
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      made.tick()
      admit(made, 'admission-2', bodyOf(AMENDED))
      expect(cardBodyText(made.db, CARD)).toContain(ADMITTED)
      node.stopOverdue()
      expect(handoffs.length).toBeGreaterThan(0)
      expect(handoffs.every(body => body?.includes(AMENDED) === true)).toBe(true)
      expect(starter.continued).toBe(0)
    }
    finally {
      made.close()
    }
  })

  it('a session amended twice after its start waits naming the body it started on, not the first amend', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      made.tick()
      const starter = new Starter()
      const node = launchNode(made, starter, { pidAlive: () => true, processes: { commandLine: () => `session s-${CARD}`, signalGroup: () => {} } })
      await runOnce(node)
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      made.tick()
      admit(made, 'admission-2', bodyOf(AMENDED))
      made.tick()
      admit(made, 'admission-3', bodyOf(`${AMENDED} Again.`))
      node.stopOverdue()
      expect(eventsOf(made.db, CARD_WAITING)).toMatchObject([{ reason: AMENDED_AFTER_START, started: textSha(bodyOf(ADMITTED)), amended: textSha(bodyOf(`${AMENDED} Again.`)) }])
    }
    finally {
      made.close()
    }
  })

  it('a session whose two amends after its start differ only in the header priority does not wait', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      made.tick()
      const starter = new Starter()
      const node = launchNode(made, starter, { pidAlive: () => true, processes: { commandLine: () => `session s-${CARD}`, signalGroup: () => {} } })
      await runOnce(node)
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      made.tick()
      admit(made, 'admission-2', bodyOf(AMENDED))
      made.tick()
      admit(made, 'admission-3', bodyOf(ADMITTED).replace('who: shift\n', 'who: shift\npriority: p0\n'))
      node.stopOverdue()
      expect(eventsOf(made.db, CARD_WAITING)).toEqual([])
    }
    finally {
      made.close()
    }
  })

  it('a fresh launch waits for an amended body that a later admission without a text would hide', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      admit(made, 'admission-2', bodyOf(AMENDED))
      made.tick()
      admit(made, 'admission-3', bodyOf(`${AMENDED} Again.`))
      admit(made, 'admission-4')
      const starter = new Starter()
      await runOnce(launchNode(made, starter))
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(0)
      made.tick()
      await runOnce(launchNode(made, starter))
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      expect(cardBodyText(made.db, CARD)).toContain(`${AMENDED} Again.`)
    }
    finally {
      made.close()
    }
  })

  it('a relaunch after the usage limit reset starts on the body amended while the session waited', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      made.tick()
      const starter = new Starter()
      const handoffs: (string | null)[] = []
      const reset = new Date(made.clock.now().getTime() + 3_600_000).toISOString()
      const node = launchNode(made, starter, { resulted: () => false, collected: () => 'report-missing: no report was written', usageLimitedUntil: () => reset, handedOff: () => handoffs.length > 0, buildHandoff: (_card, _start, body) => handoffs.push(body) })
      await runOnce(node)
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      made.tick()
      node.stopOverdue()
      expect(eventsOf(made.db, CARD_WAITING).some(wait => wait.reason === 'usage-limit')).toBe(true)
      admit(made, 'admission-2', bodyOf(AMENDED))
      expect(cardBodyText(made.db, CARD)).toContain(ADMITTED)
      made.clock.advance(3_600_000 + TICK_MS)
      node.stopOverdue()
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toContain(AMENDED)
    }
    finally {
      made.close()
    }
  })

  it('a session closes as a probe when the latest admission made the card a probe and the fold still holds the older kind', async () => {
    const made = mergeBench()
    try {
      admit(made, 'admission-1', bodyOf(ADMITTED))
      made.tick()
      const starter = new Starter()
      const node = launchNode(made, starter, { continuer: undefined, collected: () => null, atContextLine: () => false, handedOff: () => false, resulted: () => true, reportOf: () => '#1781 a-probe\nno PR\nverification: run\nReport: /probes/r.md\n' })
      await runOnce(node)
      expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
      made.tick()
      admit(made, 'admission-2', bodyOf(AMENDED, 'probe', 'none'))
      expect(cardBodyText(made.db, CARD)).toContain('[implement/')
      node.stopOverdue()
      expect(eventsOf(made.db, CARD_VERIFIED)).toHaveLength(1)
    }
    finally {
      made.close()
    }
  })
})
