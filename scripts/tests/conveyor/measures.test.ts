import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { questionClassOf, runMeasures, measures as takeMeasures, USAGE } from '../../conveyor/measures.js'
import { appendEvent, openBus } from '../../core/db.js'
import { OWNER_WAIT_OPENED, PR_OBSERVED, REVIEW_RECORDED, TASK_COMPLETED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, UPDATE_DONE, WITNESS_RECORDED, WORKER_RETIRING } from '../../core/events.js'
import { RESTART_CUT } from '../../core/lease.js'

const WINDOW = { from: '2026-11-10T00:00:00.000Z', to: '2026-11-13T12:30:00.000Z' }
const INSIDE = '2026-11-11T00:00:00.000Z'
const BEFORE_THE_WINDOW = '2026-11-09T00:00:00.000Z'
const AFTER_THE_WINDOW = '2026-11-13T13:00:00.000Z'
const OLD_WORKER = 'worker:answer:old-generation'
const OTHER_WORKER = 'worker:answer:other-generation'
const roots: string[] = []
const dbs: DatabaseSync[] = []
let sequence = 0

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): { db: DatabaseSync, file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'conveyor-measures-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  const db = openBus(file)
  dbs.push(db)
  return { db, file }
}

function sha(n: number): string {
  return n.toString(16).padStart(40, '0')
}

interface Put {
  type: string
  ts?: string
  actor?: string
  pr?: number | null
  head?: string | null
  payload?: object
}

function put(db: DatabaseSync, { type, ts = INSIDE, actor = 'policy', pr = null, head = null, payload = {} }: Put): void {
  sequence += 1
  appendEvent(db, { ts, type, actor, cardId: pr, pr, head, dedupeKey: `${type}:${sequence}`, payload: JSON.stringify(payload), legacy: false })
}

interface Episode {
  pr: number
  clean: boolean
  after: [string, string][]
  witnessAfter?: string[]
  reviews?: number
  answers?: number
  ts?: string
}

function episode(db: DatabaseSync, { pr, clean, after, witnessAfter = ['green'], reviews = 0, answers = 0, ts = INSIDE }: Episode): void {
  const from = sha(pr * 10)
  const to = sha(pr * 10 + 1)
  put(db, { type: PR_OBSERVED, actor: 'netwatch', pr, head: from, ts, payload: { ci: 'green', mergeable: 'clean' } })
  put(db, { type: WITNESS_RECORDED, pr, head: from, ts, payload: { verdict: 'green', head: from } })
  put(db, { type: UPDATE_DONE, actor: 'worker:update:u', pr, head: from, ts, payload: { from, to, clean } })
  for (const [ci, mergeable] of after)
    put(db, { type: PR_OBSERVED, actor: 'netwatch', pr, head: to, payload: { ci, mergeable } })
  for (const verdict of witnessAfter)
    put(db, { type: WITNESS_RECORDED, pr, head: to, payload: { verdict, head: to } })
  for (let n = 0; n < reviews; n += 1)
    put(db, { type: REVIEW_RECORDED, actor: 'worker:review:r', pr, head: to, payload: { verdict: 'pass' } })
  for (let n = 0; n < answers; n += 1)
    put(db, { type: TASK_LEASED, actor: OTHER_WORKER, pr, head: to, payload: { queue: 'answer', task_key: `answer:${pr}:${n}`, lease_gen: 1 } })
}

const SETTLED_GREEN: [string, string][] = [['pending', 'blocked'], ['green', 'clean']]

describe('measure 1: idle updates over every update.done in the window', () => {
  it('counts as idle only a clean update whose new head settles as the old one stood, with no review and no answer lease, over every update.done of the window', () => {
    const { db } = bus()
    episode(db, { pr: 1, clean: true, after: SETTLED_GREEN })
    episode(db, { pr: 2, clean: true, after: [['green', 'clean'], ['green', 'clean']] })
    episode(db, { pr: 3, clean: false, after: SETTLED_GREEN, reviews: 1 })
    episode(db, { pr: 4, clean: true, after: [['pending', 'blocked'], ['red', 'blocked']], answers: 1 })
    episode(db, { pr: 5, clean: true, after: [['pending', 'blocked']] })
    episode(db, { pr: 6, clean: true, after: SETTLED_GREEN, witnessAfter: ['green', 'red'] })
    episode(db, { pr: 7, clean: true, after: SETTLED_GREEN, reviews: 1 })
    episode(db, { pr: 8, clean: true, after: SETTLED_GREEN, answers: 1 })
    episode(db, { pr: 9, clean: true, after: SETTLED_GREEN, ts: BEFORE_THE_WINDOW })
    episode(db, { pr: 10, clean: true, after: SETTLED_GREEN, ts: AFTER_THE_WINDOW })

    const { idleUpdates } = takeMeasures(db, WINDOW)

    expect({ idle: idleUpdates.idle, updates: idleUpdates.updates }).toEqual({ idle: 2, updates: 8 })
  })
})

interface Lease {
  task: string
  gen?: number
  actor?: string
  queue?: string
}

function leased(db: DatabaseSync, { task, gen = 1, actor = OLD_WORKER, queue = 'answer' }: Lease): void {
  put(db, { type: TASK_LEASED, actor, payload: { queue, task_key: task, lease_gen: gen } })
}

function ended(db: DatabaseSync, type: string, task: string, reason: string | null = null, gen = 1): void {
  put(db, { type, actor: OLD_WORKER, payload: { task_key: task, lease_gen: gen, ...(reason === null ? {} : { reason }) } })
}

describe('measure 2: rounds cut by restart over rounds live at restart', () => {
  it('takes the answer leases the retiring instance held at its worker.retiring, and counts one cut only when a restart released it', () => {
    const { db } = bus()
    leased(db, { task: 'answer:finished-before' })
    ended(db, TASK_COMPLETED, 'answer:finished-before')
    leased(db, { task: 'answer:cut' })
    leased(db, { task: 'answer:signalled' })
    leased(db, { task: 'answer:finished-after' })
    leased(db, { task: 'answer:failed-after' })
    leased(db, { task: 'answer:other-instance', actor: OTHER_WORKER })
    leased(db, { task: 'update:not-a-round', queue: 'update' })
    put(db, { type: WORKER_RETIRING, payload: { worker: OLD_WORKER, node: 'answer', pids: [1], sha: 'a', from: 'b' } })
    ended(db, TASK_RELEASED, 'answer:cut', RESTART_CUT)
    ended(db, TASK_FAILED, 'answer:signalled', 'exit 143')
    ended(db, TASK_COMPLETED, 'answer:finished-after')
    ended(db, TASK_FAILED, 'answer:failed-after', 'answer_failed')
    ended(db, TASK_RELEASED, 'answer:other-instance', RESTART_CUT)
    put(db, { type: WORKER_RETIRING, ts: AFTER_THE_WINDOW, payload: { worker: OTHER_WORKER, node: 'answer', pids: [2], sha: 'a', from: 'b' } })

    expect(takeMeasures(db, WINDOW).restartCuts).toEqual({ cut: 1, live: 4, retirings: 1 })
  })

  it('reads a later lease generation of the same task as its own round', () => {
    const { db } = bus()
    leased(db, { task: 'answer:again', gen: 1 })
    ended(db, TASK_RELEASED, 'answer:again', RESTART_CUT, 1)
    leased(db, { task: 'answer:again', gen: 2 })
    put(db, { type: WORKER_RETIRING, payload: { worker: OLD_WORKER, node: 'answer', pids: [1], sha: 'a', from: 'b' } })
    ended(db, TASK_COMPLETED, 'answer:again', null, 2)

    expect(takeMeasures(db, WINDOW).restartCuts).toEqual({ cut: 0, live: 1, retirings: 1 })
  })
})

const QUESTIONS: [string, string][] = [
  ['the diff of contract/ratchet.json adds law-gaps:Z1:answer: its growth stays the owner\'s under every shard and every decision', 'growth'],
  ['card #1 asks to grow the ratchet row boundary:a->b of contract/ratchet.json; only the owner answers it', 'growth'],
  ['#2: pnpm layers:check is red: (a) add the 4 entries to .dependency-cruiser-known-violations.json (growth, D-514; the card\'s touches allow removal only)', 'growth'],
  ['card #3 asks: the answer for card #3 left changes to .dependency-cruiser-known-violations.json, outside the touches and creates the card was admitted with', 'touches'],
  ['card #4 asks to widen its touches: stopped on scripts/core/card-bodies.ts, contract/ratchet.json; every way grows a ratchet row', 'touches'],
  ['card #5 asks: lint is red because eslint.config.mjs does not list core/x.js, and that file is outside the card touches', 'touches'],
  ['card #6 asks: the bus dropped a deletion from .dependency-cruiser-known-violations.json — may #6 widen to it to delete that one entry?', 'content'],
  ['PR #7 review pass, one finding: the body lacks the concept-owner proposal for accepted.json', 'content'],
]

describe('measure 3: owner questions naming a hand-edited shared registry, by class', () => {
  it.each(QUESTIONS)('%s reads %s', (text, kind) => {
    expect(questionClassOf(text)).toBe(kind)
  })

  it('counts every owner.wait.opened of the window, and the three classes apart among those that name a registry', () => {
    const { db } = bus()
    QUESTIONS.forEach(([text], n) => put(db, { type: OWNER_WAIT_OPENED, payload: { id: `Q${n + 1}`, need: 'decision', text } }))
    put(db, { type: OWNER_WAIT_OPENED, payload: { id: 'Q90', need: 'decision', text: 'hold the bus layer queue until the probe ends?' } })
    put(db, { type: OWNER_WAIT_OPENED, ts: BEFORE_THE_WINDOW, payload: { id: 'Q91', need: 'merge', text: 'the diff of contract/ratchet.json adds a row: its growth stays the owner\'s' } })

    const { registryQuestions } = takeMeasures(db, WINDOW)

    expect(registryQuestions.questions).toBe(9)
    expect(registryQuestions.naming).toBe(8)
    expect(registryQuestions.classes).toEqual({ touches: 3, growth: 3, content: 2 })
    expect(registryQuestions.ids.content).toEqual(['Q7', 'Q8'])
  })
})

describe('the script', () => {
  it('opens the bus read-only: the file is byte for byte the same after a run, and a missing bus is not created', () => {
    const { db, file } = bus()
    episode(db, { pr: 1, clean: true, after: SETTLED_GREEN })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const digest = (): string => createHash('sha256').update(readFileSync(file)).digest('hex')
    const before = digest()
    const lines: string[] = []

    expect(runMeasures(['--from', WINDOW.from, '--to', WINDOW.to], file, line => lines.push(line))).toBe(0)

    expect(lines.join('\n')).toContain('1. idle updates / all updates: 1 / 1 update.done')
    expect(digest()).toBe(before)
    const missing = path.join(path.dirname(file), 'none.db')
    expect(() => runMeasures(['--from', WINDOW.from, '--to', WINDOW.to, '--bus', missing], file, () => {})).toThrow()
    expect(existsSync(missing)).toBe(false)
  })

  it('prints the measures as JSON on --json', () => {
    const { file } = bus()
    const lines: string[] = []
    expect(runMeasures(['--from', WINDOW.from, '--to', WINDOW.to, '--json'], file, line => lines.push(line))).toBe(0)
    expect(JSON.parse(lines[0]!)).toMatchObject({ window: WINDOW, idleUpdates: { idle: 0, updates: 0 }, restartCuts: { cut: 0, live: 0 } })
  })

  it('asks for both ends of the window', () => {
    const { file } = bus()
    const lines: string[] = []
    expect(runMeasures(['--from', WINDOW.from], file, line => lines.push(line))).toBe(2)
    expect(lines).toEqual([USAGE])
  })
})
