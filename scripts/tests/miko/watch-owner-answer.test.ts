import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, closeOwnerWait, openOwnerWait } from '../../core/db.js'
import { CARD_STARTED, CARD_WAITING, DECISION_RECORDED, OWNER_WAIT_CLOSED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { runOwnerAnswer } from '../../owner/answer.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { decisionsAdderOfBus, decisionsSettlerOfBus } from '../../policy/decisions/projection.js'
import { busProjections, DECISION_EVENT_READS } from '../../supervisor/composition.js'
import { productionDeps, selectOnce } from '../../window/watch.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { liveBench } from '../bus/merge-bench.js'

const CARD = 1951
const PR = 1650
const OTHER = 1952
const HEAD = sha('a')
const ACTOR = 'worker:test:watch-owner-answer'

interface Room {
  bench: MergeBench
  root: string
  channel: string
}

const rooms: Room[] = []

afterEach(() => {
  for (const { bench, root } of rooms.splice(0)) {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function room(): Room {
  const bench = liveBench()
  const root = mkdtempSync(path.join(tmpdir(), 'watch-owner-answer-'))
  const made = { bench, root, channel: path.join(root, 'owner-answers') }
  rooms.push(made)
  writeFileSync(decisionsFileOf(bench.busPath), '')
  bench.gitHub.open({ number: PR, head: HEAD, body: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —` })
  bench.tick()
  return made
}

function now(at: Room): string {
  return at.bench.clock.now().toISOString()
}

function refuse(): never {
  throw new Error('an answer uses no other tool')
}

function tools(at: Room): RequestTools {
  return { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdderOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, DECISION_EVENT_READS), settleDecisions: decisionsSettlerOfBus(at.bench.db, at.bench.busPath, at.bench.clock.now, busProjections(), DECISION_EVENT_READS), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
}

function ownerAnswers(at: Room, named: string, words: string): void {
  expect(runOwnerAnswer([named, words], at.bench.db, at.channel, at.bench.clock.now(), () => {}, requestFromWindow)).toBe(0)
  reduce(at.bench.db, 'pending', busProjections())
  const outcomes = new WindowRequests(at.bench.db, at.bench.clock.now, tools(at), at.channel, () => null, process.cwd(), at.bench.gitHub.client).run()
  reduce(at.bench.db, 'pending', busProjections())
  expect(outcomes.map(outcome => outcome.kind), JSON.stringify(outcomes)).toEqual(['done'])
}

function cardEvent(at: Room, card: number, type: string, key: string): void {
  appendEvent(at.bench.db, { ts: now(at), type, actor: ACTOR, cardId: card, pr: null, head: null, dedupeKey: `${type}:${card}:${key}`, payload: { reason: key }, legacy: false })
  reduce(at.bench.db, 'pending', busProjections())
}

function decide(at: Room, decisionId: number, cards: number[]): void {
  recordDecision(at.bench.db, { ts: now(at), decisionId, text: `the owner's word ${decisionId}`, cards })
  reduce(at.bench.db, 'pending', busProjections())
}

function cursorOf(at: Room): number {
  return productionDeps(at.root, at.bench.busPath).lastBusId()
}

function watchOnce(at: Room, from: number, card?: number): string | null | undefined {
  return selectOnce({ offset: 0, busId: from }, productionDeps(at.root, at.bench.busPath), card)?.line
}

const ANSWER_LINE = new RegExp(`^bus (${OWNER_WAIT_CLOSED}|${DECISION_RECORDED}) card ${CARD} `)

describe('miko:watch wakes the window when the owner answers a wait it handed over', () => {
  it('owner:answer on a card wait wakes miko:watch --once with that event', () => {
    const at = room()
    const wait = openOwnerWait(at.bench.db, now(at), 'policy', { need: 'decision', text: `card #${CARD} waits for the owner`, card: CARD, pr: PR })
    reduce(at.bench.db, 'pending', busProjections())
    const from = cursorOf(at)

    ownerAnswers(at, wait, 'take the second path')

    expect(watchOnce(at, from)).toMatch(ANSWER_LINE)
    expect(watchOnce(at, from, CARD)).toMatch(ANSWER_LINE)
    expect(watchOnce(at, from, OTHER)).toBeFalsy()
  })

  it('a decision on a card in card.waiting wakes miko:watch --once with decision.recorded', () => {
    const at = room()
    cardEvent(at, CARD, CARD_WAITING, 'ladder-approval')
    const from = cursorOf(at)

    decide(at, 9001, [CARD])

    expect(watchOnce(at, from)).toMatch(new RegExp(`^bus ${DECISION_RECORDED} card ${CARD} `))
  })

  it('a decision on a card with no open wait does not wake the watch', () => {
    const at = room()
    const loose = openOwnerWait(at.bench.db, now(at), 'policy', { need: 'decision', text: 'a wait of no card' })
    const answered = openOwnerWait(at.bench.db, now(at), 'policy', { need: 'decision', text: `card #${OTHER} waits for the owner`, card: OTHER })
    reduce(at.bench.db, 'pending', busProjections())
    closeOwnerWait(at.bench.db, now(at), 'owner', answered, 'answered before', 1)
    cardEvent(at, OTHER, CARD_WAITING, 'ladder-approval')
    cardEvent(at, OTHER, CARD_STARTED, 'started again')
    const from = cursorOf(at)

    decide(at, 9002, [CARD])
    decide(at, 9003, [OTHER])
    decide(at, 9004, [])
    closeOwnerWait(at.bench.db, now(at), 'owner', loose, 'closed with no card', 2)
    closeOwnerWait(at.bench.db, now(at), 'owner', answered, 'closed twice', 3)
    reduce(at.bench.db, 'pending', busProjections())

    expect(watchOnce(at, from)).toBeFalsy()
  })
})
