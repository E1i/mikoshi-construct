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
import { CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT, WITNESS_RECORDED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell, WitnessExecutor } from '../../nodes/witness/witness-executor.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { busProjections, cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'

const CARD = 2349
const TS = '2026-11-26T10:00:00.000Z'
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

interface World { repo: string, db: DatabaseSync, main: string, text: string }

function admit(db: DatabaseSync, text: string, key: string): void {
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${key}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
}

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'stopped-on-main-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'done.txt'), 'done\n')
  git(repo, 'add', 'done.txt')
  git(repo, 'commit', '-q', '-m', 'the witness passes on main')
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const text = parkingFileText({ card: `#${CARD} stopped-on-main [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/stopped-on-main', touches: ['done.txt'], continue: 'stop', who: 'shift', body: 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main' })
  admit(db, text, 'first')
  reduce(db, 'pending', busProjections())
  return { repo, db, main: git(repo, 'rev-parse', 'HEAD'), text }
}

function started(w: World): void {
  appendEvent(w.db, { ts: TS, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: w.repo, branch: 'feat/stopped-on-main', base: w.main }, legacy: false })
}

function stopped(w: World): void {
  appendEvent(w.db, { ts: TS, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:agent`, payload: { reason: QUESTION_AGENT, detail: 'which file?' }, legacy: false })
}

async function witnessOnMain(w: World): Promise<void> {
  reduce(w.db, 'pending', busProjections())
  const task: QueuedTask = { queue: 'witness', cardId: CARD, head: w.main }
  queueTask(w.db, TS, task)
  const lease = leaseQueued(w.db, TS, keyOf(task), 'worker:witness:stopped-on-main')!
  const turns = new SetupTurns()
  await new WitnessExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: w.db, clock: () => new Date(TS), shell: realTimedShell, log: () => {}, trees: { baseOf: async () => w.main, withTree: (base, run) => withWorktreeAsync(w.repo, base, run, turns) } }).run(lease)
  reduce(w.db, 'pending', busProjections())
}

function closes(db: DatabaseSync): number {
  return db.prepare('SELECT 1 FROM events WHERE type = ? AND card_id = ?').all(CARD_CLOSED, CARD).length
}

function verdicts(db: DatabaseSync): string[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? AND card_id = ?').all(WITNESS_RECORDED, CARD) as { payload: string }[]).map(row => (JSON.parse(row.payload) as { verdict: string }).verdict)
}

describe('a card closed on main only when its latest turn leaves no open work', () => {
  it('a card whose latest turn is a stop is not closed when its witnesses are green on main', async () => {
    const w = world()
    started(w)
    stopped(w)
    await witnessOnMain(w)

    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(0)
  })

  it('an amended card with no session after its amend is not closed on main', async () => {
    const w = world()
    started(w)
    stopped(w)
    admit(w.db, w.text, 'amend')
    await witnessOnMain(w)

    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(0)
  })

  it('a card that never started is still closed when its witnesses are green on main', async () => {
    const w = world()
    await witnessOnMain(w)

    expect(verdicts(w.db)).toEqual(['green'])
    expect(closes(w.db)).toBe(1)
  })
})
