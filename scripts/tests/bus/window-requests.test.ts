import type { RequestTools } from '../../bus/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { factoryMode } from '../../bus/card-bodies.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { dryRunIn, keepDryRun } from '../../bus/dry-run-record.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { failTask, leaseNext } from '../../bus/lease.js'
import { FAILURES_TO_STOP, queueTask } from '../../bus/queue.js'
import { roundLimitDecisionOf } from '../../bus/round-limit-decision.js'
import { decisionsInForceAt } from '../../bus/shards.js'
import { decisionsAdder, worktreesHolding } from '../../bus/window-request-tools.js'
import { REQUEST_RULE, requestFromWindow, runRequest, WindowRequests } from '../../bus/window-requests.js'
import { BOARD_ALARM, REQUEST_DONE, REQUEST_REFUSED, WINDOW_REQUEST } from '../../core/events.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, spendReviewRounds, taskState } from './merge-bench.js'

const PR = 970
const CARD = PR + 100
const HEAD = sha('a')
const SESSION = 'window-1'
const DRY_RUN = 'reviewer-dry'
const D_186 = '- D-186 · 2026-10-19 ~09:04Z — [owner] Until 0.44, after the round limit: one dry-run; then the window records allow-merge or issues a shard in Eli\'s name. · decisions:add'

interface Room {
  bench: MergeBench
  root: string
  cut: { branch: string, cardLine: string }[]
  causes: (string | null)[]
  requests: (tools?: Partial<RequestTools>) => WindowRequests
}

const rooms: Room[] = []

afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.bench.close()
    rmSync(room.root, { recursive: true, force: true })
  }
})

function room(bench: MergeBench = mergeBench()): Room {
  const root = mkdtempSync(path.join(tmpdir(), 'window-requests-'))
  const made: Room = {
    bench,
    root,
    cut: [],
    causes: [],
    requests: tools => new WindowRequests(bench.db, bench.clock.now, {
      treeOf: cardId => path.join(root, 'worktrees', `mc-${cardId}`),
      exists: existsSync,
      cutTree: (branch, cardLine) => {
        made.cut.push({ branch, cardLine })
        mkdirSync(path.join(root, 'worktrees', `mc-${CARD}`), { recursive: true })
      },
      dryRunOf: dryRunIn(path.join(root, 'dry-run-reviews')),
      addDecision: decisionsAdder(bench.db, root, bench.clock.now),
      causeHolds: () => made.causes.shift() ?? null,
      ...tools,
    }),
  }
  rooms.push(made)
  return made
}

function ask(made: Room, request: Record<string, unknown>): number {
  return requestFromWindow(made.bench.db, made.bench.clock.now().toISOString(), SESSION, request)
}

function answerOf(made: Room, request: number): { type: string, detail: string } {
  const row = made.bench.db.prepare('SELECT type, payload FROM events WHERE dedupe_key = ?').get(`${WINDOW_REQUEST}:${request}:answered`) as { type: string, payload: string }
  return { type: row.type, detail: String((JSON.parse(row.payload) as { detail: unknown }).detail) }
}

function admitBody(made: Room, cardId: number, cardLine: string, branch: string): void {
  const { db } = made.bench
  appendEvent(db, { ts: made.bench.clock.now().toISOString(), type: 'fixture.admission', actor: 'owner', cardId, pr: null, head: null, dedupeKey: `fixture.admission:${cardId}`, payload: {}, legacy: false })
  const event = (db.prepare(`SELECT id FROM events WHERE dedupe_key = ?`).get(`fixture.admission:${cardId}`) as { id: number }).id
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, card_line, branch) VALUES (?, ?, ?, ?, ?, ?)').run(cardId, event, cardLine, 'f'.repeat(64), cardLine, branch)
}

function roundLimitedWithD186(): Room {
  const made = room(liveBench())
  made.bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  spendReviewRounds(made.bench, PR, HEAD)
  recordDecision(made.bench.db, { ts: made.bench.clock.now().toISOString(), decisionId: 186, text: D_186.split(' — ')[1]!.replace(' · decisions:add', ''), cards: [] })
  mkdirSync(path.join(made.root, '.construct'), { recursive: true })
  writeFileSync(path.join(made.root, '.construct', 'owner-decisions.md'), `# Owner decisions\n\n${D_186}\n`)
  const archived = Array.from({ length: 185 }, (_, at) => `- D-${at + 1} · 2026-10-08 — archived. · superseded-by D-186\n`).join('')
  writeFileSync(path.join(made.root, '.construct', 'owner-decisions.archive.md'), `# Owner decisions archive\n\n${archived}`)
  mkdirSync(path.join(made.root, 'dry-run-reviews'), { recursive: true })
  made.bench.tick()
  return made
}

function queuedFor(bench: MergeBench, pr: number): string[] {
  return (bench.db.prepare(`SELECT queue FROM tasks WHERE pr = ? AND state = 'queued' ORDER BY queue`).all(pr) as { queue: string }[]).map(row => row.queue)
}

function alarmedAnswer(made: Room): string {
  const { bench } = made
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  bench.tick()
  const task = { queue: 'answer' as const, cardId: CARD, pr: PR, head: HEAD }
  queueTask(bench.db, bench.clock.now().toISOString(), task)
  failThrice(made)
  return taskKey(task)
}

function failThrice(made: Room): void {
  const { bench } = made
  for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1) {
    const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:answer-1')!
    failTask(bench.db, bench.clock.now().toISOString(), lease, { reason: 'answer_failed', withdraw: false })
  }
}

describe('requests from the sandboxed window, executed by the bus outside it', () => {
  it('a tree.cut request from the sandboxed window makes the card tree appear', () => {
    const made = room()
    const cardLine = `#${CARD} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`
    admitBody(made, CARD, cardLine, `feat/card-${CARD}`)
    const tree = path.join(made.root, 'worktrees', `mc-${CARD}`)
    const request = ask(made, { kind: 'tree.cut', card: CARD })

    expect(existsSync(tree)).toBe(false)
    expect(made.requests().run()).toEqual([{ kind: 'done', request, detail: `cut ${tree} on feat/card-${CARD}` }])
    expect(existsSync(tree)).toBe(true)
    expect(made.cut).toEqual([{ branch: `feat/card-${CARD}`, cardLine }])
    expect(answerOf(made, request).type).toBe(REQUEST_DONE)

    const again = ask(made, { kind: 'tree.cut', card: CARD })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: again, detail: `${tree} already exists` }])
    expect(made.cut).toHaveLength(1)
    const unknownCard = ask(made, { kind: 'tree.cut', card: CARD + 1 })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: unknownCard })
    expect(made.requests().run()).toEqual([])
  })

  it('an allow-merge request after the dry-run records the decision on the current head by D-186', () => {
    const made = roundLimitedWithD186()
    const { bench } = made
    const before = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: before, detail: `the dry run ${DRY_RUN} is not of PR #${PR} at ${HEAD}` }])

    keepDryRun(path.join(made.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    const oldHead = ask(made, { kind: 'allow-merge', pr: PR, head: sha('b'), dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: oldHead, detail: `PR #${PR} is at ${HEAD}, not ${sha('b')}` })

    const request = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request })
    const line = `[owner] allow-merge PR #${PR} at ${HEAD} · by D-186 · card #${CARD} · decisions:add`
    expect(readFileSync(path.join(made.root, '.construct', 'owner-decisions.md'), 'utf8')).toContain(`- D-187 · `)
    expect(readFileSync(path.join(made.root, '.construct', 'owner-decisions.md'), 'utf8')).toContain(line)

    bench.tick()
    expect(roundLimitDecisionOf(decisionsInForceAt(bench.db, bench.clock.now()), PR, HEAD, [])).toBe(187)
    expect(queuedFor(bench, PR)).toEqual(['merge'])
    const twice = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: twice, detail: `D-187 already allows the merge of PR #${PR} at ${HEAD}` }])
  })

  it('an allow-merge request takes the dry run of the previous head after one push and refuses one two pushes back', () => {
    const made = roundLimitedWithD186()
    const { bench } = made
    keepDryRun(path.join(made.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    bench.gitHub.open({ number: PR, head: sha('b'), review: 'failure' })
    bench.tick()

    const onePush = ask(made, { kind: 'allow-merge', pr: PR, head: sha('b'), dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request: onePush })

    bench.gitHub.open({ number: PR, head: sha('c'), review: 'failure' })
    bench.tick()
    const twoPushes = ask(made, { kind: 'allow-merge', pr: PR, head: sha('c'), dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: twoPushes, detail: `the dry run ${DRY_RUN} is not of PR #${PR} at ${sha('c')}` }])
  })

  it('an allow-merge request is refused before the round limit or without D-186 in force', () => {
    const made = room(liveBench())
    made.bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
    made.bench.tick()
    keepDryRun(made.root)(DRY_RUN, { pr: PR, head: HEAD })
    const withoutD186 = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests({ dryRunOf: dryRunIn(made.root) }).run()).toEqual([{ kind: 'refused', request: withoutD186, detail: 'D-186 is not in force' }])

    recordDecision(made.bench.db, { ts: made.bench.clock.now().toISOString(), decisionId: 186, text: 'Until 0.44, after the round limit: one dry-run', cards: [] })
    made.bench.tick()
    const early = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests({ dryRunOf: dryRunIn(made.root) }).run()).toEqual([{ kind: 'refused', request: early, detail: `PR #${PR} has 0 of 3 review rounds, not past the round limit` }])
  })

  it('a requeue request after board.alarm puts the task back in its queue once the cause is gone', () => {
    const made = room()
    const key = alarmedAnswer(made)
    expect(taskState(made.bench.db, key).state).toBe('stopped')
    expect(eventsOf(made.bench.db, BOARD_ALARM).map(alarm => alarm.task_key)).toEqual([key])

    made.causes.push(`feat/card-${CARD} is checked out at /trees/mc-${CARD}`)
    const held = ask(made, { kind: 'requeue', task_key: key })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: held })
    expect(taskState(made.bench.db, key).state).toBe('stopped')

    const gone = ask(made, { kind: 'requeue', task_key: key })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request: gone })
    expect(taskState(made.bench.db, key)).toMatchObject({ state: 'queued', failures: 0 })
    made.bench.tick()
    expect(taskState(made.bench.db, key).state).toBe('queued')
  })

  it('a requeue request is refused past the D-104 limit of requeues after one board.alarm', () => {
    const made = room()
    const key = alarmedAnswer(made)
    for (let requeue = 1; requeue <= FAILURES_TO_STOP; requeue += 1) {
      const request = ask(made, { kind: 'requeue', task_key: key })
      expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request })
      failThrice(made)
    }
    const past = ask(made, { kind: 'requeue', task_key: key })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: past })
    expect(answerOf(made, past).detail).toContain('the D-104 limit')
    expect(taskState(made.bench.db, key).state).toBe('stopped')
  })

  it('a request of an unknown kind is refused and becomes an owner question', () => {
    const made = room()
    const lines: string[] = []
    expect(runRequest(['merge.now', '--pr', String(PR)], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(0)
    const request = Number(/window\.request (\d+)/.exec(lines[0]!)![1])

    expect(made.requests().run()).toEqual([{ kind: 'owner', request, detail: `the window asked for "merge.now", not one of tree.cut, allow-merge, requeue, mode; refused, the owner decides` }])
    expect(answerOf(made, request).type).toBe(REQUEST_REFUSED)
    const inbox = ownerInbox(made.bench.db)
    expect(inbox).toHaveLength(1)
    expect(JSON.parse(inbox[0]!.payload)).toMatchObject({ kind: 'authority', rule: REQUEST_RULE })
    expect(made.cut).toEqual([])
    expect(made.requests().run()).toEqual([])
  })

  it('a request with a known kind and missing fields is not written', () => {
    const made = room()
    const lines: string[] = []
    expect(runRequest(['allow-merge', '--pr', String(PR)], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(2)
    expect(made.requests().run()).toEqual([])
  })

  it('a mode request switches the factory mode once the bus answers it, and window is the mode before any', () => {
    const made = room()
    const lines: string[] = []
    expect(factoryMode(made.bench.db)).toBe('window')
    expect(runRequest(['mode', '--set', 'parallel'], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(0)
    expect(factoryMode(made.bench.db)).toBe('window')
    expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: 'the factory mode is parallel' }])
    expect(factoryMode(made.bench.db)).toBe('parallel')
    expect(runRequest(['mode', '--set', 'fast'], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(2)
  })

  it('the worktrees holding a branch are read from git worktree list --porcelain', () => {
    const porcelain = [`worktree /repo\nHEAD ${sha('1')}\nbranch refs/heads/main`, `worktree /trees/mc-${CARD}\nHEAD ${HEAD}\nbranch refs/heads/feat/card-${CARD}`, `worktree /trees/review\nHEAD ${HEAD}\ndetached`].join('\n\n')
    expect(worktreesHolding(porcelain, `feat/card-${CARD}`)).toEqual([`/trees/mc-${CARD}`])
    expect(worktreesHolding(porcelain, 'feat/other')).toEqual([])
  })

  it('a dry-run record is read back only for a plain session name and a full head', () => {
    const made = room()
    keepDryRun(made.root)(DRY_RUN, { pr: PR, head: HEAD })
    expect(dryRunIn(made.root)(DRY_RUN)).toEqual({ pr: PR, head: HEAD })
    expect(dryRunIn(made.root)('../reviewer-dry')).toBeNull()
    expect(dryRunIn(made.root)('another')).toBeNull()
  })
})
