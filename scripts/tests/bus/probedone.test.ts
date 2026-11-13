import type { DatabaseSync } from 'node:sqlite'
import type { QueuedTask } from '../../core/queue.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { unsatisfiedDependencies } from '../../core/card-automaton.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_VERIFIED, WITNESS_RECORDED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell, WitnessExecutor } from '../../nodes/witness/witness-executor.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'

const CARD = 1501
const PROBE = 1502
const TS = '2026-10-29T10:00:00.000Z'
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

function world(onMain: string): World {
  const root = mkdtempSync(path.join(tmpdir(), 'probedone-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, onMain), 'done\n')
  git(repo, 'add', onMain)
  git(repo, 'commit', '-q', '-m', 'the owner did it on main')
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const text = parkingFileText({ card: `#${CARD} done-on-main [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/done-on-main', touches: ['done.txt'], continue: 'stop', who: 'shift', body: 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main' })
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  reduce(db, 'pending', busProjections())
  return { repo, db, main: git(repo, 'rev-parse', 'HEAD') }
}

async function witnessOnMain(w: World): Promise<void> {
  const task: QueuedTask = { queue: 'witness', cardId: CARD, head: w.main }
  queueTask(w.db, TS, task)
  const lease = leaseQueued(w.db, TS, keyOf(task), 'worker:witness:probedone')!
  const turns = new SetupTurns()
  await new WitnessExecutor({ db: w.db, clock: () => new Date(TS), shell: realTimedShell, log: () => {}, trees: { baseOf: async () => w.main, withTree: (base, run) => withWorktreeAsync(w.repo, base, run, turns) } }).run(lease)
  reduce(w.db, 'pending', busProjections())
}

function cardState(db: DatabaseSync, cardId: number): string | undefined {
  return (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string } | undefined)?.state
}

describe('a card whose goal is already on main', () => {
  it('a card whose witnesses pass on main closes without a PR', async () => {
    const w = world('done.txt')
    await witnessOnMain(w)

    const closed = w.db.prepare('SELECT pr, head, payload FROM events WHERE type = ? AND card_id = ?').all(CARD_CLOSED, CARD) as { pr: number | null, head: string, payload: string }[]
    expect(closed.map(row => ({ pr: row.pr, head: row.head, payload: JSON.parse(row.payload) as unknown }))).toEqual([{ pr: null, head: w.main, payload: { verification: 'run', witnessedOnMain: w.main } }])
    expect(cardState(w.db, CARD)).toBe('closed')
    expect(unsatisfiedDependencies(w.db)([CARD])).toEqual([])
  })

  it('a card whose witness is red on main records the red and stays open', async () => {
    const w = world('other.txt')
    await witnessOnMain(w)

    const recorded = w.db.prepare('SELECT pr, payload FROM events WHERE type = ? AND card_id = ?').all(WITNESS_RECORDED, CARD) as { pr: number | null, payload: string }[]
    expect(recorded.map(row => [row.pr, (JSON.parse(row.payload) as { verdict: string }).verdict])).toEqual([[null, 'red']])
    expect(w.db.prepare('SELECT 1 FROM events WHERE type = ? AND card_id = ?').get(CARD_CLOSED, CARD)).toBeUndefined()
    expect(cardState(w.db, CARD)).toBe('queued')
    expect(unsatisfiedDependencies(w.db)([CARD])).toEqual([CARD])
  })
})

describe('a probe closed by report', () => {
  it('is a satisfied dependency from its card.verified on, before the close node folds card.closed', () => {
    const w = world('done.txt')
    appendEvent(w.db, { ts: TS, type: CARD_VERIFIED, actor: 'worker:task-close:by-hand', cardId: PROBE, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${PROBE}:${TS}`, payload: { verification: 'run', report: '/reports/1502.md' }, legacy: false })
    reduce(w.db, 'pending', busProjections())

    expect(unsatisfiedDependencies(w.db)([PROBE, CARD])).toEqual([CARD])
  })
})
