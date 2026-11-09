import type { DatabaseSync } from 'node:sqlite'
import type { MergeVerdict } from '../../policy/policy.js'
import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { appendEvent, BUS_DB_VARIABLE, openBus, openBusWait, openOwnerWait } from '../../core/db.js'
import { CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, QUESTION_AGENT, QUESTION_OWNER, REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { ANSWER_SOURCE, OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { completeTask, failTask, leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from '../../intake/intake.js'
import { sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { mergePolicy } from '../../policy/policy.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { cardBody, sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1731
const HOLD_REASON = 'the owner reads the tree'
const TAKEOVER_REASON = 'the window answers it by hand'
const TOUCH = 'src/board/run.ts'
const REFUSED = 'src/board/tail.ts'
const NOW = new Date('2026-11-09T09:00:00.000Z')

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const UNUSED_REQUEST_TOOLS: RequestTools = {
  treeOf: () => '',
  exists: () => false,
  cutTree: () => {},
  dryRunOf: () => null,
  addDecision: () => ({ code: 1, lines: [] }),
  causeHolds: () => null,
  closePr: () => ({ kind: 'refused', detail: 'unused' }) as never,
  closeDropped: () => [],
}

function temporary(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function request(made: MergeBench, argv: string[], channel?: string): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS, channel).run()[0]!
}

function cardWithAQueuedAnswer(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: 'unused', branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `a question on card #${CARD}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}`, payload: { session: 'card-session-1', pgid: 1, stopped: false, detail: 'ended' }, legacy: false })
  made.tick()
  return made
}

function answerStatesOf(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT state FROM tasks WHERE card_id = ? AND queue = 'answer'`).all(CARD) as { state: string }[]).map(row => row.state)
}

function patchOf(removed: readonly string[], added: readonly string[]): string {
  return `@@ -1,${removed.length + 1} +1,${added.length + 1} @@\n${[...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n')}\n x`
}

function verdictOn(patch: string): MergeVerdict {
  const file = 'scripts/policy/policy.ts'
  return mergePolicy({ cardId: 1042, description: cardBody(942), headRef: 'feat/card-1042', title: 'feat: card #1042', files: [file], patched: [{ filename: file, patch }], ownerMergesText: readFileSync('architecture/owner-merges.md', 'utf8'), shardActive: false, shardUnder: null, windowShard: null, decisions: [] })
}

interface AmendWorld { db: DatabaseSync, repo: string, root: string }

function amendWorld(): AmendWorld {
  const root = temporary('no-silent-waits-amend-')
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, TOUCH), '')
  writeFileSync(path.join(repo, REFUSED), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  const db = openBus(bus)
  const body = `card: #${CARD} stopped-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCH}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nwitnesses: ${JSON.stringify([{ id: 'W1', run: 'pnpm exec vitest run tests/w1.test.ts', test: 'the W1 test', head: 'pass', base: 'fail', proves: 'what W1 proves' }])}\n`
  const admitted = runAdmit({ file: path.join(root, `${CARD}.md`), body, dir: repo, dryRun: false, autoConfirm: true, events: busCardEvents(db), admissions: busCardAdmissions(db), cardStates: () => busHeldCards(db) }, () => NOW)
  expect(admitted.status).toBe('admitted')
  reduce(db)
  return { db, repo, root }
}

function stoppedOutsideTouches(w: AmendWorld): void {
  const ts = NOW.toISOString()
  queueTask(w.db, ts, { queue: 'answer', cardId: CARD })
  const lease = leaseNext(w.db, ts, 'answer', 'worker:answer:a1')!
  completeTask(w.db, ts, lease, [])
  openBusWait(w.db, ts, 'worker:answer:a1', { need: 'decision', text: `card #${CARD} asks: may the answer touch ${REFUSED}?`, command: cardDecisionCommand(CARD), card: CARD })
  appendEvent(w.db, { ts, type: CARD_STOPPED, actor: 'worker:answer:a1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:outside`, payload: { reason: QUESTION_OWNER, detail: `the answer left changes to ${REFUSED}`, widen: [REFUSED] }, legacy: false })
  reduce(w.db)
}

function amended(w: AmendWorld, touches: string): { type: string, detail: string } {
  const id = requestFromWindow(w.db, NOW.toISOString(), 'window-1', { kind: 'amend', card: CARD, touches })
  new WindowRequests(w.db, () => new Date(NOW.getTime() + 60_000), UNUSED_REQUEST_TOOLS, path.join(w.root, 'channel'), () => null, w.repo, {} as never).run()
  reduce(w.db)
  return w.db.prepare(`SELECT type, json_extract(payload, '$.detail') AS detail FROM events WHERE type IN (?, ?) AND json_extract(payload, '$.request') = ?`).get(REQUEST_DONE, REQUEST_REFUSED, id) as { type: string, detail: string }
}

describe('no silent waits: window requests, the owner channel, the answer node and the merge policy', () => {
  it('owner say close by question id closes the wait without the verbatim text', () => {
    const made = mergeBench()
    benches.push(made)
    const channel = path.join(temporary('no-silent-waits-channel-'), 'answers')
    const wait = openOwnerWait(made.db, made.clock.now().toISOString(), 'policy', { need: 'decision', text: 'which path?', card: CARD, request: 7 })
    reduce(made.db)

    const missing = request(made, ['owner.wait.close', '--id', wait, '--from', ANSWER_SOURCE], channel)
    expect(missing.kind).toBe('refused')
    expect(missing.detail).toContain(`${wait} waits for the owner's word naming ${wait}`)
    expect(missing.detail).toContain(`"${wait}: <the answer>"`)

    const word = sayToOwnerChannel(channel, `${wait}: take the second path, worded my own way`, made.clock.now())
    const closed = request(made, ['owner.wait.close', '--id', wait, '--answer', 'a paraphrase the channel never held', '--from', ANSWER_SOURCE], channel)

    expect(closed).toMatchObject({ kind: 'done' })
    expect(closed.detail).toContain('take the second path, worded my own way')
    expect(existsSync(`${word}${USED_WORD}`)).toBe(true)
    reduce(made.db)
    expect((made.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state).toBe('closed')
  })

  it('a held card can be taken over and release does not restart an answer while the owner holds the tree', () => {
    const made = cardWithAQueuedAnswer()
    expect(request(made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON]).kind).toBe('done')
    const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    failTask(made.db, made.clock.now().toISOString(), lease, { reason: 'held_for_owner', withdraw: true })

    const takenOver = request(made, ['takeover', '--card', String(CARD), '--reason', TAKEOVER_REASON])
    expect(takenOver).toMatchObject({ kind: 'done' })
    expect(takenOver.detail).toContain(`the owner holds it: ${HOLD_REASON}`)
    expect(made.db.prepare(`SELECT 1 FROM events WHERE type = ? AND card_id = ?`).get(CARD_TAKEOVER, CARD)).toBeDefined()
    expect(cardHoldOf(made.db, CARD)).toBe(`card #${CARD} is taken over by the window: ${TAKEOVER_REASON} (held for the owner: ${HOLD_REASON})`)

    const first = request(made, ['release', '--card', String(CARD)])
    expect(first.detail).toContain(`queued nothing: card #${CARD} is held for the owner: ${HOLD_REASON}; the answer resumes when the owner releases it`)
    expect(answerStatesOf(made.db)).toEqual(['withdrawn'])

    expect(request(made, ['release', '--card', String(CARD)]).detail).toContain('queued again')
    expect(cardHoldOf(made.db, CARD)).toBeNull()
    expect(answerStatesOf(made.db)).toEqual(['queued'])
  })

  it('unsandboxed command detector compares imported symbol sets not lines', () => {
    const widened = verdictOn(patchOf(['import { execFileSync } from \'node:child_process\''], ['import { execFileSync, spawnSync } from \'node:child_process\'']))
    expect(widened).toMatchObject({ kind: 'denied', rule: 'unsandboxed_command' })
    expect(widened.detail).toContain('an import of child_process (spawnSync)')

    const unchanged = [
      [['import { execFileSync, spawnSync } from \'node:child_process\''], ['import { spawnSync, execFileSync } from \'node:child_process\'']],
      [['import { execFileSync, spawnSync } from \'node:child_process\''], ['import {', '  execFileSync,', '  spawnSync,', '} from \'node:child_process\'']],
      [['import { execFileSync } from \'node:child_process\''], ['import { execFileSync } from \'child_process\'', 'import type { SpawnSyncReturns } from \'node:child_process\'']],
    ] as const
    for (const [removed, added] of unchanged)
      expect(verdictOn(patchOf(removed, added)), added.join('\n')).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an amend that widens the touches of a stopped card requeues its answer', () => {
    const w = amendWorld()
    stoppedOutsideTouches(w)
    expect(w.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD)).toBeDefined()
    expect(answerStatesOf(w.db)).toEqual(['completed'])

    const answer = amended(w, `+${REFUSED}`)

    expect(answer.type).toBe(REQUEST_DONE)
    expect(answer.detail).toContain('is settled: its answer')
    expect(answerStatesOf(w.db)).toEqual(['queued'])
    expect(w.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD)).toBeUndefined()
    w.db.close()
  })
})
