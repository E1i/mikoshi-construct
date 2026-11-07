import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { FakeRun } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MERGED_CARD } from '../../core/card-automaton.js'
import { CLOSED_WAIT, openOwnerWait, OWNER_WAITS } from '../../core/db.js'
import { COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED } from '../../core/events.js'
import { QUEUE_ACTOR } from '../../core/queue.js'
import { PrCloser } from '../../nodes/review/pr-close.js'
import { CiRerunner, PrBodyFileAppender } from '../../nodes/review/pr-rerun.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const PR = 995
const CARD = PR + 100
const HEAD = sha('a')
const REPORT = 'verification: run\n■ 3 □ 0 · 2'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function refuse(): never {
  throw new Error('not used by an owner GitHub action')
}

function benchWithOpenPr(pull: { ref?: string, body?: string, runs?: FakeRun[] } = {}): MergeBench {
  const bench = mergeBench()
  cleanups.push(() => bench.close())
  bench.gitHub.open({ number: PR, head: HEAD, ...pull })
  bench.tick()
  return bench
}

function cardTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-actions-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const tree = path.join(root, String(CARD))
  mkdirSync(tree)
  writeFileSync(path.join(tree, 'report.md'), REPORT)
  writeFileSync(path.join(root, 'outside.md'), 'not in the card tree')
  return tree
}

function requests(bench: MergeBench, tree = '/nowhere', pushPolicy: () => PushPolicy = () => 'bus'): WindowRequests {
  const closer = new PrCloser(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now)
  const parts = { db: bench.db, gitHub: bench.gitHub.client, clock: bench.clock.now, pushPolicy }
  const appender = new PrBodyFileAppender(parts, bench.gitHub.patch, cardId => cardId === CARD ? tree : '/nowhere')
  const rerunner = new CiRerunner(parts, bench.gitHub.post)
  return new WindowRequests(bench.db, bench.clock.now, {
    treeOf: refuse,
    exists: refuse,
    cutTree: refuse,
    dryRunOf: refuse,
    addDecision: refuse,
    causeHolds: refuse,
    closePr: request => closer.close(request),
    closeDropped: () => closer.closeDropped(),
    appendBodyFile: (attempt, pr, file) => appender.append(attempt, pr, file),
    rerunCi: (attempt, pr) => rerunner.rerun(attempt, pr),
  })
}

function ask(bench: MergeBench, request: Record<string, unknown>): number {
  return requestFromWindow(bench.db, bench.clock.now().toISOString(), 'window-1', request)
}

function commandEvents(bench: MergeBench, type: string, command: string): Record<string, unknown>[] {
  return eventsOf(bench.db, type).filter(payload => payload.command === command)
}

function deniedRules(bench: MergeBench, command: string): unknown[] {
  return commandEvents(bench, POLICY_DENIED, command).map(payload => payload.rule)
}

const FAILED_RUN: FakeRun = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'failure' }
const GREEN_RUN: FakeRun = { id: 8, run_attempt: 1, status: 'completed', conclusion: 'success' }

describe('the owner\'s GitHub actions go through bus:request', () => {
  it('pr.body with a file appends it to the body of a card pull request', () => {
    const bench = benchWithOpenPr()
    const tree = cardTree()
    const file = path.join(tree, 'report.md')
    const request = ask(bench, { kind: 'pr.body', pr: PR, file })
    expect(requests(bench, tree).run()).toMatchObject([{ kind: 'done', request }])
    expect(bench.gitHub.pulls.get(PR)?.body).toBe(`${cardBody(PR)}\n\n${REPORT}`)
    expect(commandEvents(bench, POLICY_ALLOWED, 'body')).toMatchObject([{ command: 'body', rule: 'card_pr' }])
    expect(commandEvents(bench, COMMAND_EXECUTED, 'body')).toMatchObject([{ command: 'body', ok: true, status: 200 }])
    expect(requestOf(['pr.body', '--pr', String(PR), '--file', file])).toEqual({ kind: 'pr.body', pr: PR, file })
    expect(requestOf(['pr.body', '--pr', String(PR)])).toEqual({ kind: 'pr.body', pr: PR })
  })

  it('pr.body refuses a file outside the card tree and a text the body already holds', () => {
    const tree = cardTree()
    const bench = benchWithOpenPr({ body: `${cardBody(PR)}\n\n${REPORT}` })
    const outside = ask(bench, { kind: 'pr.body', pr: PR, file: path.join(path.dirname(tree), 'outside.md') })
    const escaping = ask(bench, { kind: 'pr.body', pr: PR, file: path.join(tree, '..', 'outside.md') })
    const held = ask(bench, { kind: 'pr.body', pr: PR, file: path.join(tree, 'report.md') })
    expect(requests(bench, tree).run()).toMatchObject([{ kind: 'refused', request: outside }, { kind: 'refused', request: escaping }, { kind: 'refused', request: held }])
    expect(deniedRules(bench, 'body')).toEqual(['outside_tree', 'outside_tree', 'already_held'])
    expect(bench.gitHub.closes).toEqual([])
    expect(commandEvents(bench, COMMAND_EXECUTED, 'body')).toEqual([])

    const version = benchWithOpenPr({ ref: 'changeset-release/main' })
    ask(version, { kind: 'pr.body', pr: PR, file: path.join(tree, 'report.md') })
    expect(requests(version, tree).run()).toMatchObject([{ kind: 'refused' }])
    expect(deniedRules(version, 'body')).toEqual(['version_pr'])

    const none = benchWithOpenPr()
    ask(none, { kind: 'pr.body', pr: PR, file: path.join(tree, 'report.md') })
    expect(requests(none, tree, () => 'none').run()).toMatchObject([{ kind: 'refused', detail: `push policy none: the bus does not change the body of PR #${PR}` }])
    expect(none.gitHub.closes).toEqual([])
  })

  it('ci.rerun re-runs the failed jobs on the current head of a card pull request', () => {
    const bench = benchWithOpenPr({ runs: [FAILED_RUN, GREEN_RUN] })
    const request = ask(bench, { kind: 'ci.rerun', pr: PR })
    expect(requests(bench).run()).toMatchObject([{ kind: 'done', request }])
    expect(bench.gitHub.reruns).toEqual([7])
    expect(commandEvents(bench, POLICY_ALLOWED, 'rerun')).toMatchObject([{ command: 'rerun', rule: 'card_pr' }])
    expect(commandEvents(bench, COMMAND_EXECUTED, 'rerun')).toMatchObject([{ command: 'rerun', ok: true, status: 201, runs: [7] }])
    expect(requestOf(['ci.rerun', '--pr', String(PR)])).toEqual({ kind: 'ci.rerun', pr: PR })

    const forbidden = benchWithOpenPr({ runs: [FAILED_RUN] })
    forbidden.gitHub.rerunStatus = 403
    ask(forbidden, { kind: 'ci.rerun', pr: PR })
    expect(requests(forbidden).run()).toMatchObject([{ kind: 'refused', detail: `GitHub answered 403 to the re-run of the failed jobs of run 7 on PR #${PR}: Resource not accessible by integration` }])
  })

  it('ci.rerun refuses with no failed run and on a run already re-run', () => {
    const green = benchWithOpenPr({ runs: [GREEN_RUN] })
    ask(green, { kind: 'ci.rerun', pr: PR })
    expect(requests(green).run()).toMatchObject([{ kind: 'refused' }])
    expect(deniedRules(green, 'rerun')).toEqual(['no_failed_run'])

    const again = benchWithOpenPr({ runs: [{ ...FAILED_RUN, run_attempt: 2 }] })
    ask(again, { kind: 'ci.rerun', pr: PR })
    expect(requests(again).run()).toMatchObject([{ kind: 'refused' }])
    expect(deniedRules(again, 'rerun')).toEqual(['already_rerun'])

    const once = benchWithOpenPr({ runs: [FAILED_RUN] })
    ask(once, { kind: 'ci.rerun', pr: PR })
    requests(once).run()
    once.gitHub.pulls.get(PR)!.runs = [{ ...FAILED_RUN, run_attempt: 2 }]
    ask(once, { kind: 'ci.rerun', pr: PR })
    expect(requests(once).run()).toMatchObject([{ kind: 'refused' }])
    expect(once.gitHub.reruns).toEqual([7])

    const noCard = benchWithOpenPr({ body: 'An owner pull request with no card line.', runs: [FAILED_RUN] })
    ask(noCard, { kind: 'ci.rerun', pr: PR })
    requests(noCard).run()
    expect(deniedRules(noCard, 'rerun')).toEqual(['no_card'])

    for (const bench of [green, again, noCard])
      expect(bench.gitHub.reruns).toEqual([])
  })

  it('a pull request closed, reopened and merged ends its card and closes its merge wait', () => {
    const bench = benchWithOpenPr()
    bench.gitHub.close(PR, false)
    bench.tick()
    bench.gitHub.reopen(PR)
    bench.tick()
    const wait = openOwnerWait(bench.db, bench.clock.now().toISOString(), QUEUE_ACTOR, { need: 'merge', text: `merge PR #${PR}`, card: CARD, pr: PR })
    bench.tick()

    bench.gitHub.close(PR, true)
    bench.tick()
    expect(eventsOf(bench.db, PR_CLOSED).map(payload => payload.merged)).toEqual([false, true])
    expect(bench.db.prepare('SELECT state FROM prs WHERE pr = ?').get(PR)).toEqual({ state: 'merged' })
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD)).toEqual({ state: MERGED_CARD })
    expect(bench.db.prepare(`SELECT state FROM ${OWNER_WAITS} WHERE id = ?`).get(wait)).toEqual({ state: CLOSED_WAIT })
  })
})
