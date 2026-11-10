import type { Needs, RunJob } from '../../ci/required.js'
import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { GitHub } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { ABANDONED_TITLE, blockingJobs, ranNeeds, REQUIRED_JOB, requiredSummary, rerunDue } from '../../ci/required.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, CI_RERUN_REQUESTED, OWNER_WAIT_OPENED, PR_OPENED, SCOPE_WIDENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, queueTask, queueTaskWithin, updateCandidates } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1775
const SESSION = 'answer-session-1'
const OUTSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/tests/supervisor/stalled-sessions.test.ts, outside the touches; the witnesses are green'
const INSIDE_TIMEOUT = 'prepush timed out under machine load in scripts/a.ts; the witnesses are green'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function answerAsking(question: string): Promise<{ made: MergeBench, outcome: Awaited<ReturnType<AnswerExecutor['answer']>>, published: number }> {
  const made = mergeBench()
  benches.push(made)
  const trees = tempDir('bus-standing-')
  mkdirSync(path.join(trees, `mc-${CARD}`))
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(trees, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => ({ session: SESSION, resumed: true, before: sha('a'), after: sha('a'), owner: question })
  let published = 0
  const publish = (): void => {
    published += 1
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: CARD, pr: 9775, head: null, dedupeKey: `${PR_OPENED}:${CARD}:9775`, payload: { pr: 9775 }, legacy: false })
  }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, publishing: { committed: () => true, publish } })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  return { made, outcome: await executor.answer(lease), published }
}

const TOUCHED = 'scripts/a.ts'
const IMPORTER = 'scripts/b.ts'
const CARD_FILES: Record<string, string> = {
  'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`,
  [TOUCHED]: 'export const a = 1\n',
  [IMPORTER]: 'import { a } from \'./a.js\'\n\nexport const b = a\n',
}

function gitTree(worktree: string): void {
  for (const [file, text] of Object.entries(CARD_FILES)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
}

async function answerEditing(changed: readonly string[]): Promise<{ made: MergeBench, outcome: Awaited<ReturnType<AnswerExecutor['answer']>>, published: string[] }> {
  const made = mergeBench()
  benches.push(made)
  const home = tempDir('bus-standing-importer-')
  const worktree = path.join(home, `mc-${CARD}`)
  gitTree(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'the importer follows the renamed export' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  const published: string[] = []
  const heads = [sha('a'), sha('e')]
  const answerer = claudeAnswerer(path.join(home, 'answers'), {
    cardText: () => text,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      for (const file of [TOUCHED, ...changed])
        writeFileSync(path.join(worktree, file), `${CARD_FILES[file] ?? ''}// answered\n`)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: card => published.push(card.branch),
    pending: () => [TOUCHED, ...changed],
  })
  const cardTrees: CardTreeTools = { home, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  return { made, outcome: await executor.answer(lease), published }
}

describe('a direct importer of a touched file in an answer round (D-441 (1), Z3)', () => {
  it('an answer that edits a direct importer of a touched file commits with no owner.wait', async () => {
    const { made, outcome, published } = await answerEditing([IMPORTER])

    expect(outcome).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(published).toEqual([`feat/card-${CARD}`])
    expect(eventsOf(made.db, SCOPE_WIDENED)).toMatchObject([{ paths: [IMPORTER] }])
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })
})

describe('a timeout under load in an answer round (D-441 (2))', () => {
  it('a timeout under load outside the touches with green witnesses is retried, not stopped', async () => {
    const { made, outcome, published } = await answerAsking(OUTSIDE_TIMEOUT)

    expect(outcome).toMatchObject({ kind: 'published', pr: 9775 })
    expect(published).toBe(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(1)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a timeout under load inside the touches is still asked, and nothing is pushed', async () => {
    const { outcome, published } = await answerAsking(INSIDE_TIMEOUT)

    expect(outcome.kind).not.toBe('published')
    expect(published).toBe(0)
  })
})

const PR = 1493
const RUN = 4343
const REQUIRED_RUN_ID = 77
const STEP = { name: 'Run', status: 'completed' }
const NEEDS = ['changes', 'checks', 'lint', 'typecheck', 'vitest', 'docs', 'package', 'contract-bump', 'acceptance']

function needsWith(failed: readonly string[]): Needs {
  return Object.fromEntries(NEEDS.map(job => [job, { result: failed.includes(job) ? 'failure' : 'success', ...(job === 'changes' ? { outputs: { 'fast-path': 'false' } } : {}) }])) as Needs
}

function jobsWithout(needs: Needs, abandoned: readonly string[]): RunJob[] {
  return [...Object.keys(needs).filter(job => !abandoned.includes(job)).map(job => ({ name: job, runner_name: 'runner', steps: [STEP] })), { name: REQUIRED_JOB, runner_name: 'runner', steps: [STEP] }]
}

interface BusReading {
  blocking: string[]
  answers: number
  updates: number
  reruns: number[]
  rerunEvents: number
}

function busReading(failed: readonly string[], abandoned: readonly string[], failedChecks: string[]): BusReading {
  const needs = needsWith(failed)
  const blocking = blockingJobs(needs, ranNeeds(needs, jobsWithout(needs, abandoned)))
  const title = rerunDue(blocking) ? ABANDONED_TITLE : requiredSummary(blocking)
  const db = openBus(path.join(tempDir('bus-standing-ci-'), 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const client: GitHub = (endpoint) => {
    if (endpoint === `repos/{owner}/{repo}/check-runs/${REQUIRED_RUN_ID}/annotations`)
      return { status: 200, headers: {}, body: [{ title }] }
    const response = gitHub.client(endpoint)
    if (!endpoint.includes('/check-runs'))
      return response
    const body = response.body as { check_runs: { name: string, conclusion: string | null }[] }
    return { ...response, body: { check_runs: body.check_runs.map(check => check.name === REQUIRED_JOB && check.conclusion === 'failure' ? { ...check, id: REQUIRED_RUN_ID, output: { annotations_count: 1, annotations_url: `https://api.github.com/repos/{owner}/{repo}/check-runs/${REQUIRED_RUN_ID}/annotations` } } : check) } }
  }
  const busTick = new BusTick(db, new NetWatch(db, client, clock.now), clock.now, () => {})
  busTick.run()
  clock.advance(TICK_MS)
  gitHub.open({ number: PR, required: 'failure', failed: failedChecks, runs: [{ id: RUN, run_attempt: 1, status: 'completed', conclusion: 'failure' }] })
  busTick.run()
  clock.advance(TICK_MS)
  const ts = clock.now().toISOString()
  const answers = answerCandidates(db, ts).filter(task => task.pr === PR).length
  const updates = updateCandidates(db, ts).filter(task => task.pr === PR)
  for (const task of updates)
    queueTaskWithin(db, ts, task)
  const lease = leaseNext(db, ts, 'update', 'worker:update:worker-1')
  if (lease !== null)
    new UpdateExecutor({ db, gitHub: client, put: gitHub.put, post: gitHub.post, publish: gitHub.publish, clock: clock.now, settle: () => {} }).update(lease)
  const rerunEvents = Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND pr = ?').get(CI_RERUN_REQUESTED, PR) as { n: number }).n)
  db.close()
  return { blocking, answers, updates: updates.length, reruns: gitHub.reruns, rerunEvents }
}

describe('a required red only from abandoned jobs (D-441 (3))', () => {
  it('a required red only from abandoned jobs is rerun and queues no answer', () => {
    const reading = busReading(['vitest'], ['vitest'], [])

    expect(reading.blocking).toEqual(['vitest: abandoned'])
    expect(reading.answers).toBe(0)
    expect(reading.updates).toBe(1)
    expect(reading.reruns).toEqual([RUN])
    expect(reading.rerunEvents).toBe(1)
  })

  it('a required red from a job that ran and failed queues an answer and no rerun', () => {
    const reading = busReading(['lint'], [], ['lint'])

    expect(reading.blocking).toEqual(['lint: failure'])
    expect(reading.answers).toBe(1)
    expect(reading.updates).toBe(0)
    expect(reading.reruns).toEqual([])
  })
})
