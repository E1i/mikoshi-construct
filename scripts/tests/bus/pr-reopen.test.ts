import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_DROPPED, COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED, REQUEST_DONE, REQUEST_REFUSED, WINDOW_REQUEST } from '../../core/events.js'
import { closedKey, reopeningOf } from '../../core/observations.js'
import { PrCloser } from '../../nodes/review/pr-close.js'
import { PrReopener } from '../../nodes/review/pr-reopen.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const PR = 990
const CARD = PR + 100
const HEAD = sha('a')
const BRANCH = `feat/card-${CARD}`

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function refuse(): never {
  throw new Error('not used by a close or a reopen')
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
  const reopener = new PrReopener(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now)
  return new WindowRequests(bench.db, bench.clock.now, {
    treeOf: refuse,
    exists: refuse,
    cutTree: refuse,
    dryRunOf: refuse,
    addDecision: refuse,
    causeHolds: refuse,
    closePr: request => closer.close(request),
    closeDropped: () => closer.closeDropped(),
    reopenPr: (request) => {
      const outcome = reopener.reopen(request)
      return { done: outcome.kind === 'reopened', why: outcome.detail }
    },
  })
}

function ask(bench: MergeBench, kind: 'close-pr' | 'reopen-pr', card = CARD): number {
  return requestFromWindow(bench.db, bench.clock.now().toISOString(), 'window-1', { kind, pr: PR, card, reason: `${kind} by the window` })
}

function answerType(bench: MergeBench, request: number): string {
  return (bench.db.prepare('SELECT type FROM events WHERE dedupe_key = ?').get(`${WINDOW_REQUEST}:${request}:answered`) as { type: string }).type
}

function prState(bench: MergeBench): string | null {
  return (bench.db.prepare('SELECT state FROM prs WHERE pr = ?').get(PR) as { state: string | null } | undefined)?.state ?? null
}

function reopenPatches(bench: MergeBench): unknown[] {
  return bench.gitHub.closes.filter(patch => patch.fields.state === 'open')
}

function deniedReopens(bench: MergeBench): unknown[] {
  return eventsOf(bench.db, POLICY_DENIED).filter(payload => payload.command === 'reopen').map(payload => payload.rule)
}

function closedByTheWindowAndReopened(): MergeBench {
  const bench = benchWithOpenPr()
  ask(bench, 'close-pr')
  requests(bench).run()
  bench.tick()
  ask(bench, 'reopen-pr')
  requests(bench).run()
  bench.tick()
  return bench
}

describe('the window reopens a card pull request only through the reopen policy', () => {
  it('a window reopen-pr request reopens the closed pull request of a card through the policy', () => {
    const bench = benchWithOpenPr()
    ask(bench, 'close-pr')
    requests(bench).run()
    bench.tick()
    expect(prState(bench)).toBe('closed')

    const request = ask(bench, 'reopen-pr')
    expect(requests(bench).run()).toMatchObject([{ kind: 'done', request }])
    expect(answerType(bench, request)).toBe(REQUEST_DONE)
    expect(reopenPatches(bench)).toEqual([{ pr: PR, fields: { state: 'open' } }])
    expect(eventsOf(bench.db, POLICY_ALLOWED).filter(payload => payload.command === 'reopen')).toEqual([{ command: 'reopen', rule: 'card_pr', reason: 'reopen-pr by the window' }])
    expect(eventsOf(bench.db, COMMAND_EXECUTED).filter(payload => payload.command === 'reopen')).toEqual([{ command: 'reopen', ok: true, status: 200 }])
    expect(eventsOf(bench.db, PR_CLOSED)).toHaveLength(1)

    bench.tick()
    expect(prState(bench)).toBe('open')
  })

  it('reopen-pr is refused for the version, an open, a merged, a foreign and a dropped card pull request and sends no PATCH', () => {
    const version = benchWithOpenPr({ ref: 'changeset-release/main', body: `#${CARD} looks-like-a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —` })
    version.gitHub.close(PR, false)
    version.tick()
    const open = benchWithOpenPr()
    const merged = benchWithOpenPr()
    merged.gitHub.close(PR, true)
    merged.tick()
    const foreign = benchWithOpenPr()
    foreign.gitHub.close(PR, false)
    foreign.tick()
    const noCard = benchWithOpenPr({ body: 'An owner pull request with no card line.' })
    noCard.gitHub.close(PR, false)
    noCard.tick()
    const dropped = benchWithOpenPr()
    appendEvent(dropped.db, { ts: dropped.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { lane: 'dropped' }, legacy: false })
    dropped.tick()
    requests(dropped).run()
    dropped.tick()
    expect(prState(dropped)).toBe('closed')

    const cases: [MergeBench, number, string][] = [[version, CARD, 'version_pr'], [open, CARD, 'not_closed'], [merged, CARD, 'merged'], [foreign, CARD + 1, 'other_card'], [noCard, CARD, 'no_card'], [dropped, CARD, 'card_ended']]
    for (const [bench, card, rule] of cases) {
      const request = ask(bench, 'reopen-pr', card)
      expect(requests(bench).run()).toMatchObject([{ kind: 'refused', request }])
      expect(answerType(bench, request)).toBe(REQUEST_REFUSED)
      expect(deniedReopens(bench)).toEqual([rule])
      expect(reopenPatches(bench)).toEqual([])
      expect(eventsOf(bench.db, COMMAND_EXECUTED).filter(payload => payload.command === 'reopen')).toEqual([])
    }
  })

  it('a second close by the window after a reopen reaches the log and the pull reads closed', () => {
    const bench = closedByTheWindowAndReopened()
    expect(prState(bench)).toBe('open')

    const request = ask(bench, 'close-pr')
    expect(requests(bench).run()).toMatchObject([{ kind: 'done', request }])
    expect(eventsOf(bench.db, PR_CLOSED)).toEqual([{ merged: false, reason: 'close-pr by the window', by: 'window' }, { merged: false, reason: 'close-pr by the window', by: 'window' }])
    bench.tick()
    expect(prState(bench)).toBe('closed')
  })

  it('a merge on GitHub after a reopen reaches the log and the pull reads merged', () => {
    const bench = closedByTheWindowAndReopened()
    bench.gitHub.close(PR, true)
    bench.tick()
    expect(eventsOf(bench.db, PR_CLOSED).map(payload => payload.merged)).toEqual([false, true])
    expect(prState(bench)).toBe('merged')
  })

  it('a close read again on the next tick appends no second pr.closed', () => {
    const first = benchWithOpenPr()
    first.gitHub.close(PR, false)
    first.tick()
    first.tick()
    first.tick()
    expect(eventsOf(first.db, PR_CLOSED)).toHaveLength(1)
    expect(first.db.prepare('SELECT dedupe_key FROM events WHERE type = ?').get(PR_CLOSED)).toEqual({ dedupe_key: closedKey(PR, null) })

    const reopened = closedByTheWindowAndReopened()
    reopened.gitHub.close(PR, false)
    reopened.tick()
    expect(reopeningOf(reopened.db)(PR)).toBeNull()
    reopened.tick()
    reopened.tick()
    expect(eventsOf(reopened.db, PR_CLOSED)).toHaveLength(2)
    expect(prState(reopened)).toBe('closed')
  })

  it('the window request reopen-pr needs a pr, a card and a reason', () => {
    expect(requestOf(['reopen-pr', '--pr', '990', '--card', '1090', '--reason', 'the handoff needs it'])).toEqual({ kind: 'reopen-pr', pr: 990, card: 1090, reason: 'the handoff needs it' })
    expect(requestOf(['reopen-pr', '--pr', '990', '--card', '1090'])).toBeNull()
  })
})
