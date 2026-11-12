import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RISK_LEVELS } from '../../../src/card/risk.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { CARD_STOPPED, QUESTION_OWNER, SHARD_ISSUED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { OWNER_EVEN_UNDER_THE_DECISION } from '../../policy/policy.js'
import { AGENT_QUESTION, cardDecisionCommand, deciderUnderAShard, DECISIONS_SCOPE, DROPPED_WITNESS, OWNER_DECIDES, OWNERS_OF_A_STOP, OWNERS_UNDER_ANY_SHARD, STOP_DECIDERS_UNDER_A_SHARD, STOP_KINDS, stopKindOf, WINDOW_DECIDES, WITNESS_MOVED, witnessMoved } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1743

const ASKED_BY_KIND: Readonly<Record<string, string>> = {
  'version-pr': 'may the version pull request go out now?',
  'npm-stage': 'may the npm stage run?',
  'security-invariants': 'may I edit architecture/security-invariants.md?',
  'claude-config': 'may I edit .claude/rules/tests.md?',
  'owner-merges': 'may I edit owner-merges?',
  'workflows': 'may I edit .github/workflows/ci.yml?',
  [DROPPED_WITNESS]: 'may I drop the witness W2 of this card?',
  [WITNESS_MOVED]: 'the witness W2 moved to card #1775 with law 2; may this card go on without it?',
  'outside-touches': 'scripts/a.ts is outside the touches; may it widen?',
  [AGENT_QUESTION]: 'may the retry back off?',
}

const rooms: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of rooms.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function windowClosesTheStopOn(question: string): { kind: string, detail: string } {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'autonomy-stops-'))
  rooms.push({ made, root })
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'owner', scope: DECISIONS_SCOPE, until: new Date(made.clock.now().getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
  const wait = openBusWait(made.db, ts, 'worker:answer:s1', { need: 'decision', text: `card #${CARD} asks: ${question}`, command: cardDecisionCommand(CARD), card: CARD })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:first`, payload: { reason: QUESTION_OWNER, detail: question }, legacy: false })
  reduce(made.db, 'pending', busProjections())
  const refuse = (): never => {
    throw new Error('not this request')
  }
  expect(runRequest(['owner.wait.close', '--id', wait, '--answer', 'go on'], made.db, made.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(made.db, made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, path.join(root, 'owner-answers')).run()
  return outcome!
}

describe('autonomy stops under a shard', () => {
  it('every stop kind has one decider under a shard in the contract table', () => {
    expect(Object.keys(STOP_DECIDERS_UNDER_A_SHARD).sort()).toEqual(Object.keys(STOP_KINDS).sort())
    expect(Object.keys(ASKED_BY_KIND).sort()).toEqual(Object.keys(STOP_KINDS).sort())
    for (const [name, decider] of Object.entries(STOP_DECIDERS_UNDER_A_SHARD)) {
      expect([OWNER_DECIDES, WINDOW_DECIDES]).toContain(decider)
      expect(RISK_LEVELS).toContain(STOP_KINDS[name]!.risk)
      expect(stopKindOf(ASKED_BY_KIND[name]!)).toBe(name)
      expect(deciderUnderAShard(ASKED_BY_KIND[name]!)).toBe(decider)
    }
    expect(Object.keys(OWNERS_OF_A_STOP).every(name => STOP_DECIDERS_UNDER_A_SHARD[name] === OWNER_DECIDES)).toBe(true)
    expect(Object.keys(OWNERS_UNDER_ANY_SHARD).every(name => name in OWNERS_OF_A_STOP)).toBe(true)
  })

  it('a witness moved to another card is not held as a downgrade', () => {
    for (const moved of [
      'the witness W2 moved to card #1775 with law 2; may this card go on without it?',
      'move the witness W2 to card #1775 with law 2.',
      'the witness is carried into the node-contract-suite.',
      'the witness W2 moved to card #1775; the witness W3 stays here.',
    ]) {
      expect(stopKindOf(moved)).toBe(WITNESS_MOVED)
      expect(deciderUnderAShard(moved)).toBe(WINDOW_DECIDES)
    }
    for (const dropped of [
      'may I drop the witness W2 and move the witness W3 to card #1775?',
      'may I drop the witness W2, and it will not move to card #9?',
      'may I drop the witness and move the other witness to card #1775?',
      'drop the witness W2 and move the code to card #1775',
      'drop the witness W2 and move the tests to card #1775',
      'the witness W2 is dropped and the code moved to card #1775.',
      'witness W2 is removed from this card and moved to #1775.',
      'W3 was dropped here: the witness is carried into the node-contract-suite.',
    ]) {
      expect(stopKindOf(dropped)).toBe(DROPPED_WITNESS)
      expect(witnessMoved(dropped)).toBe(false)
      expect(deciderUnderAShard(dropped)).toBe(OWNER_DECIDES)
      expect(windowClosesTheStopOn(dropped).kind).toBe('refused')
    }
    for (const elsewhere of [
      'the witness W2 moved to the end of the list; may the card go on?',
      'move the witness W2 to the top of the file.',
    ]) {
      expect(stopKindOf(elsewhere)).toBe(AGENT_QUESTION)
      expect(deciderUnderAShard(elsewhere)).toBe(WINDOW_DECIDES)
    }
    const lost = 'may I drop the witness W2 of this card? Its law moved to card #1775.'
    expect(stopKindOf(lost)).toBe(DROPPED_WITNESS)
    expect(windowClosesTheStopOn(lost)).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`on ${DROPPED_WITNESS}, which stays the owner's under any shard`) as unknown })
    expect(windowClosesTheStopOn(ASKED_BY_KIND[WITNESS_MOVED]!).kind).toBe('done')
  })

  it('only an R1 stop waits for the owner under a shard', () => {
    for (const [name, kind] of Object.entries(STOP_KINDS)) {
      const r1 = kind.risk === OWNER_EVEN_UNDER_THE_DECISION
      expect(STOP_DECIDERS_UNDER_A_SHARD[name]).toBe(r1 ? OWNER_DECIDES : WINDOW_DECIDES)
      const outcome = windowClosesTheStopOn(ASKED_BY_KIND[name]!)
      expect(outcome.kind).toBe(r1 ? 'refused' : 'done')
      if (r1)
        expect(outcome.detail).toContain(`on ${name}, which stays the owner's under any shard`)
    }
  })
})
