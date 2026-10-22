import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { leaseNext } from '../../bus/lease.js'
import { PrCloser } from '../../bus/pr-close.js'
import { queueTask } from '../../bus/queue.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../bus/window-requests.js'
import { CARD_DROPPED, COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED, REQUEST_DONE, REQUEST_REFUSED, WINDOW_REQUEST } from '../../core/events.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const PR = 980
const CARD = PR + 100
const HEAD = sha('a')
const BRANCH = `feat/card-${CARD}`

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function refuse(): never {
  throw new Error('not used by a close')
}

function benchWithOpenPr(pull: { body?: string, ref?: string } = {}): MergeBench {
  const bench = mergeBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, ref: BRANCH, ...pull })
  bench.tick()
  return bench
}

function requests(bench: MergeBench): WindowRequests {
  const closer = new PrCloser(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now)
  return new WindowRequests(bench.db, bench.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: request => closer.close(request), closeDropped: () => closer.closeDropped() })
}

function askClose(bench: MergeBench, card = CARD): number {
  return requestFromWindow(bench.db, bench.clock.now().toISOString(), 'window-1', { kind: 'close-pr', pr: PR, card, reason: 'the card is cut anew' })
}

function answerType(bench: MergeBench, request: number): string {
  return (bench.db.prepare('SELECT type FROM events WHERE dedupe_key = ?').get(`${WINDOW_REQUEST}:${request}:answered`) as { type: string }).type
}

function deniedRules(bench: MergeBench): unknown[] {
  return eventsOf(bench.db, POLICY_DENIED).map(payload => [payload.command, payload.rule])
}

function prState(bench: MergeBench, pr = PR): string | null {
  return (bench.db.prepare('SELECT state FROM prs WHERE pr = ?').get(pr) as { state: string | null } | undefined)?.state ?? null
}

describe('the bus closes a card pull request without merge, only through the close policy', () => {
  it('a window close-pr request for a card PR closes it without merge, keeps the branch and writes pr.closed merged false with the reason', () => {
    const bench = benchWithOpenPr()
    const request = askClose(bench)
    expect(requests(bench).run()).toMatchObject([{ kind: 'done', request }])
    expect(answerType(bench, request)).toBe(REQUEST_DONE)

    expect(bench.gitHub.closes).toEqual([{ pr: PR, fields: { state: 'closed' } }])
    expect(bench.gitHub.puts).toEqual([])
    expect(bench.gitHub.pulls.get(PR)).toMatchObject({ state: 'closed', merged: false, ref: BRANCH })
    expect(eventsOf(bench.db, POLICY_ALLOWED)).toEqual([{ command: 'close', rule: 'card_pr', reason: 'the card is cut anew', by: 'window' }])
    expect(eventsOf(bench.db, COMMAND_EXECUTED)).toEqual([{ command: 'close', ok: true, status: 200 }])
    expect(eventsOf(bench.db, PR_CLOSED)).toEqual([{ merged: false, reason: 'the card is cut anew', by: 'window' }])

    bench.tick()
    expect(prState(bench)).toBe('closed')
    expect(eventsOf(bench.db, PR_CLOSED)).toHaveLength(1)

    bench.gitHub.open({ number: PR + 1, head: sha('b'), ref: BRANCH, body: cardBody(PR) })
    bench.tick()
    expect(prState(bench, PR + 1)).toBe('open')
  })

  it('card.dropped with an open PR closes that PR without merge', () => {
    const bench = benchWithOpenPr()
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { lane: 'dropped' }, legacy: false })
    bench.tick()
    expect(requests(bench).run()).toEqual([])

    expect(bench.gitHub.closes).toEqual([{ pr: PR, fields: { state: 'closed' } }])
    expect(eventsOf(bench.db, POLICY_ALLOWED)).toMatchObject([{ command: 'close', by: 'card.dropped' }])
    expect(eventsOf(bench.db, PR_CLOSED)).toEqual([{ merged: false, reason: `card #${CARD} was dropped`, by: 'card.dropped' }])

    expect(requests(bench).run()).toEqual([])
    bench.tick()
    expect(requests(bench).run()).toEqual([])
    expect(bench.gitHub.closes).toHaveLength(1)
    expect(prState(bench)).toBe('closed')
  })

  it('closing the version PR is refused with policy.denied', () => {
    const bench = benchWithOpenPr({ ref: 'changeset-release/main', body: `#${CARD} looks-like-a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —` })
    const request = askClose(bench)
    expect(requests(bench).run()).toMatchObject([{ kind: 'refused', request }])
    expect(answerType(bench, request)).toBe(REQUEST_REFUSED)
    expect(deniedRules(bench)).toEqual([['close', 'version_pr']])
    expect(bench.gitHub.closes).toEqual([])
    expect(eventsOf(bench.db, PR_CLOSED)).toEqual([])
  })

  it('closing a PR with no card is refused with policy.denied', () => {
    const bench = benchWithOpenPr({ body: 'An owner pull request with no card line.' })
    const request = askClose(bench)
    expect(requests(bench).run()).toMatchObject([{ kind: 'refused', request }])
    expect(deniedRules(bench)).toEqual([['close', 'no_card']])
    expect(bench.gitHub.closes).toEqual([])

    const other = benchWithOpenPr()
    askClose(other, CARD + 1)
    expect(requests(other).run()).toMatchObject([{ kind: 'refused' }])
    expect(deniedRules(other)).toEqual([['close', 'other_card']])
    expect(other.gitHub.closes).toEqual([])
  })

  it('closing a PR under a live merge lease is refused with policy.denied', () => {
    const bench = benchWithOpenPr()
    queueTask(bench.db, bench.clock.now().toISOString(), { queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    expect(leaseNext(bench.db, bench.clock.now().toISOString(), 'merge', 'worker:merge:worker-1')).not.toBeNull()
    const request = askClose(bench)
    expect(requests(bench).run()).toMatchObject([{ kind: 'refused', request }])
    expect(deniedRules(bench)).toEqual([['close', 'merge_leased']])
    expect(bench.gitHub.closes).toEqual([])
  })

  it('a dropped card whose close was refused is not asked again on the next tick', () => {
    const bench = benchWithOpenPr()
    queueTask(bench.db, bench.clock.now().toISOString(), { queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    leaseNext(bench.db, bench.clock.now().toISOString(), 'merge', 'worker:merge:worker-1')
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { lane: 'dropped' }, legacy: false })
    bench.tick()
    requests(bench).run()
    requests(bench).run()
    expect(deniedRules(bench)).toEqual([['close', 'merge_leased']])
  })

  it('the window request needs a pr, a card and a reason', () => {
    expect(requestOf(['close-pr', '--pr', '980', '--card', '1080', '--reason', 'cut anew'])).toEqual({ kind: 'close-pr', pr: 980, card: 1080, reason: 'cut anew' })
    expect(requestOf(['close-pr', '--pr', '980', '--card', '1080'])).toBeNull()
  })
})
