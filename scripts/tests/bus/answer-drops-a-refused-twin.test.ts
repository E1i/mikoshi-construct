import type { Lease } from '../../core/lease.js'
import type { AnswerTwins } from '../../nodes/answer/answer-executor.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT, TOUCHES_FOLLOWED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor, REGENERATED_TWIN } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 2295
const TOUCHED = 'scripts/nodes/answer/answer-executor.ts'
const SOURCE_OUTSIDE = 'scripts/core/card-bodies.ts'
const FACTORY = 'contract/factory.json'
const RATCHET = 'contract/ratchet.json'
const QUESTION_OWNER = 'question.owner'
const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  benches.splice(0).forEach(made => made.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface FakeTree {
  files: Map<string, string | null>
  commits: () => number
  twins: AnswerTwins
}

function fakeTree(base: Record<string, string>, left: Record<string, string>, generated: (file: string, run: number) => string): FakeTree {
  const files = new Map<string, string | null>(Object.entries({ ...base, ...left }))
  let runs = 0
  let commits = 0
  const twins: AnswerTwins = {
    tree: () => ({
      drop: dropped => dropped.forEach(file => files.set(file, base[file] ?? null)),
      reading: () => ({
        current: file => files.get(file) ?? null,
        base: file => base[file] ?? null,
        rerun: (_command, outputs) => {
          runs += 1
          return { kind: 'ran', outputs: new Map(outputs.map(file => [file, file in base ? generated(file, runs) : files.get(file) ?? null])) }
        },
      }),
      write: (file, text) => files.set(file, text),
    }),
    commit: () => {
      commits += 1
      return sha('b')
    },
  }
  return { files, commits: () => commits, twins }
}

interface Bench {
  made: MergeBench
  executor: AnswerExecutor
}

function bench(refused: readonly string[], changed: readonly string[], tree: FakeTree): Bench {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'twin-tree-'))
  roots.push(trees)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} a-card [implement/construct/L/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: auto\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  made.tick()
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: 'a question' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  made.tick()
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer: async (request) => {
    throw new AnswerOutsideTouches(request.lease, refused)
  }, ownerMerges: () => '', clock: made.clock.now, trees: { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null, prepare: () => {}, changedInTheTree: () => [...changed], twins: tree.twins })
  return { made, executor }
}

async function answerOnce(run: Bench): Promise<void> {
  await run.executor.answer(leaseNext(run.made.db, pullRequests(run.made.db), run.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease)
  run.made.tick()
}

function stopsAfterTheFirst(run: Bench): Record<string, unknown>[] {
  return eventsOf(run.made.db, CARD_STOPPED).slice(1)
}

describe('the answer node drops a refused generated twin and regenerates it', () => {
  it('the answer node drops a refused contract/factory.json, regenerates it from the sources in the touches and opens no owner wait', async () => {
    const tree = fakeTree({ [FACTORY]: '{"v":1}\n' }, { [FACTORY]: '{"v":"hand"}\n' }, () => '{"v":2}\n')
    const run = bench([FACTORY], [TOUCHED, FACTORY], tree)

    await answerOnce(run)

    expect(stopsAfterTheFirst(run)).toEqual([])
    expect(tree.files.get(FACTORY)).toBe('{"v":2}\n')
    expect(tree.commits()).toBe(1)
    expect(eventsOf(run.made.db, TOUCHES_FOLLOWED).at(-1)).toMatchObject({ paths: [FACTORY] })
    expect(eventsOf(run.made.db, CARD_ANSWERED).at(-1)).toMatchObject({ source: REGENERATED_TWIN, to: sha('b'), regenerated: [FACTORY] })
  })

  it('a regenerated twin whose generator does not reproduce it names the source outside the touches to the window', async () => {
    const tree = fakeTree({ [FACTORY]: '{"v":1}\n' }, { [FACTORY]: '{"v":"hand"}\n' }, (_file, run) => `{"v":${run}}\n`)
    const run = bench([FACTORY], [TOUCHED, SOURCE_OUTSIDE, FACTORY], tree)

    await answerOnce(run)

    const stops = stopsAfterTheFirst(run)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({ reason: QUESTION_AGENT, widen: [SOURCE_OUTSIDE] })
    expect(String(stops[0]!.detail)).toContain(SOURCE_OUTSIDE)
    expect(tree.commits()).toBe(0)
  })

  it('a ratchet row the answer grows still stops for the owner', async () => {
    const tree = fakeTree({ [RATCHET]: '{"lines:x":1}\n' }, { [RATCHET]: '{"lines:x":2}\n' }, () => '{"lines:x":2}\n')
    const run = bench([RATCHET], [TOUCHED, RATCHET], tree)

    await answerOnce(run)

    const stops = stopsAfterTheFirst(run)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({ reason: QUESTION_OWNER })
    expect(String(stops[0]!.detail)).toContain(RATCHET)
    expect(tree.commits()).toBe(0)
  })
})
