import type { BusEvent } from '../../bus/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { runInbox } from '../../bus/inbox.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const TS = '2026-10-10T08:00:00.000Z'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-inbox-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function event(type: string, fields: Partial<BusEvent>): BusEvent {
  sequence += 1
  return { ts: TS, type, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${type}:test-${sequence}`, payload: {}, legacy: false, ...fields }
}

function denied(cardId: number, pr: number, denial: Record<string, string>): BusEvent {
  return event('policy.denied', { cardId, pr, head: HEAD, payload: { command: 'merge', ...denial } })
}

function stopped(cardId: number, reason: string): BusEvent {
  return event('card.stopped', { actor: 'worker:answer:s1', cardId, payload: { reason, detail: `which way for #${cardId}` } })
}

function answered(scope: number[], actor = 'owner'): BusEvent {
  return event('decision.recorded', { actor, payload: { decision_id: sequence, text: 'the answer', scope, source: 'owner' } })
}

function inbox(...events: BusEvent[]): string[] {
  const db = newBus()
  for (const each of events)
    appendEvent(db, each)
  const out: string[] = []
  expect(runInbox(db, line => out.push(line))).toBe(0)
  return out
}

describe('pnpm bus:inbox, the owner inbox', () => {
  it('bus:inbox lists authority denials and open owner questions and leaves out technical denials and fault stops', () => {
    expect(inbox(
      denied(1001, 901, { kind: 'authority', rule: 'version_pr', detail: 'a version pull request' }),
      denied(1002, 902, { kind: 'technical', reason: 'stale_head', detail: 'the head moved' }),
      stopped(807, 'question.owner'),
      stopped(808, 'fault'),
      stopped(809, 'question.agent'),
      denied(1003, 903, { kind: 'authority', rule: 'security_invariants', detail: 'changes a security-invariants path' }),
      denied(1004, 904, { kind: 'authority', rule: 'owner_by_risk', detail: 'R1' }),
      denied(1005, 905, { kind: 'authority', rule: 'reserved', detail: '#1005 reserved' }),
    )).toEqual([
      '[bus:inbox] policy.denied authority version_pr · card #1001 · PR #901 · merge · a version pull request',
      '[bus:inbox] card.stopped question.owner · card #807 · which way for #807',
      '[bus:inbox] policy.denied authority security_invariants · card #1003 · PR #903 · merge · changes a security-invariants path',
      '[bus:inbox] policy.denied authority owner_by_risk · card #1004 · PR #904 · merge · R1',
      '[bus:inbox] policy.denied authority reserved · card #1005 · PR #905 · merge · #1005 reserved',
    ])
    expect(inbox(denied(1002, 902, { kind: 'technical', reason: 'stale_head' }), stopped(808, 'fault'))).toEqual(['[bus:inbox] the owner inbox is empty'])
  })

  it('an owner question answered by a decision leaves the inbox', () => {
    const question = '[bus:inbox] card.stopped question.owner · card #807 · which way for #807'
    expect(inbox(stopped(807, 'question.owner'), answered([807], 'policy'), answered([808]))).toEqual([question])
    expect(inbox(answered([807]), stopped(807, 'question.owner'))).toEqual([question])
    expect(inbox(stopped(807, 'question.owner'), answered([806, 807]))).toEqual(['[bus:inbox] the owner inbox is empty'])
  })
})
