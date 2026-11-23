import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { busProjections, cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 2259
const CARD_PR = CARD - 100
const RATCHET = 'contract/ratchet.json'
const AMEND = 'amend'

const benches: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of benches.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function bodyTouching(touches: string, note = 'Do it.'): string {
  return `card: #${CARD} amend-lifts [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/amend-lifts\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\n${note}\n`
}

function admit(made: MergeBench, text: string, generation: string, source?: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${generation}`, payload: { card: `#${CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation, ...(source === undefined ? {} : { source }) }, legacy: false })
  reduce(made.db, 'pending', busProjections())
}

async function stoppedOutsideTheTouches(refused: readonly string[]) {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'amend-lifts-'))
  benches.push({ made, root })
  const worktree = path.join(root, `mc-${CARD}`)
  mkdirSync(worktree)
  admit(made, bodyTouching('src/a.ts'), 'body-1')
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: 'feat/amend-lifts', base: sha('1') }, legacy: false })
  made.gitHub.open({ number: CARD_PR, required: 'failure', failed: ['lint'] })
  made.tick()
  made.tick()
  const rounds: string[] = []
  const answerer: Answerer = async (request) => {
    if (rounds.push(request.lease.taskKey) === 1)
      throw new AnswerOutsideTouches(request.lease, refused)
    return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null }
  }
  const trees: CardTreeTools = { home: root, exists: existsSync, branchOf: () => 'feat/amend-lifts', recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, liveSession: () => null })
  const lease = (): Lease | null => leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  const outcome = await executor.answer(lease()!)
  made.tick()
  const stop = made.db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(CARD_STOPPED) as { id: number, payload: string }
  return { made, executor, lease, outcome, rounds, stop: { id: Number(stop.id), widen: (JSON.parse(stop.payload) as { widen?: string[] }).widen } }
}

function openStopOn(made: MergeBench): number | null {
  reduce(made.db, 'pending', busProjections())
  return (made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD) as { id: number } | undefined)?.id ?? null
}

function waitStatesOf(made: MergeBench): string[] {
  reduce(made.db, 'pending', busProjections())
  return (made.db.prepare('SELECT state FROM owner_waits WHERE card_id = ? ORDER BY id').all(CARD) as { state: string }[]).map(row => row.state)
}

describe('an amend that answers a question.owner stop lifts it', () => {
  it('an amend that widens the refused paths lifts the outside-touches stop and queues the answer', async () => {
    const run = await stoppedOutsideTheTouches(['package.json', 'scripts/b.ts', RATCHET])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.widen).toEqual(['package.json', 'scripts/b.ts'])
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()

    admit(run.made, bodyTouching('src/a.ts, package.json'), 'body-2', AMEND)
    run.made.tick()
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(waitStatesOf(run.made)).toEqual(['open'])
    expect(run.lease()).toBeNull()

    admit(run.made, bodyTouching('src/a.ts, package.json, scripts/b.ts'), 'body-3', AMEND)
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBeNull()
    expect(waitStatesOf(run.made)).toEqual(['closed'])
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: CARD, pr: CARD_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(run.rounds).toHaveLength(2)
  })

  it('an amend that closes the wait of a stop answers the stop without naming it', async () => {
    const run = await stoppedOutsideTheTouches([RATCHET])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.widen).toBeUndefined()
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
    const waitsAtTheStop = eventsOf(run.made.db, OWNER_WAIT_OPENED).length

    admit(run.made, bodyTouching('src/a.ts', 'Do it; the ratchet stays as it is.'), 'body-2', AMEND)
    run.made.tick()
    run.made.tick()

    expect(waitStatesOf(run.made)).toEqual(['closed'])
    expect(openStopOn(run.made)).toBeNull()
    expect(eventsOf(run.made.db, OWNER_WAIT_OPENED)).toHaveLength(waitsAtTheStop)
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: CARD, pr: CARD_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
  })

  it('a stop whose refused paths an amend does not cover still holds the card', async () => {
    const run = await stoppedOutsideTheTouches(['package.json', 'scripts/b.ts'])

    admit(run.made, bodyTouching('src/a.ts, package.json'), 'body-2', AMEND)
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
  })
})
