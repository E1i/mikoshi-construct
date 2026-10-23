import type { DatabaseSync } from 'node:sqlite'
import type { LockReading } from '../../bus/db.js'
import type { HeldLease } from '../../bus/heartbeat.js'
import type { Lease } from '../../bus/lease.js'
import type { ReviewPlan } from '../../bus/review-depth.js'
import type { SessionGauges } from '../../miko/eddies-measure.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerNode } from '../../bus/answer-worker.js'
import { cardFields } from '../../bus/card-contract.js'
import { CloseNode } from '../../bus/close-worker.js'
import { openBus, watchLocks } from '../../bus/db.js'
import { busSessionPulse, HEAD_VARIABLE, heartbeatEnv, heartbeatOf, lastHeartbeat, LEASE_GEN_VARIABLE, LEASE_VARIABLE, PR_VARIABLE, recordHeartbeat, runHeartbeat, STEP_VARIABLE } from '../../bus/heartbeat.js'
import { expireLeases, LEASE_MS, leaseWhileFree, RENEW_MS, renewLease } from '../../bus/lease.js'
import { MergeNode } from '../../bus/merge-worker.js'
import { busReviewPulse, reviewBeatLine, ReviewNode } from '../../bus/review-worker.js'
import { reviewSession } from '../../bus/reviewer.js'
import { UpdateNode } from '../../bus/update-worker.js'
import { SESSION_HEARTBEAT, TASK_EXPIRED } from '../../core/events.js'
import { NO_TRANSCRIPT, sessionGauges } from '../../miko/eddies-measure.js'
import { CARD_VARIABLE } from '../../ports/session.js'
import { waitFor } from '../wait-for.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'heartbeat.mjs')
const HOOK_MEASURE = path.join(REPO_ROOT, '.claude', 'hooks', 'eddies-measure.mjs')
const BEAT_ENV = { [CARD_VARIABLE]: '1110', [STEP_VARIABLE]: 'implement' }
const START = Date.parse('2026-10-20T02:00:00.000Z')
const HEAD = 'a'.repeat(40)
const LONG_TRANSCRIPT_TURNS = 50_000
const HEARTBEAT_HOLD_MS = 100
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): { db: DatabaseSync, file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'heartbeat-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  return { db: openBus(file), file }
}

function at(ms: number): string {
  return new Date(START + ms).toISOString()
}

function taskState(db: DatabaseSync, lease: Lease): { state: string, lease_until: string | null } {
  return db.prepare('SELECT state, lease_until FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string, lease_until: string | null }
}

function reviewLease(db: DatabaseSync, pr = 940, ms = 0): Lease {
  return leaseWhileFree(db, at(ms), { queue: 'review', cardId: 1110, pr, head: HEAD }, 'worker:review:node-1', 3)!
}

function heldBy(lease: Lease): HeldLease {
  return { taskKey: lease.taskKey, leaseGen: lease.leaseGen }
}

function beat(db: DatabaseSync, ms: number, lease: Lease | null, session = 'session-1'): void {
  recordHeartbeat(db, at(ms), { card: lease?.cardId ?? 1110, pr: lease?.pr ?? null, head: lease?.head ?? null, step: lease?.queue ?? 'launch', session, lease: lease === null ? null : heldBy(lease) })
}

interface Tokens {
  input: number
  cacheWrite: number
  cacheRead: number
}

interface HookMeasure {
  readTranscript: (root: string, transcript: string) => { tokens: Tokens, last: Tokens }
  sumTranscripts: (root: string, files: string[]) => Tokens
  agentTranscriptsUnder: (dir: string) => string[]
  addTokens: (into: Tokens, tokens: Tokens) => Tokens
  contextOf: (tokens: Tokens) => number
  spentOf: (tokens: Tokens) => number
}

function usageLine(requestId: string, usage: { input: number, cacheWrite?: number, cacheRead?: number }): string {
  return JSON.stringify({ type: 'assistant', requestId, message: { role: 'assistant', usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 } } })
}

function sessionTree(session: string, lines: string[]): { home: string, root: string, transcript: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'heartbeat-home-'))
  const root = mkdtempSync(path.join(tmpdir(), 'heartbeat-tree-'))
  roots.push(home, root)
  const transcript = path.join(home, '.claude', 'projects', '-repo', `${session}.jsonl`)
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(transcript, `${lines.join('\n')}\n`)
  return { home, root, transcript }
}

function heartbeatPayloads(file: string): Record<string, number | string>[] {
  const db = openBus(file)
  try {
    return (db.prepare(`SELECT payload FROM events WHERE type = '${SESSION_HEARTBEAT}' ORDER BY id`).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, number | string>)
  }
  finally {
    db.close()
  }
}

function renewsByTimer(node: { prototype: object }): boolean {
  return (node.prototype as { renewsByTimer: () => boolean }).renewsByTimer()
}

describe('a session holds its lease by the heartbeat its hook writes on every turn', () => {
  it('a lease whose process lives and whose session makes no turn expires and its task is queued again', () => {
    const { db } = bus()
    const lease = reviewLease(db)
    beat(db, 60_000, lease)
    expect(expireLeases(db, at(60_000 + LEASE_MS - 1))).toEqual([])
    expect(expireLeases(db, at(60_000 + LEASE_MS + 1))).toEqual([lease.taskKey])
    expect(taskState(db, lease)).toEqual({ state: 'queued', lease_until: null })
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${TASK_EXPIRED}'`).get()).toEqual({ n: 1 })
    db.close()
  })

  it('a lease whose session makes a turn within each lease term holds', () => {
    const { db } = bus()
    const lease = reviewLease(db)
    const turn = LEASE_MS - 60_000
    for (let ms = turn; ms <= 4 * LEASE_MS; ms += turn) {
      beat(db, ms, lease)
      expect(expireLeases(db, at(ms + turn - 1))).toEqual([])
    }
    expect(taskState(db, lease).state).toBe('leased')
    expect(renewsByTimer(ReviewNode)).toBe(false)
    db.close()
  })

  it('a heartbeat holds only the lease its session was given, not another lease of the card or of another card', () => {
    const { db } = bus()
    const ours = reviewLease(db, 940)
    const sibling = reviewLease(db, 941)
    const otherCard = leaseWhileFree(db, at(0), { queue: 'review', cardId: 1111, pr: 942, head: HEAD }, 'worker:review:node-1', 3)!
    beat(db, RENEW_MS, ours)
    expect(expireLeases(db, at(LEASE_MS + 1))).toEqual([sibling.taskKey, otherCard.taskKey])
    expect(taskState(db, ours).state).toBe('leased')
    db.close()
  })

  it('a zombie session of an expired lease does not hold the new lease of its task', () => {
    const { db } = bus()
    const old = reviewLease(db)
    expect(expireLeases(db, at(LEASE_MS + 1))).toEqual([old.taskKey])
    const renewed = leaseWhileFree(db, at(LEASE_MS + 2), { queue: 'review', cardId: 1110, pr: 940, head: HEAD }, 'worker:review:node-2', 3)!
    expect(renewed.leaseGen).toBe(old.leaseGen + 1)
    beat(db, LEASE_MS + RENEW_MS, old, 'zombie')
    expect(expireLeases(db, at(2 * LEASE_MS + 3))).toEqual([renewed.taskKey])
    db.close()
  })

  it('a launch session, whose heartbeat names no pull request and no lease, holds no lease of its card', () => {
    const { db } = bus()
    const review = reviewLease(db)
    const merge = leaseWhileFree(db, at(0), { queue: 'merge', cardId: 1110, pr: 940, head: HEAD }, 'worker:merge:node-1', 1)!
    beat(db, RENEW_MS, null, 'launch-session')
    expect(expireLeases(db, at(LEASE_MS + 1))).toEqual([review.taskKey, merge.taskKey])
    expect(lastHeartbeat(db, 1110)).toMatchObject({ pr: null, step: 'launch', session: 'launch-session' })
    db.close()
  })

  it('a heartbeat naming its lease holds the lease of every queue, a queue the timer renews included', () => {
    const { db } = bus()
    const merge = leaseWhileFree(db, at(0), { queue: 'merge', cardId: 1110, pr: 940, head: HEAD }, 'worker:merge:node-1', 1)!
    beat(db, RENEW_MS, merge)
    expect(expireLeases(db, at(LEASE_MS + 1))).toEqual([])
    expect(expireLeases(db, at(RENEW_MS + LEASE_MS + 1))).toEqual([merge.taskKey])
    db.close()
  })

  it('the review session carries no card in its environment; the worker beats for it, holding its lease and printing a line per beat', () => {
    const { db, file } = bus()
    const lease = reviewLease(db)
    const plan: ReviewPlan = { depth: 'diff', round: 'first', why: 'a fixed plan', since: HEAD, touchFindings: [] }
    const session = reviewSession(REPO_ROOT, tmpdir(), 'reviewer-1', lease, plan, { [CARD_VARIABLE]: '1146' })
    expect(session.env).not.toHaveProperty(CARD_VARIABLE)

    const lines: string[] = []
    busReviewPulse(file, () => new Date(at(RENEW_MS)), line => lines.push(line))(lease, 'reviewer-1')
    expect(lines).toEqual([reviewBeatLine(lease, 'reviewer-1', at(RENEW_MS))])
    expect(lastHeartbeat(db, 1110)).toEqual({ ts: at(RENEW_MS), pr: 940, head: HEAD, step: 'review', session: 'reviewer-1' })
    expect(expireLeases(db, at(LEASE_MS + 1))).toEqual([])
    expect(expireLeases(db, at(RENEW_MS + LEASE_MS + 1))).toEqual([lease.taskKey])
    db.close()
  })

  it('a merge task with no hook holds its lease by the timer', () => {
    const { db } = bus()
    const lease = leaseWhileFree(db, at(0), { queue: 'merge', cardId: 1110, pr: 940, head: HEAD }, 'worker:merge:node-1', 1)!
    for (let ms = RENEW_MS; ms <= 4 * LEASE_MS; ms += RENEW_MS) {
      renewLease(db, at(ms), lease)
      expect(expireLeases(db, at(ms + RENEW_MS))).toEqual([])
    }
    expect(taskState(db, lease).state).toBe('leased')
    expect([MergeNode, UpdateNode, CloseNode, AnswerNode].map(renewsByTimer)).toEqual([true, true, true, true])
    db.close()
  })

  it('cardContract returns the last heartbeat of the card', () => {
    const { db } = bus()
    const lease = reviewLease(db)
    beat(db, 60_000, null, 'session-1')
    beat(db, 120_000, lease, 'session-2')
    recordHeartbeat(db, at(180_000), { card: 1111, pr: null, head: null, step: 'launch', session: 'session-3', lease: null })
    const last = lastHeartbeat(db, 1110)
    expect(last).toEqual({ ts: at(120_000), pr: 940, head: HEAD, step: 'review', session: 'session-2' })
    expect(lastHeartbeat(db, 1112)).toBeNull()
    const parked = { task: { card: { id: 1110, name: 'n', kind: 'k', milestone: 'm', size: 'S', contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: 'l' }, branch: 'b', touches: [], continue: 'stop', body: '' }, who: 'window', priority: null, creates: [] }
    const fields = cardFields(parked as unknown as Parameters<typeof cardFields>[0], { admissionEventId: 1, text: '', textSha: '', lane: null, state: null, lastHeartbeat: last })
    expect(fields.lastHeartbeat).toEqual(last)
    db.close()
  })

  it('the heartbeat CLI records nothing and exits 0 with no card, and records one beat with one', () => {
    const { db, file } = bus()
    db.close()
    const now = (): Date => new Date(START)
    expect(runHeartbeat({}, 'session-1', file, now)).toBe(0)
    expect(runHeartbeat({ [CARD_VARIABLE]: '1110' }, undefined, file, now)).toBe(0)
    const env = { ...heartbeatEnv({ cardId: 1110, pr: 940, head: HEAD, queue: 'review', taskKey: 'review:1110:940', leaseGen: 2 }) }
    expect(env).toEqual({ [CARD_VARIABLE]: '1110', [PR_VARIABLE]: '940', [HEAD_VARIABLE]: HEAD, [STEP_VARIABLE]: 'review', [LEASE_VARIABLE]: 'review:1110:940', [LEASE_GEN_VARIABLE]: '2' })
    expect(heartbeatOf(env, 'session-1')?.lease).toEqual({ taskKey: 'review:1110:940', leaseGen: 2 })
    expect(heartbeatOf(env, 'bad session')).toBeNull()
    expect(runHeartbeat(env, 'session-1', file, now)).toBe(0)
    const reopened = openBus(file)
    expect(reopened.prepare(`SELECT count(*) AS n FROM events WHERE type = '${SESSION_HEARTBEAT}'`).get()).toEqual({ n: 1 })
    expect(lastHeartbeat(reopened, 1110)).toEqual({ ts: at(0), pr: 940, head: HEAD, step: 'review', session: 'session-1' })
    reopened.close()
  })

  it('a live session heartbeat carries context and spent below the warn threshold', () => {
    const { db, file } = bus()
    db.close()
    const { home, root } = sessionTree('session-1', [usageLine('r1', { input: 1_000, cacheWrite: 20_000 }), usageLine('r2', { input: 500, cacheRead: 21_000 })])
    expect(runHeartbeat(BEAT_ENV, 'session-1', file, () => new Date(START), home, root)).toBe(0)
    const payload = heartbeatPayloads(file)[0]!
    expect(payload).toEqual({ step: 'implement', session: 'session-1', context: 21_500, spent: 1_000 + 20_000 * 1.25 + 500 + 21_000 * 0.1 })
    const limits = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'eddies.json'), 'utf8')) as { contextLimit: number, sessionSpend: number, warnRatio: number }
    expect(payload.context).toBeLessThan(limits.contextLimit * limits.warnRatio)
    expect(payload.spent).toBeLessThan(limits.sessionSpend * limits.warnRatio)
    expect(existsSync(path.join(root, '.construct', 'eddies.jsonl'))).toBe(false)
  })

  it('the heartbeat gauges equal the hook measure of the same transcript', async () => {
    const { db, file } = bus()
    db.close()
    const { home, root, transcript } = sessionTree('session-1', [usageLine('r1', { input: 3_000, cacheWrite: 40_000 }), usageLine('r1', { input: 3_100, cacheWrite: 41_000 }), usageLine('r2', { input: 200, cacheRead: 44_000 })])
    const subagents = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(path.join(subagents, 'agent-a1.jsonl'), `${usageLine('s1', { input: 7_000, cacheWrite: 9_000 })}\n`)
    expect(runHeartbeat(BEAT_ENV, 'session-1', file, () => new Date(START), home, root)).toBe(0)
    const measure = await import(pathToFileURL(HOOK_MEASURE).href) as HookMeasure
    const hookRoot = mkdtempSync(path.join(tmpdir(), 'heartbeat-hook-root-'))
    roots.push(hookRoot)
    const parent = measure.readTranscript(hookRoot, transcript)
    const spend = measure.addTokens({ ...parent.tokens }, measure.sumTranscripts(hookRoot, measure.agentTranscriptsUnder(subagents)))
    expect(heartbeatPayloads(file)[0]).toEqual({ step: 'implement', session: 'session-1', context: measure.contextOf(parent.last), spent: measure.spentOf(spend) })
    expect(measure.contextOf(parent.last)).toBe(44_200)
  })

  it('with no transcript the session heartbeat goes out with no-transcript in place of the fields and is no refusal or fault', () => {
    const { db, file } = bus()
    db.close()
    const { home, root } = sessionTree('session-2', [usageLine('r1', { input: 5 })])
    expect(runHeartbeat(BEAT_ENV, 'session-1', file, () => new Date(START), home, root)).toBe(0)
    const empty = mkdtempSync(path.join(tmpdir(), 'heartbeat-home-'))
    roots.push(empty)
    expect(runHeartbeat(BEAT_ENV, 'session-1', file, () => new Date(START + 1000), empty, root)).toBe(0)
    const reopened = openBus(file)
    const rows = reopened.prepare(`SELECT type, payload FROM events ORDER BY id`).all() as { type: string, payload: string }[]
    reopened.close()
    expect(rows.map(row => row.type)).toEqual([SESSION_HEARTBEAT, SESSION_HEARTBEAT])
    expect(rows.map(row => JSON.parse(row.payload))).toEqual([{ step: 'implement', session: 'session-1', reason: NO_TRANSCRIPT }, { step: 'implement', session: 'session-1', reason: NO_TRANSCRIPT }])
  })

  it('a session heartbeat holds the write lock no longer than 100 ms', () => {
    const { db } = bus()
    const lease = reviewLease(db)
    const { home, root } = sessionTree('session-1', Array.from({ length: LONG_TRANSCRIPT_TURNS }, (_, turn) => usageLine(`r${turn}`, { input: 3_000 + turn, cacheRead: 40_000 })))
    const readings: LockReading[] = []
    watchLocks(db, { now: () => performance.now(), observe: reading => readings.push(reading) })
    recordHeartbeat(db, at(60_000), { card: lease.cardId, pr: lease.pr, head: lease.head, step: lease.queue, session: 'session-1', lease: heldBy(lease) }, session => sessionGauges(home, root, session))

    expect(readings.map(reading => reading.outcome)).toEqual(['commit'])
    expect(readings[0]!.holdMs).toBeLessThanOrEqual(HEARTBEAT_HOLD_MS)
    expect(taskState(db, lease).lease_until).not.toBeNull()
    expect(lastHeartbeat(db, lease.cardId)?.ts).toBe(at(60_000))
  })
})

interface HeartbeatHook {
  heartbeatArgv: (root: string, session: string) => string[]
  sessionOf: (text: string) => string | null
}

async function hook(): Promise<HeartbeatHook> {
  return await import(pathToFileURL(HOOK).href) as HeartbeatHook
}

function fakeProject(): { root: string, marker: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'heartbeat-hook-'))
  roots.push(root)
  mkdirSync(path.join(root, 'scripts', 'bus'), { recursive: true })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  const marker = path.join(root, 'beat')
  writeFileSync(path.join(root, 'scripts', 'bus', 'heartbeat.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, process.argv[2] ?? '')\n`)
  return { root, marker }
}

function runHook(root: string, card: string | undefined, input: object): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root }
  delete env[CARD_VARIABLE]
  if (card !== undefined)
    env[CARD_VARIABLE] = card
  expect(spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' }).status).toBe(0)
}

describe('the PostToolUse hook starts the heartbeat CLI only in a session of a card', () => {
  it('heartbeatArgv runs the heartbeat CLI of the project under tsx with the session id', async () => {
    const { heartbeatArgv } = await hook()
    expect(heartbeatArgv('/repo', 'session-1')).toEqual(['--import', 'tsx', path.join('/repo', 'scripts', 'bus', 'heartbeat.ts'), 'session-1'])
  })

  it('sessionOf takes a plain session_id from the hook input and nothing else', async () => {
    const { sessionOf } = await hook()
    expect(sessionOf(JSON.stringify({ session_id: 'f0aa540b-5d0c-4041' }))).toBe('f0aa540b-5d0c-4041')
    expect(sessionOf(JSON.stringify({ session_id: 'a b' }))).toBeNull()
    expect(sessionOf(JSON.stringify({ session_id: 7 }))).toBeNull()
    expect(sessionOf('not json')).toBeNull()
    expect(sessionOf('')).toBeNull()
  })

  it('with no CONSTRUCT_CARD the hook starts nothing, and with one it starts the CLI with the session id', async () => {
    const { root, marker } = fakeProject()
    runHook(root, undefined, { session_id: 'session-1' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(existsSync(marker)).toBe(false)
    runHook(root, '1110', { session_id: 'session-1' })
    await waitFor(() => existsSync(marker), () => `${marker} written by the spawned CLI`, 10_000)
    expect(readFileSync(marker, 'utf8')).toBe('session-1')
  })

  it('a session.heartbeat with step review or answer carries context and spent equal to sessionGauges on the same transcript', () => {
    const { db, file } = bus()
    const review = reviewLease(db)
    const answer = leaseWhileFree(db, at(0), { queue: 'answer', cardId: 1111 }, 'worker:answer:node-1', 1)!
    db.close()
    const { home, root } = sessionTree('session-1', [usageLine('r1', { input: 2_000, cacheWrite: 30_000 }), usageLine('r2', { input: 300, cacheRead: 32_000 })])
    const measure = (session: string): SessionGauges => sessionGauges(home, root, session)
    busReviewPulse(file, () => new Date(at(RENEW_MS)), () => {}, measure)(review, 'session-1')
    busSessionPulse(file, () => new Date(at(RENEW_MS)), measure)(answer, 'session-1')
    const gauges = sessionGauges(home, root, 'session-1')
    expect(gauges).toEqual({ context: 32_300, spent: expect.any(Number) as unknown })
    expect(heartbeatPayloads(file).map(({ step, context, spent }) => ({ step, context, spent }))).toEqual([{ step: 'review', ...gauges }, { step: 'answer', ...gauges }])
  })

  it('with no transcript the heartbeat is written without gauges and nothing fails', () => {
    const { db, file } = bus()
    const review = reviewLease(db)
    db.close()
    const empty = mkdtempSync(path.join(tmpdir(), 'heartbeat-home-'))
    roots.push(empty)
    const lines: string[] = []
    busReviewPulse(file, () => new Date(at(RENEW_MS)), line => lines.push(line), session => sessionGauges(empty, empty, session))(review, 'reviewer-1')
    busSessionPulse(file, () => new Date(at(RENEW_MS + 1)), session => sessionGauges(empty, empty, session))(review, 'reviewer-1')
    expect(lines).toEqual([reviewBeatLine(review, 'reviewer-1', at(RENEW_MS))])
    expect(heartbeatPayloads(file).map(({ step, session, context, spent, reason }) => ({ step, session, context, spent, reason }))).toEqual([
      { step: 'review', session: 'reviewer-1', context: undefined, spent: undefined, reason: NO_TRANSCRIPT },
      { step: 'review', session: 'reviewer-1', context: undefined, spent: undefined, reason: NO_TRANSCRIPT },
    ])
  })
})
