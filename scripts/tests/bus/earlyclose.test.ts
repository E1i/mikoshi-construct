import type { DatabaseSync } from 'node:sqlite'
import type { QueuedTask } from '../../core/queue.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_CONTINUED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, PR_CLOSED, PR_OBSERVED, WITNESS_RECORDED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell, WitnessExecutor } from '../../nodes/witness/witness-executor.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'

const CARD = 1601
const PR = 1602
const SESSION = 'session-1601'
const TS = '2026-11-03T10:00:00.000Z'
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

interface World { repo: string, db: DatabaseSync, main: string }

function greenOnTheBase(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'earlyclose-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'base')
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const text = parkingFileText({ card: `#${CARD} earlyclose [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/earlyclose', touches: ['README.md'], continue: 'stop', who: 'shift', body: 'Touch README.md.\n\nWitnesses:\n- `test -f README.md` exits 0' })
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  reduce(db, 'pending', busProjections())
  return { repo, db, main: git(repo, 'rev-parse', 'HEAD') }
}

interface Mark { legacy?: boolean, at?: number }

function started(w: World, { legacy = false, at = 1 }: Mark = {}): void {
  appendEvent(w.db, { ts: TS, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${SESSION}:${at}`, payload: { session: SESSION, branch: 'feat/earlyclose' }, legacy })
  reduce(w.db, 'pending', busProjections())
}

function continued(w: World): void {
  appendEvent(w.db, { ts: TS, type: CARD_CONTINUED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CONTINUED}:${CARD}:${SESSION}`, payload: { session: SESSION }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function sessionEnded(w: World, { legacy = false, at = 1 }: Mark = {}): void {
  appendEvent(w.db, { ts: TS, type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}:${SESSION}:${at}`, payload: { session: SESSION, stopped: false, detail: 'the session exited' }, legacy })
  reduce(w.db, 'pending', busProjections())
}

function stopped(w: World): void {
  appendEvent(w.db, { ts: TS, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question_owner', detail: 'the owner decides' }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function prOpened(w: World): void {
  appendEvent(w.db, { ts: TS, type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head: w.main, dedupeKey: `${PR_OBSERVED}:${PR}:${w.main}`, payload: { card_id: CARD, base: 'main', head: w.main, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function prClosed(w: World, merged: boolean): void {
  appendEvent(w.db, { ts: TS, type: PR_CLOSED, actor: 'netwatch', cardId: CARD, pr: PR, head: w.main, dedupeKey: `${PR_CLOSED}:${PR}`, payload: { merged }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function prState(db: DatabaseSync): string | undefined {
  return (db.prepare('SELECT state FROM prs WHERE pr = ?').get(PR) as { state: string } | undefined)?.state
}

async function witnessOnMain(w: World): Promise<void> {
  const task: QueuedTask = { queue: 'witness', cardId: CARD, head: w.main }
  queueTask(w.db, TS, task)
  const lease = leaseQueued(w.db, TS, keyOf(task), 'worker:witness:earlyclose')!
  const turns = new SetupTurns()
  await new WitnessExecutor({ db: w.db, clock: () => new Date(TS), shell: realTimedShell, log: () => {}, trees: { baseOf: async () => w.main, withTree: (base, run) => withWorktreeAsync(w.repo, base, run, turns) } }).run(lease)
  reduce(w.db, 'pending', busProjections())
}

function closes(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(CARD_CLOSED, CARD) as { n: number }).n
}

function verdicts(db: DatabaseSync): string[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? AND card_id = ?').all(WITNESS_RECORDED, CARD) as { payload: string }[]).map(row => (JSON.parse(row.payload) as { verdict: string }).verdict)
}

describe('a witness green on main closes a card only when no session runs for it and no pull request of its own is open', () => {
  it('a witness green on the base does not close a card with a live session', async () => {
    const w = greenOnTheBase()
    started(w)
    await witnessOnMain(w)

    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(0)
  })

  it('a session continued after it ended is live again, and the card stays open', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w)
    continued(w)
    await witnessOnMain(w)

    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(0)
  })

  it('a legacy session end does not end a live session', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w, { legacy: true })
    await witnessOnMain(w)

    expect(closes(w.db)).toBe(0)
  })

  it('a legacy session start after a live one does not hide the live one', async () => {
    const w = greenOnTheBase()
    started(w)
    started(w, { legacy: true, at: 2 })
    await witnessOnMain(w)

    expect(closes(w.db)).toBe(0)
  })

  it('a legacy session start is no live session, and the card closes', async () => {
    const w = greenOnTheBase()
    started(w, { legacy: true })
    await witnessOnMain(w)

    expect(closes(w.db)).toBe(1)
  })

  it('closes the card once its session ended and it opened no pull request', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w)
    await witnessOnMain(w)

    expect(closes(w.db)).toBe(1)
  })

  it('closes the card once its session stopped', async () => {
    const w = greenOnTheBase()
    started(w)
    stopped(w)
    await witnessOnMain(w)

    expect(closes(w.db)).toBe(1)
  })

  it('a witness green on the base does not close a card with an open pull request of its own', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w)
    prOpened(w)
    await witnessOnMain(w)

    expect(prState(w.db)).toBe('open')
    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(0)
  })

  it('closes a card whose own pull request merged', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w)
    prOpened(w)
    prClosed(w, true)
    await witnessOnMain(w)

    expect(prState(w.db)).toBe('merged')
    expect(closes(w.db)).toBe(1)
  })

  it('closes a card whose own pull request was closed without merging, so the abandoned PR does not hold it open forever', async () => {
    const w = greenOnTheBase()
    started(w)
    sessionEnded(w)
    prOpened(w)
    prClosed(w, false)
    await witnessOnMain(w)

    expect(prState(w.db)).toBe('closed')
    expect(closes(w.db)).toBe(1)
  })
})
