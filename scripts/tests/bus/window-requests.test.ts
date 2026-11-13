import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { CardStarter, LaunchOutcome } from '../../nodes/launch/launch-executor.js'
import type { GitHubPut } from '../../ports/github.js'
import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { BUS_DB_VARIABLE, busDirOf } from '../../core/bus-path.js'
import { factoryMode } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { BOARD_ALARM, BUS_PULSE, CARD_ADMITTED, CARD_DROPPED, CARD_STOPPED, OWNER_WAIT_OPENED, PR_CLOSED, PR_OPENED, REQUEST_DONE, REQUEST_REFUSED, SHARD_ISSUED, WINDOW_REQUEST } from '../../core/events.js'
import { prBodySha, taskKey } from '../../core/identifiers.js'
import { ownerInbox } from '../../core/inbox.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP, queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { launchableCard } from '../../nodes/launch/launch-candidates.js'
import { LaunchExecutor, technical } from '../../nodes/launch/launch-executor.js'
import { dryRunIn, keepDryRun } from '../../nodes/review/dry-run-record.js'
import { PrCloser } from '../../nodes/review/pr-close.js'
import { OWNER_WORD_NOT_FOUND, sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { stampOf } from '../../policy/decisions/decisions.js'
import { inForceDecisions, recordDecision } from '../../policy/decisions/index.js'
import { decisionsAdder } from '../../policy/decisions/projection.js'
import { roundLimitDecisionOf } from '../../policy/round-limit-decision.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { NetWatch } from '../../ports/netwatch.js'
import { WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
import { busProjections } from '../../supervisor/composition.js'
import { BusTick } from '../../supervisor/run.js'
import { productionDeps, STALL_MS } from '../../window/watch.js'
import { countLineAppender, realRequestTools, worktreesHolding } from '../../window/window-request-tools.js'
import { ALLOW_MERGE_RECORD, ANSWER_SOURCE, pendingRequests, PREFIX, REQUEST_KINDS, REQUEST_RULE, requestFromWindow, runRequest, USAGE, WindowRequests } from '../../window/window-requests.js'
import { cardBody, sha } from './github-fake.js'
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
  releaseVersion: string | null
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
    releaseVersion: '0.47.0',
    requests: tools => new WindowRequests(bench.db, bench.clock.now, {
      treeOf: cardId => path.join(root, 'worktrees', `mc-${cardId}`),
      exists: existsSync,
      cutTree: (branch, cardLine) => {
        made.cut.push({ branch, cardLine })
        mkdirSync(path.join(root, 'worktrees', `mc-${CARD}`), { recursive: true })
      },
      dryRunOf: dryRunIn(path.join(root, 'dry-run-reviews')),
      addDecision: decisionsAdder(bench.db, path.join(root, '.construct', 'owner-decisions.md'), bench.clock.now),
      causeHolds: () => made.causes.shift() ?? null,
      closePr: request => new PrCloser(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now).close(request),
      closeDropped: () => new PrCloser(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now).closeDropped(),
      ...tools,
    }, channelOf(made), () => made.releaseVersion, root, bench.gitHub.client),
  }
  rooms.push(made)
  return made
}

function channelOf(made: Room): string {
  return path.join(made.root, 'owner-answers')
}

function ownerSays(made: Room, words: string): string {
  return sayToOwnerChannel(channelOf(made), words, made.bench.clock.now())
}

function ask(made: Room, request: Record<string, unknown>): number {
  return requestFromWindow(made.bench.db, made.bench.clock.now().toISOString(), SESSION, request)
}

function answerOf(made: Room, request: number): { type: string, detail: string } {
  const row = made.bench.db.prepare('SELECT type, payload FROM events WHERE dedupe_key = ?').get(`${WINDOW_REQUEST}:${request}:answered`) as { type: string, payload: string }
  return { type: row.type, detail: String((JSON.parse(row.payload) as { detail: unknown }).detail) }
}

const COUNT_LINE = '■ 2 □ 0 · 1'
const REPORT_WITH_THE_LINE = `contract: x\n\n| | M1 |\n| M1 | ■ |\n\n${COUNT_LINE}\n\nverification: run\n`
const REPORT_WITHOUT_A_LINE = 'contract: x\nverification: review\n'

function launchDirIn(made: Room): string {
  return path.join(made.root, 'launch')
}

function reportOfCard(made: Room): string {
  return path.join(launchDirIn(made), `report-${CARD}.md`)
}

function writeReport(made: Room, text: string): void {
  mkdirSync(launchDirIn(made), { recursive: true })
  writeFileSync(reportOfCard(made), text)
}

function bodyWritingPatch(made: Room): GitHubPut {
  return (endpoint, fields) => {
    made.bench.gitHub.pulls.get(PR)!.body = fields.body
    return made.bench.gitHub.patch(endpoint, fields)
  }
}

function countLineTools(made: Room, patch: GitHubPut = bodyWritingPatch(made), policy: PushPolicy = 'bus'): Partial<RequestTools> {
  return { appendCountLine: countLineAppender(made.bench.gitHub.client, patch, launchDirIn(made), () => policy) }
}

function openPrWithoutCountLine(made: Room, body = cardBody(PR)): void {
  made.bench.gitHub.open({ number: PR, head: HEAD, review: 'success', files: ['src/cli.ts'], body })
  made.bench.tick()
}

function admitBody(made: Room, cardId: number, cardLine: string, branch: string): void {
  const { db } = made.bench
  appendEvent(db, { ts: made.bench.clock.now().toISOString(), type: 'fixture.admission', actor: 'owner', cardId, pr: null, head: null, dedupeKey: `fixture.admission:${cardId}`, payload: {}, legacy: false })
  const event = (db.prepare(`SELECT id FROM events WHERE dedupe_key = ?`).get(`fixture.admission:${cardId}`) as { id: number }).id
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, card_line, branch) VALUES (?, ?, ?, ?, ?, ?)').run(cardId, event, cardLine, 'f'.repeat(64), cardLine, branch)
}

function withAllowMergeRule(made: Room, status = 'accepted'): void {
  mkdirSync(path.dirname(path.join(made.root, ALLOW_MERGE_RECORD)), { recursive: true })
  writeFileSync(path.join(made.root, ALLOW_MERGE_RECORD), `# The window allows a merge past the review round limit\n\nStatus: ${status}\n`)
}

function roundLimitedUnderTheRule(): Room {
  const made = room(liveBench())
  withAllowMergeRule(made)
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

function withDecisionsFile(made: Room, ...lines: string[]): string {
  const file = path.join(made.root, '.construct', 'owner-decisions.md')
  mkdirSync(path.join(made.root, '.construct', 'handoff'), { recursive: true })
  writeFileSync(file, `# Owner decisions\n\n${lines.join('\n')}\n`)
  return file
}

function windowAsks(made: Room, ...argv: string[]): number {
  const lines: string[] = []
  expect(runRequest(['decisions:add', ...argv], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(0)
  return Number(/window\.request (\d+)/.exec(lines[0]!)![1])
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
    expect(made.requests().run()).toEqual([{ kind: 'done', request: again, detail: `cut ${tree} on feat/card-${CARD}` }])
    expect(made.cut).toHaveLength(2)
    const unknownCard = ask(made, { kind: 'tree.cut', card: CARD + 1 })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: unknownCard })
    expect(made.requests().run()).toEqual([])
  })

  it('a tree.cut requested in the same tick as the card.admitted of its card is answered done on that tick', () => {
    const made = room()
    const { bench } = made
    const text = `card: #${CARD} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: window\n\nCut it.\n`
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
    const request = ask(made, { kind: 'tree.cut', card: CARD })
    const outcomes: unknown[] = []
    const busTick = new BusTick(bench.db, busProjections(), new NetWatch(bench.db, bench.gitHub.client, bench.clock.now), bench.clock.now, () => {}, () => {}, () => outcomes.push(...made.requests().run()))

    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(outcomes).toEqual([{ kind: 'done', request, detail: `cut ${path.join(made.root, 'worktrees', `mc-${CARD}`)} on feat/card-${CARD}` }])
    expect(answerOf(made, request).type).toBe(REQUEST_DONE)
  })

  it('an allow-merge request after the dry-run records the decision on the current head by the allow-merge record', () => {
    const made = roundLimitedUnderTheRule()
    const { bench } = made
    const before = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: before, detail: `the dry run ${DRY_RUN} is not of PR #${PR} at ${HEAD}` }])

    keepDryRun(path.join(made.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    const oldHead = ask(made, { kind: 'allow-merge', pr: PR, head: sha('b'), dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'refused', request: oldHead, detail: `PR #${PR} is at ${HEAD}, not ${sha('b')}` })

    const request = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request })
    const line = `[owner] allow-merge PR #${PR} at ${HEAD} · by ${ALLOW_MERGE_RECORD} · card #${CARD} · decisions:add`
    expect(readFileSync(path.join(made.root, '.construct', 'owner-decisions.md'), 'utf8')).toContain(`- D-187 · `)
    expect(readFileSync(path.join(made.root, '.construct', 'owner-decisions.md'), 'utf8')).toContain(line)

    bench.tick()
    expect(roundLimitDecisionOf(decisionsInForceAt(bench.db, bench.clock.now()), PR, HEAD, [])).toBe(187)
    expect(queuedFor(bench, PR)).toEqual(['merge'])
    const twice = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: twice, detail: `D-187 already allows the merge of PR #${PR} at ${HEAD}` }])
  })

  it('an allow-merge request takes the dry run of the previous head after one push and refuses one two pushes back', () => {
    const made = roundLimitedUnderTheRule()
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

  it('a request on head H with a fresh pr.observed at H is accepted; on another head it is refused', () => {
    const made = roundLimitedUnderTheRule()
    const { bench } = made
    keepDryRun(path.join(made.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    const fresh = sha('b')
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: CARD, pr: PR, head: fresh, dedupeKey: `pr.observed:${PR}:${fresh}`, payload: { pr: PR, head: fresh, state: 'open', base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false }, legacy: false })

    const onTheFreshHead = ask(made, { kind: 'allow-merge', pr: PR, head: fresh, dry_run: DRY_RUN })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request: onTheFreshHead })
    const onAnotherHead = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: onAnotherHead, detail: `PR #${PR} is at ${fresh}, not ${HEAD}` }])
  })

  it('a pr.closed after the fresh pr.observed reads the pull request as closed', () => {
    const made = roundLimitedUnderTheRule()
    const { bench } = made
    keepDryRun(path.join(made.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `pr.observed:${PR}:again`, payload: { pr: PR, head: HEAD, state: 'open', base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false }, legacy: false })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: PR_CLOSED, actor: 'netwatch', cardId: CARD, pr: PR, head: null, dedupeKey: `${PR_CLOSED}:${PR}:merged`, payload: { merged: true }, legacy: false })
    reduce(bench.db, 'pending', busProjections())

    const request = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request, detail: `PR #${PR} is not open` }])
  })

  it('an allow-merge request is refused before the round limit or without the allow-merge record in force', () => {
    const made = room(liveBench())
    made.bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
    made.bench.tick()
    keepDryRun(made.root)(DRY_RUN, { pr: PR, head: HEAD })
    const notInForce = `${ALLOW_MERGE_RECORD} is not in force in ${made.root}: absent, or its status is not accepted`
    const withoutRecord = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests({ dryRunOf: dryRunIn(made.root) }).run()).toEqual([{ kind: 'refused', request: withoutRecord, detail: notInForce }])

    withAllowMergeRule(made, 'superseded')
    const withdrawn = ask(made, { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(made.requests({ dryRunOf: dryRunIn(made.root) }).run()).toEqual([{ kind: 'refused', request: withdrawn, detail: notInForce }])

    withAllowMergeRule(made)
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

  it('a requeue of the launch of a card stopped by fault returns it to queued and the launch starts it, with no body edit', () => {
    const made = room()
    const { bench } = made
    const cardId = CARD + 115
    let refusals = FAILURES_TO_STOP
    const starter: CardStarter = {
      start: card => refusals-- > 0
        ? { kind: 'refused', denial: technical('start_failed', `task:start for card #${card.cardId} failed`) }
        : { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: sha('f'), pid: 4242, pgid: 4242 } },
      stop: () => {},
    }
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
    const launchNext = (): LaunchOutcome => executor.launch(leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:worker-1')!)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
    bench.tick()
    const key = taskKey({ queue: 'launch', cardId, generation: `admission-${cardId}` })
    for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1)
      expect(launchNext()).toMatchObject({ kind: 'denied', denial: { reason: 'start_failed' } })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('stopped')
    expect(eventsOf(bench.db, CARD_STOPPED).at(-1)).toMatchObject({ reason: 'fault' })
    expect(launchableCard(bench.db, cardId)).toBeNull()

    const request = ask(made, { kind: 'requeue', task_key: key })
    expect(made.requests().run()[0]).toMatchObject({ kind: 'done', request })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('queued')
    expect(launchableCard(bench.db, cardId)).toEqual({ lane: 'lane-a', contour: 'cheap' })

    expect(launchNext()).toMatchObject({ kind: 'started', taskKey: key, card: { session: `s-${cardId}` } })
    bench.tick()
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId)).toEqual({ state: 'running' })
    expect(eventsOf(bench.db, CARD_ADMITTED).filter(admitted => admitted.admission === `admission-${cardId}`)).toHaveLength(1)
  })

  it('a keep-tree requeue of a card that fell at its start with no session record takes its existing tree as it stands', () => {
    const made = room()
    const { bench } = made
    const cardId = CARD + 116
    const branch = `feat/card-${cardId}`
    const repo = path.join(made.root, 'repo')
    const home = path.join(made.root, 'trees')
    const tree = path.join(home, `mc-${cardId}`)
    const gitIn = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    mkdirSync(repo, { recursive: true })
    gitIn(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'main.txt'), 'main\n')
    gitIn(repo, 'add', '.')
    gitIn(repo, 'commit', '-q', '-m', 'main')
    gitIn(repo, 'worktree', 'add', '-q', '-b', branch, tree)
    writeFileSync(path.join(tree, 'finished.txt'), 'finished but uncommitted\n')
    const starter: CardStarter = {
      start: card => ({ kind: 'refused', denial: technical('start_failed', `task:start for card #${card.cardId} found ${tree} standing`) }),
      stop: () => {},
    }
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
    const text = `card: #${cardId} fell-at-start [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: ${branch}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nFinish it.\n`
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}`, text, textSha: textSha(text) }, legacy: false })
    bench.tick()
    const key = taskKey({ queue: 'launch', cardId, generation: `admission-${cardId}` })
    for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1)
      executor.launch(leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:worker-1')!)
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('stopped')
    const { causeHolds } = realRequestTools(bench.db, bench.busPath, repo, { [WORKTREE_HOME_VARIABLE]: home }, busProjections())

    const plain = ask(made, { kind: 'requeue', task_key: key })
    expect(made.requests({ causeHolds }).run()[0]).toMatchObject({ kind: 'refused', request: plain, detail: expect.stringContaining(`the card tree ${tree} has uncommitted changes; a requeue with keep_tree: true`) })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('stopped')

    const kept = ask(made, { kind: 'requeue', task_key: key, keep_tree: true })
    expect(made.requests({ causeHolds }).run()[0]).toMatchObject({ kind: 'done', request: kept, detail: expect.stringContaining(`its session starts on the tree as it stands: the card tree ${tree} has uncommitted changes`) })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('queued')
    expect(readFileSync(path.join(tree, 'finished.txt'), 'utf8')).toBe('finished but uncommitted\n')
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

    expect(made.requests().run()).toEqual([{ kind: 'owner', request, detail: `the window asked for "merge.now", not one of ${REQUEST_KINDS.join(', ')}; refused, the owner decides` }])
    expect(answerOf(made, request).type).toBe(REQUEST_REFUSED)
    const inbox = ownerInbox(made.bench.db)
    expect(inbox).toHaveLength(1)
    expect(JSON.parse(inbox[0]!.payload)).toMatchObject({ kind: 'authority', rule: REQUEST_RULE })
    expect(made.cut).toEqual([])
    expect(made.requests().run()).toEqual([])
  })

  it('a pr.body request appends the count line of the card report to the pull request body and the merge is queued again under the new body', () => {
    const made = room(liveBench())
    const { bench } = made
    openPrWithoutCountLine(made)
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { rule: 'no_matrix_count_line' }, next: 'withdrawn' })
    bench.tick()
    expect(bench.lease()).toBeNull()
    writeReport(made, REPORT_WITH_THE_LINE)

    const request = ask(made, { kind: 'pr.body', pr: PR })
    expect(made.requests(countLineTools(made)).run()).toEqual([{ kind: 'done', request, detail: `appended ${COUNT_LINE} from ${reportOfCard(made)} to PR #${PR}` }])
    const body = `${cardBody(PR)}\n\n${COUNT_LINE}`
    expect(bench.gitHub.pulls.get(PR)!.body).toBe(body)
    expect(bench.gitHub.closes).toEqual([{ pr: PR, fields: { body } }])

    bench.tick()
    const key = `merge:${CARD}:${PR}:${HEAD}:pr-body-${prBodySha(body)}`
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', taskKey: key })
  })

  it('a pr.body request is refused by name and writes nothing where no count line can be appended', () => {
    const cases: { name: string, report?: string, body?: string, policy?: 'none', refusal: (made: Room) => string }[] = [
      { name: 'a report with no count line, as report-1488.md', report: REPORT_WITHOUT_A_LINE, refusal: made => `${reportOfCard(made)} holds no count line ■ n □ n · n, so nothing is appended to PR #${PR}` },
      { name: 'no report', refusal: made => `card #${CARD} has no report at ${reportOfCard(made)}, so no count line to append to PR #${PR}` },
      { name: 'a body that holds a line', report: REPORT_WITH_THE_LINE, body: `${cardBody(PR)}\n\n■ 9 □ 9 · 9`, refusal: () => `PR #${PR} already holds the count line ■ 9 □ 9 · 9` },
      { name: 'push policy none', report: REPORT_WITH_THE_LINE, policy: 'none', refusal: () => `push policy none: the bus does not change the body of PR #${PR}` },
    ]
    for (const each of cases) {
      const made = room()
      openPrWithoutCountLine(made, each.body)
      if (each.report !== undefined)
        writeReport(made, each.report)
      const request = ask(made, { kind: 'pr.body', pr: PR })
      expect(made.requests(countLineTools(made, bodyWritingPatch(made), each.policy)).run(), each.name).toEqual([{ kind: 'refused', request, detail: each.refusal(made) }])
      expect(made.bench.gitHub.closes, each.name).toEqual([])
    }
  })

  it('a pr.body request that GitHub does not take is refused with its status', () => {
    const made = room()
    openPrWithoutCountLine(made)
    writeReport(made, REPORT_WITH_THE_LINE)
    const unwritten: GitHubPut = () => ({ status: 403, headers: {}, body: null })
    const request = ask(made, { kind: 'pr.body', pr: PR })
    expect(made.requests(countLineTools(made, unwritten)).run()).toEqual([{ kind: 'refused', request, detail: `GitHub answered 403 to the write of the body of PR #${PR}` }])
    const limited = ask(made, { kind: 'pr.body', pr: PR })
    made.bench.gitHub.limited = { status: 429, headers: {}, body: null }
    expect(made.requests(countLineTools(made)).run()).toEqual([{ kind: 'refused', request: limited, detail: `GitHub answered 429 to the read of PR #${PR}` }])
  })

  it('a pr.body request needs an open pull request of a card and a bus with the tool', () => {
    const made = room()
    const unnamed = ask(made, { kind: 'pr.body' })
    const unknown = ask(made, { kind: 'pr.body', pr: PR })
    expect(made.requests(countLineTools(made)).run()).toEqual([
      { kind: 'refused', request: unnamed, detail: 'pr.body names no pr' },
      { kind: 'refused', request: unknown, detail: `PR #${PR} is not open` },
    ])
    openPrWithoutCountLine(made)
    const toolless = ask(made, { kind: 'pr.body', pr: PR })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: toolless, detail: 'this bus was built with no tool to change a pull request body' }])
    made.bench.gitHub.open({ number: PR + 1, head: sha('b'), review: 'success', body: 'chore: version packages' })
    made.bench.tick()
    const cardless = ask(made, { kind: 'pr.body', pr: PR + 1 })
    expect(made.requests(countLineTools(made)).run()).toEqual([{ kind: 'refused', request: cardless, detail: `PR #${PR + 1} names no card, so no report holds its count line` }])
  })

  it('the real tools read the count line from the report in the launch directory of the bus', () => {
    const made = room()
    const report = path.join(busDirOf(made.bench.busPath), 'launch', `report-${CARD}.md`)
    expect(realRequestTools(made.bench.db, made.bench.busPath, process.cwd(), {}, busProjections()).appendCountLine!(PR, CARD)).toEqual({ done: false, why: `card #${CARD} has no report at ${report}, so no count line to append to PR #${PR}` })
  })

  it('pnpm bus:request pr.body takes a --pr', () => {
    const made = room()
    expect(runRequest(['pr.body'], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(2)
    expect(runRequest(['pr.body', '--pr', String(PR)], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(0)
    expect(made.requests().run()).toMatchObject([{ kind: 'refused', detail: `PR #${PR} is not open` }])
  })

  it('an owner.wait request opens a wait, and closing it twice is refused the second time', () => {
    const made = room()
    const opened = ask(made, { kind: 'owner.wait', need: 'decision', text: 'which path?', card: CARD })
    expect(made.requests().run()).toEqual([{ kind: 'done', request: opened, detail: 'opened Q1' }])
    reduce(made.bench.db, 'pending', busProjections())
    ownerSays(made, 'Q1: the first')
    const first = ask(made, { kind: 'owner.wait.close', id: 'Q1', answer: 'the first', from: ANSWER_SOURCE })
    expect(made.requests().run()).toMatchObject([{ kind: 'done', request: first, detail: expect.stringContaining('closed Q1 on the owner\'s word') as unknown }])
    reduce(made.bench.db, 'pending', busProjections())
    const second = ask(made, { kind: 'owner.wait.close', id: 'Q1', answer: 'again' })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: second, detail: 'Q1 is closed already' }])
  })

  it('an owner.wait for a command that names no command is refused, and a close of an unknown id too', () => {
    const made = room()
    const command = ask(made, { kind: 'owner.wait', need: 'command', text: 'run it' })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: command, detail: 'owner.wait --need command names no command' }])
    const unknown = ask(made, { kind: 'owner.wait.close', id: 'Q9', answer: 'yes' })
    expect(made.requests().run()).toEqual([{ kind: 'refused', request: unknown, detail: 'Q9 is not an owner wait the bus has reduced' }])
  })

  describe('an owner wait for a merge', () => {
    const WAIT = { kind: 'owner.wait', need: 'merge', text: 'merge it', pr: PR, card: CARD }

    function openPr(made: Room, files: string[], body = cardBody(PR)): void {
      made.bench.gitHub.open({ number: PR, head: HEAD, review: 'failure', files, body })
      made.bench.tick()
    }

    function withLiveShard(made: Room, untilMs = 3_600_000): void {
      const now = made.bench.clock.now()
      appendEvent(made.bench.db, { ts: now.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', run: null, scope: 'merge', until: new Date(now.getTime() + untilMs).toISOString(), window: 1 }, legacy: false })
    }

    it('an owner wait for a merge the live shard leaves to the bus is refused', () => {
      const made = room()
      openPr(made, ['scripts/core/queue.ts'])
      withLiveShard(made)
      const request = ask(made, WAIT)
      const [outcome] = made.requests().run()
      expect(outcome).toMatchObject({ kind: 'refused', request, detail: expect.stringContaining(`the merge policy under the live shard ws-1 leaves PR #${PR} to the bus`) as unknown })
      expect(eventsOf(made.bench.db, OWNER_WAIT_OPENED)).toEqual([])
    })

    it('a pull request the shard does not cover still opens the wait', () => {
      const made = room()
      openPr(made, ['.github/workflows/release.yml'])
      withLiveShard(made)
      ask(made, WAIT)
      expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: 'opened Q1' }])
    })

    it.each([
      ['no shard is issued', (): void => {}],
      ['the shard has lapsed', (made: Room): void => withLiveShard(made, -1)],
    ])('with no live shard the wait opens: %s', (_, shard) => {
      const made = room()
      openPr(made, ['scripts/core/queue.ts'])
      shard(made)
      ask(made, WAIT)
      expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: 'opened Q1' }])
    })

    it('a policy that cannot be read leaves the wait open', () => {
      const made = room()
      openPr(made, ['scripts/core/queue.ts'])
      withLiveShard(made)
      made.bench.gitHub.ownerMerges = ''
      made.bench.gitHub.pulls.delete(PR)
      ask(made, WAIT)
      expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: 'opened Q1' }])
    })

    it('a decision wait on the same pull request is not judged by the merge policy', () => {
      const made = room()
      openPr(made, ['scripts/core/queue.ts'])
      withLiveShard(made)
      ask(made, { ...WAIT, need: 'decision' })
      expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: 'opened Q1' }])
    })
  })

  describe('a drop request', () => {
    const REASON = 'a wrong link to a docs pull request'
    const STALE_MS = STALL_MS + 60_000

    function inReviewWithNoBody(made: Room): void {
      const { db } = made.bench
      appendEvent(db, { ts: new Date(Date.now() - STALE_MS).toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: CARD, pr: PR, head: null, dedupeKey: `${PR_OPENED}:${PR}`, payload: { pr: PR, lease_gen: 0 }, legacy: false })
      appendEvent(db, { ts: new Date().toISOString(), type: BUS_PULSE, actor: 'worker:netwatch:bus', cardId: null, pr: null, head: null, dedupeKey: `${BUS_PULSE}:drop`, payload: {}, legacy: false })
      reduce(db, 'pending', busProjections())
    }

    function stateOfCard(made: Room): unknown {
      return (made.bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: unknown } | undefined)?.state
    }

    it('a card with no body in review is dropped with its reason and its stall warning goes', () => {
      const made = room()
      inReviewWithNoBody(made)
      const stalls = (): number[] => productionDeps(made.root, made.bench.busPath).stalls().map(stall => stall.cardId)
      expect(stateOfCard(made)).toBe('in_review')
      expect(stalls()).toEqual([CARD])

      expect(runRequest(['drop', '--card', String(CARD), '--reason', REASON], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(0)
      expect(made.requests().run()).toMatchObject([{ kind: 'done', detail: `${CARD_DROPPED} #${CARD}: ${REASON}` }])
      reduce(made.bench.db, 'pending', busProjections())

      expect(stateOfCard(made)).toBe('dropped')
      expect(stalls()).toEqual([])
      const dropped = made.bench.db.prepare('SELECT actor, card_id, payload FROM events WHERE type = ?').all(CARD_DROPPED) as { actor: string, card_id: number, payload: string }[]
      expect(dropped).toHaveLength(1)
      expect(dropped[0]).toMatchObject({ actor: `worker:window:${SESSION}`, card_id: CARD })
      expect(JSON.parse(dropped[0]!.payload)).toMatchObject({ reason: REASON })
    })

    it('a drop request is refused for a card with a body and names the intake route', () => {
      const made = room()
      inReviewWithNoBody(made)
      admitBody(made, CARD, 'a card line', 'feat/card')
      const request = ask(made, { kind: 'drop', card: CARD, reason: REASON })
      expect(made.requests().run()).toEqual([{ kind: 'refused', request, detail: `card #${CARD} has an admitted body; it drops with pnpm intake --move '#${CARD}' --to dropped` }])
      expect(eventsOf(made.bench.db, CARD_DROPPED)).toEqual([])
      expect(stateOfCard(made)).toBe('in_review')
    })

    it('a drop request is refused for a card that has ended, naming its state', () => {
      const made = room()
      inReviewWithNoBody(made)
      ask(made, { kind: 'drop', card: CARD, reason: REASON })
      made.requests().run()
      reduce(made.bench.db, 'pending', busProjections())
      const again = ask(made, { kind: 'drop', card: CARD, reason: REASON })
      expect(made.requests().run()).toEqual([{ kind: 'refused', request: again, detail: `card #${CARD} is dropped; there is nothing to drop` }])
      expect(eventsOf(made.bench.db, CARD_DROPPED)).toHaveLength(1)
    })

    it('a drop request is refused for a number the bus holds no card under', () => {
      const made = room()
      const request = ask(made, { kind: 'drop', card: CARD, reason: REASON })
      expect(made.requests().run()).toEqual([{ kind: 'refused', request, detail: `the bus holds no card #${CARD}` }])
      expect(eventsOf(made.bench.db, CARD_DROPPED)).toEqual([])
    })

    it('a drop request with no reason is refused by the bus and not written by the command', () => {
      const made = room()
      inReviewWithNoBody(made)
      const request = ask(made, { kind: 'drop', card: CARD, reason: '  ' })
      expect(made.requests().run()).toEqual([{ kind: 'refused', request, detail: 'drop needs a card and the reason it is dropped' }])
      expect(eventsOf(made.bench.db, CARD_DROPPED)).toEqual([])
      expect(runRequest(['drop', '--card', String(CARD)], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(2)
      expect(made.requests().run()).toEqual([])
    })
  })

  it('a request with a known kind and missing fields is not written', () => {
    const made = room()
    const lines: string[] = []
    expect(runRequest(['allow-merge', '--pr', String(PR)], made.bench.db, made.bench.clock.now(), SESSION, line => lines.push(line))).toBe(2)
    expect(made.requests().run()).toEqual([])
  })

  it('a --help on a kind prints the usage and writes no request', async () => {
    const made = room()
    const busPath = path.join(made.root, 'cli-bus.db')
    const script = path.join(import.meta.dirname, '..', '..', 'window', 'window-requests.ts')
    const command = (...argv: string[]): Promise<{ stdout: string }> => promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...argv], { env: { ...process.env, [BUS_DB_VARIABLE]: busPath } })

    const runs = await Promise.all([command('plan', '--help'), command('hold', '--card', '5', '-h'), command('--help'), command('-h')])
    for (const run of runs)
      expect(run.stdout).toContain(`${PREFIX}${USAGE}`)
    expect(existsSync(busPath)).toBe(false)

    await command('mode', '--set', 'window')
    const bus = openBus(busPath)
    expect(pendingRequests(bus).map(request => JSON.parse(request.payload) as unknown)).toEqual([{ kind: 'mode', mode: 'window' }])
    bus.close()
  }, 30_000)

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

  it('a plan request writes the owner\'s plan event, and plan add and plan remove move one card into and out of a release', () => {
    const made = room()
    const planFile = path.join(made.root, 'plan-0.45.md')
    writeFileSync(planFile, '# Plan 0.45\n')
    const asked = (...argv: string[]): void => {
      expect(runRequest(['plan', ...argv], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(0)
    }
    asked('--op', 'open', '--plan', 'p-045', '--title', 'Plan 0.45', '--goal', 'explicit journals', '--file', planFile, '--gate', 'VEDETIRUN')
    asked('--op', 'add', '--plan', 'p-045', '--card', '#901')
    asked('--op', 'add', '--plan', 'p-045', '--card', '902')
    asked('--op', 'add', '--plan', 'p-045')
    asked('--op', 'remove', '--card', '#902')
    asked('--op', 'link', '--plan', 'p-045', '--card', '#903')
    asked('--op', 'open', '--plan', 'p-046', '--title', 'Plan 0.46', '--goal', 'g', '--file', 'plans/0.46.md')
    expect(made.requests().run().map(outcome => [outcome.kind, outcome.detail])).toEqual([
      ['done', 'plan.opened p-045'],
      ['done', 'card.planned p-045 #901'],
      ['done', 'card.planned p-045 #902'],
      ['refused', 'card.planned needs a --card'],
      ['done', 'card.unplanned #902'],
      ['refused', 'plan needs --op open|add|remove|backfill|close and a --plan id; remove needs only the --card'],
      ['refused', 'plan.opened needs a --title, a --goal and an absolute --file that exists'],
    ])
    expect(made.bench.db.prepare(`SELECT actor, count(*) AS n FROM events WHERE type IN ('plan.opened', 'card.planned', 'card.unplanned') GROUP BY actor`).all()).toEqual([{ actor: 'owner', n: 4 }])
    expect(reduce(made.bench.db, 'pending', busProjections()).rejected).toBe(0)
    expect(made.bench.db.prepare('SELECT plan_id, gate FROM plans').all()).toEqual([{ plan_id: 'p-045', gate: 'VEDETIRUN' }])
    expect(made.bench.db.prepare('SELECT card_id, release FROM card_releases').all()).toEqual([{ card_id: 901, release: 'p-045' }])
    expect(ownerInbox(made.bench.db)).toEqual([])
  })

  it('plan.opened carries the version changesets will release, read when the plan opens, and no plan opens while that version cannot be read', () => {
    const made = room()
    const planFile = path.join(made.root, 'plan.md')
    writeFileSync(planFile, '# Plan\n\n| slice | what |\n|---|---|\n| S1 | the journal |\n')
    const open = (plan: string): void => {
      expect(runRequest(['plan', '--op', 'open', '--plan', plan, '--title', plan, '--goal', 'g', '--file', planFile], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(0)
    }
    made.releaseVersion = '0.46.0'
    open('p-046')
    expect(made.requests().run().map(outcome => [outcome.kind, outcome.detail])).toEqual([['done', 'plan.opened p-046']])
    made.releaseVersion = null
    open('p-047')
    expect(made.requests().run().map(outcome => [outcome.kind, outcome.detail])).toEqual([['refused', 'plan.opened could not fetch and read the version changesets will release from origin/main and origin/changeset-release/main']])
    expect(made.bench.db.prepare(`SELECT json_extract(payload, '$.id') AS id, json_extract(payload, '$.version') AS version FROM events WHERE type = 'plan.opened'`).all()).toEqual([{ id: 'p-046', version: '0.46.0' }])
  })

  it('a plan request whose --op names an Object.prototype member is refused with the plan usage and writes no event', () => {
    const made = room()
    for (const op of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(runRequest(['plan', '--op', op, '--plan', 'p-045'], made.bench.db, made.bench.clock.now(), SESSION, () => {})).toBe(0)
    const refusal = 'plan needs --op open|add|remove|backfill|close and a --plan id; remove needs only the --card'
    expect(made.requests().run().map(outcome => [outcome.kind, outcome.detail])).toEqual(Array.from({ length: 4 }, () => ['refused', refusal]))
    expect(made.bench.db.prepare(`SELECT count(*) AS n FROM events WHERE type LIKE 'plan.%'`).get()).toEqual({ n: 0 })
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

  it('a window decisions:add request is written by the bus node into owner-decisions and bus decisions', () => {
    const made = room()
    const file = withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    ownerSays(made, 'allow-live witness for Q13 on card #1214.')
    ownerSays(made, 'Q14: the second path.')
    const before = readFileSync(file, 'utf8')

    const first = windowAsks(made, '--from', ANSWER_SOURCE, '--card', '#1214', '[owner] allow-live witness for Q13 on card #1214.')
    const second = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')
    expect(readFileSync(file, 'utf8')).toBe(before)

    const outcomes = made.requests().run()
    expect(outcomes.map(outcome => [outcome.request, outcome.kind])).toEqual([[first, 'done'], [second, 'done']])
    expect(readFileSync(file, 'utf8')).toContain(`- D-2 · ${stampOf(made.bench.clock.now())} — [owner] allow-live witness for Q13 on card #1214. · card #1214 · decisions:add\n- D-3 · `)
    expect(answerOf(made, first).type).toBe(REQUEST_DONE)
    reduce(made.bench.db, 'pending', busProjections())
    expect(inForceDecisions(made.bench.db)).toEqual([
      { decisionId: 2, text: 'allow-live witness for Q13 on card #1214.', cards: [1214] },
      { decisionId: 3, text: 'Q14: the second path.', cards: [] },
    ])
  })

  it('decisions:add --from answer with no owner file is refused as the owner word not found in the owner channel', () => {
    const made = room()
    const file = withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    const before = readFileSync(file, 'utf8')
    const request = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')

    expect(made.requests().run()).toEqual([{ kind: 'refused', request, detail: OWNER_WORD_NOT_FOUND }])
    expect(answerOf(made, request)).toEqual({ type: REQUEST_REFUSED, detail: 'слово владельца не найдено в канале владельца' })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('decisions:add --from answer with a file from owner:say is written and the file is marked used', () => {
    const made = room()
    const file = withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    const said = ownerSays(made, 'Q14: the second path.')
    const request = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')

    expect(made.requests().run()).toMatchObject([{ kind: 'done', request }])
    expect(answerOf(made, request).type).toBe(REQUEST_DONE)
    expect(readFileSync(file, 'utf8')).toContain(`- D-2 · ${stampOf(made.bench.clock.now())} — [owner] Q14: the second path. · decisions:add\n`)
    expect(readdirSync(channelOf(made))).toEqual([`${path.basename(said)}${USED_WORD}`])
  })

  it('an owner file already used is refused the second time', () => {
    const made = room()
    withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    ownerSays(made, 'Q14: the second path.')
    const first = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')
    const again = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')

    expect(made.requests().run().map(outcome => [outcome.request, outcome.kind, outcome.kind === 'refused' ? outcome.detail : ''])).toEqual([
      [first, 'done', ''],
      [again, 'refused', OWNER_WORD_NOT_FOUND],
    ])
  })

  it('two concurrent decisions:add requests on one owner file accept exactly one', async () => {
    const made = room()
    sayToOwnerChannel(channelOf(made), 'Q14: the second path.', new Date())
    const fixture = path.join(import.meta.dirname, '..', 'owner', 'request-on-channel.ts')
    const startAt = String(Date.now() + 3000)
    const race = (bus: string): Promise<{ stdout: string }> => promisify(execFile)(process.execPath, ['--import', 'tsx', fixture, path.join(made.root, bus), channelOf(made), 'Q14: the second path.', startAt])
    const kinds = (await Promise.all([race('a.db'), race('b.db')])).map(run => run.stdout.trim()).sort()

    expect(kinds).toEqual(['done', 'refused'])
    expect(readdirSync(channelOf(made)).filter(name => name.endsWith(USED_WORD))).toHaveLength(1)
  }, 30_000)

  it('decisions:add --from an owner-order file is refused for a decision', () => {
    const made = room()
    const file = withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    const order = path.join(made.root, '.construct', 'handoff', 'owner-order-s157-q13.md')
    writeFileSync(order, '# Owner order (Eli), verbatim\n\nallow-live witness for Q13 on card #1214.\n')
    ownerSays(made, 'allow-live witness for Q13 on card #1214.')
    const before = readFileSync(file, 'utf8')
    const request = windowAsks(made, '--from', order, '[owner] allow-live witness for Q13 on card #1214.')

    const [outcome] = made.requests().run()
    expect(outcome).toMatchObject({ kind: 'refused', request })
    expect(outcome!.detail).toBe(`decisions:add --from ${order} is not ${ANSWER_SOURCE}; a decision comes only from the owner's word that pnpm owner:say put into the owner channel, never from an owner order file`)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(channelOf(made)).some(name => name.endsWith(USED_WORD))).toBe(false)
  })

  it('a decisions:add write that throws is refused and leaves the owner file unused', () => {
    const made = room()
    const said = ownerSays(made, 'Q14: the second path.')
    const request = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')
    const requests = made.requests({ addDecision: () => {
      throw new Error('the bus event write failed')
    } })

    expect(requests.run()).toEqual([{ kind: 'refused', request, detail: `decisions:add failed: the bus event write failed; owner word ${said} left unused` }])
    expect(readdirSync(channelOf(made))).toEqual([path.basename(said)])
  })

  it('a failed decisions:add whose used owner file is gone is still answered, naming the hand recovery', () => {
    const made = room()
    const said = ownerSays(made, 'Q14: the second path.')
    const request = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] Q14: the second path.')
    const requests = made.requests({ addDecision: () => {
      rmSync(`${said}${USED_WORD}`)
      return { code: 1, lines: ['nothing written'] }
    } })

    expect(requests.run()).toEqual([{ kind: 'refused', request, detail: `nothing written; owner word ${said} stays used though nothing was written; the owner renames ${said}${USED_WORD} back to ${path.basename(said)}` }])
    expect(answerOf(made, request).type).toBe(REQUEST_REFUSED)
  })

  it('a decisions:add request past 8000 bytes in force is written', () => {
    const made = room()
    const file = withDecisionsFile(made, ...Array.from({ length: 7 }, (_, at) => `- D-${at + 1} · 2026-10-08 — ${`decision ${at + 1} `.repeat(100).trim()} · decisions:add`))
    ownerSays(made, 'over '.repeat(300).trim())
    const request = windowAsks(made, '--from', ANSWER_SOURCE, `[owner] ${'over '.repeat(300).trim()}`)

    expect(made.requests().run()).toMatchObject([{ kind: 'done', request }])
    expect(answerOf(made, request).type).toBe(REQUEST_DONE)
    expect(readFileSync(file, 'utf8')).toContain('- D-8 · ')
    expect(readdirSync(channelOf(made)).some(name => name.endsWith(USED_WORD))).toBe(true)
    reduce(made.bench.db, 'pending', busProjections())
    expect(inForceDecisions(made.bench.db).map(decision => decision.decisionId)).toEqual([8])
  })

  it('a decisions:add request is refused for an empty body and for a part of an owner line', () => {
    const made = room()
    const file = withDecisionsFile(made, '- D-1 · 2026-10-08 — first. · decisions:add')
    sayToOwnerChannel(channelOf(made), 'allow-live witness for Q13.\nanother line.', made.bench.clock.now())
    const before = readFileSync(file, 'utf8')
    const empty = windowAsks(made, '--from', ANSWER_SOURCE, '[owner]')
    const part = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] allow')
    const whole = windowAsks(made, '--from', ANSWER_SOURCE, '[owner] allow-live witness for Q13.')
    expect(made.requests().run().map(outcome => [outcome.request, outcome.kind, outcome.detail.slice(0, 30)])).toEqual([
      [empty, 'refused', 'decisions:add: an empty decisi'],
      [part, 'refused', OWNER_WORD_NOT_FOUND.slice(0, 30)],
      [whole, 'done', `- D-2 · ${stampOf(made.bench.clock.now())} — [owner]`.slice(0, 30)],
    ])
    expect(readFileSync(file, 'utf8')).toBe(`${before}- D-2 · ${stampOf(made.bench.clock.now())} — [owner] allow-live witness for Q13. · decisions:add\n`)
  })

  it('a decisions:add request archives the decisions whose card the bus holds merged, with no D-54 in the file', () => {
    const made = room()
    const spent = `- D-1 · 2026-10-09 — ${'spent '.repeat(1200).trim()} · card #${CARD}`
    const file = withDecisionsFile(made, spent)
    appendEvent(made.bench.db, { ts: made.bench.clock.now().toISOString(), type: 'fixture.merged', actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `fixture.merged:${CARD}`, payload: {}, legacy: false })
    const event = (made.bench.db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`fixture.merged:${CARD}`) as { id: number }).id
    made.bench.db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, \'merged\', NULL, ?)').run(CARD, event)

    ownerSays(made, 'kept '.repeat(300).trim())
    const request = windowAsks(made, '--from', ANSWER_SOURCE, `[owner] ${'kept '.repeat(300).trim()}`)
    expect(made.requests().run()).toMatchObject([{ kind: 'done', request }])
    expect(readFileSync(file, 'utf8')).not.toContain(spent)
    expect(readFileSync(file, 'utf8')).toContain('- D-2 · ')
    expect(readFileSync(path.join(made.root, '.construct', 'owner-decisions.archive.md'), 'utf8')).toContain(`${spent}\n`)
  })

  it('a decisions:add request needs one text and one --from, and takes no --file', () => {
    const made = room()
    const asked = (...argv: string[]): number => runRequest(['decisions:add', ...argv], made.bench.db, made.bench.clock.now(), SESSION, () => {})
    expect(asked('[owner] x.')).toBe(2)
    expect(asked('--from', ANSWER_SOURCE, '--file', '/tmp/d.md', '[owner] x.')).toBe(2)
    expect(asked('--from', ANSWER_SOURCE, '[owner] x.', '[owner] y.')).toBe(2)
    expect(made.requests().run()).toEqual([])
  })
})
