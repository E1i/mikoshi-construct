import type { BgResult } from '../../supervisor/bg.js'
import type { BusSupervisor, WorkerKeeper } from '../../supervisor/supervisor.js'
import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { TURN_JOURNAL_FILE } from '../../../src/commands/cost/turns.js'
import { CLOSED_CARD, MERGED_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { CARD_CLOSED, CARD_DROPPED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, QUESTION_OWNER, WINDOW_HEARTBEAT } from '../../core/events.js'
import { superviseUntilReplaced } from '../../supervisor/supervisor.js'
import { STARTER_ACTOR } from '../../window/window-prs.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { lastEndsOfSessions, SESSION_JOURNAL, WINDOW_SESSION_END_ACTOR, WINDOW_SESSION_SWEEP_MS, WindowSessionEnds } from '../../window/window-session-end.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1624
const SESSION = 'f128fb23'
const REASON = 'the window session is gone and the bus has no route'
const HOOK = path.resolve(import.meta.dirname, '../../../.claude/hooks/turn-journal.mjs')

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

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  made: MergeBench
  root: string
  ends: WindowSessionEnds
  sweep: () => string[]
  later: (ms?: number) => string
}

interface StartFields {
  actor?: string
  shift?: string
  cardId?: number
  worktree?: string
}

function bench(): Bench {
  const made = mergeBench()
  benches.push(made)
  const root = mkdtempSync(path.join(tmpdir(), 'window-session-end-'))
  roots.push(root)
  mkdirSync(path.join(root, '.construct'))
  const ends = new WindowSessionEnds(made.db, root, () => made.clock.now().getTime())
  const later = (ms = 1000): string => {
    made.clock.advance(ms)
    return made.clock.now().toISOString()
  }
  return { made, root, ends, later, sweep: () => {
    made.clock.advance(WINDOW_SESSION_SWEEP_MS)
    return ends.step()
  } }
}

function started(made: MergeBench, fields: StartFields = {}): void {
  const cardId = fields.cardId ?? CARD
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: fields.actor ?? `${STARTER_ACTOR}${SESSION}`, cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}:${ts}`, payload: { session: SESSION, branch: 'feat/x', ...(fields.shift === undefined ? {} : { shift: fields.shift }), ...(fields.worktree === undefined ? {} : { worktree: fields.worktree }) }, legacy: false })
}

function journal(root: string, line: unknown): void {
  appendFileSync(path.join(root, TURN_JOURNAL_FILE), `${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
}

function sessionEnd(root: string, at: string, session = SESSION): void {
  journal(root, { v: 1, kind: 'session-end', session, at, reason: 'prompt_input_exit' })
}

function endsOf(made: MergeBench, card = CARD): unknown[] {
  return (made.db.prepare(`SELECT actor, payload FROM events WHERE card_id = ? AND type = '${CARD_SESSION_ENDED}'`).all(card) as { actor: string, payload: string }[]).map(row => ({ actor: row.actor, ...JSON.parse(row.payload) as object }))
}

function heartbeat(made: MergeBench, ts: string, root?: string): void {
  appendEvent(made.db, { ts, type: WINDOW_HEARTBEAT, actor: `worker:window:${SESSION}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${ts}`, payload: { session: SESSION, ...(root === undefined ? {} : { root }) }, legacy: false })
}

function endedLine(at: string): string {
  return `${CARD_SESSION_ENDED} #${CARD}: its window session ${SESSION} ended at ${at}`
}

function stateOfCard(made: MergeBench): unknown {
  return (made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD) as { state: unknown } | undefined)?.state
}

function mergedPullRequest(made: MergeBench): number {
  const pr = CARD - 100
  made.gitHub.open({ number: pr })
  made.tick()
  made.gitHub.close(pr, true)
  made.tick()
  return pr
}

function treeWithJournal(): string {
  const tree = mkdtempSync(path.join(tmpdir(), 'window-session-tree-'))
  roots.push(tree)
  mkdirSync(path.join(tree, '.construct'))
  return tree
}

function takeover(made: MergeBench): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(['takeover', '--card', String(CARD), '--reason', REASON])!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run()[0]!
}

describe('the end of a window session', () => {
  it('a window card whose session has ended is taken over', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('has not ended') as unknown })
    sessionEnd(root, later())
    sweep()
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ ground: expect.stringContaining(`its window session ${SESSION}`) as unknown })])
  })

  it('the ended session of a window card writes card.session.ended once', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    const at = later()
    sessionEnd(root, at)
    expect(sweep()).toEqual([`${CARD_SESSION_ENDED} #${CARD}: its window session ${SESSION} ended at ${at}`])
    expect(sweep()).toEqual([])
    expect(endsOf(made)).toEqual([{ actor: WINDOW_SESSION_END_ACTOR, session: SESSION, stopped: false, detail: expect.stringContaining(at) as unknown }])
  })

  it('a window card whose session is alive still refuses a takeover', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    journal(root, { v: 1, kind: 'turn', session: SESSION, at: later() })
    sessionEnd(root, later(), 'another-session')
    expect(sweep()).toEqual([])
    expect(endsOf(made)).toEqual([])
    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('has not ended') as unknown })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([])
  })
})

describe('what does not prove a window session ended', () => {
  it('an end older than the start of the card writes nothing: the session went on to start it', () => {
    const { made, root, later, sweep } = bench()
    const before = made.clock.now().toISOString()
    later()
    started(made)
    sessionEnd(root, before)
    expect(sweep()).toEqual([])
  })

  it('a line of the session after its end writes nothing: the session was resumed', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    sessionEnd(root, later())
    journal(root, { v: 1, kind: 'turn', session: SESSION, at: later() })
    expect(sweep()).toEqual([])
  })

  it('a heartbeat of the session after its end writes nothing', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    sessionEnd(root, later())
    heartbeat(made, later())
    expect(sweep()).toEqual([])
  })

  it('an end at the very moment of the start proves the end: the older-than check is strict', () => {
    const { made, root, sweep } = bench()
    started(made)
    const at = made.clock.now().toISOString()
    sessionEnd(root, at)
    expect(sweep()).toEqual([endedLine(at)])
  })

  it('a heartbeat at the very moment of the end proves the end: only a later one is a resume', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    const at = later()
    heartbeat(made, at)
    sessionEnd(root, at)
    expect(sweep()).toEqual([endedLine(at)])
  })

  it('a missing journal and a torn line write nothing and fail nothing', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    expect(sweep()).toEqual([])
    journal(root, `{"kind":"session-end","session":"${SESSION}","at":"${later()}`)
    expect(sweep()).toEqual([])
  })

  it('a journal that cannot be read writes nothing and names the failure', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    later()
    rmSync(path.join(root, '.construct'), { recursive: true })
    mkdirSync(path.join(root, TURN_JOURNAL_FILE), { recursive: true })
    expect(sweep()).toEqual([expect.stringContaining('reading the ends of window sessions failed')])
    expect(endsOf(made)).toEqual([])
  })

  it('reads the ends only once per sweep period', () => {
    const { made, root, ends, later } = bench()
    started(made)
    expect(ends.step()).toEqual([])
    sessionEnd(root, later())
    expect(ends.step()).toEqual([])
    made.clock.advance(WINDOW_SESSION_SWEEP_MS)
    expect(ends.step()).toHaveLength(1)
  })
})

describe('the cards the sweep leaves to their own writers', () => {
  it('a card the launch worker started is the launch worker\'s to end', () => {
    const { made, root, later, sweep } = bench()
    started(made, { actor: 'worker:launch:launch-1' })
    sessionEnd(root, later())
    expect(sweep()).toEqual([])
  })

  it('a card a shift started through task:start is not a window card', () => {
    const { made, root, later, sweep } = bench()
    started(made, { shift: 'shift-1' })
    sessionEnd(root, later())
    expect(sweep()).toEqual([])
  })

  it('a card that has ended gets no end of its session', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    appendEvent(made.db, { ts: later(), type: CARD_DROPPED, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { reason: 'dropped' }, legacy: false })
    made.tick()
    sessionEnd(root, later())
    expect(sweep()).toEqual([])
  })

  it('a merged card gets no end of its session', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    mergedPullRequest(made)
    expect(stateOfCard(made)).toBe(MERGED_CARD)
    sessionEnd(root, later())
    expect(sweep()).toEqual([])
  })

  it('a closed card gets no end of its session', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    const pr = mergedPullRequest(made)
    appendEvent(made.db, { ts: later(), type: CARD_CLOSED, actor: 'worker:task-close:window', cardId: CARD, pr, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: {}, legacy: false })
    made.tick()
    expect(stateOfCard(made)).toBe(CLOSED_CARD)
    sessionEnd(root, later())
    expect(sweep()).toEqual([])
  })

  it('a card started again in a later session is judged by that session', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    sessionEnd(root, later())
    expect(sweep()).toHaveLength(1)
    later()
    started(made)
    expect(sweep()).toEqual([])
    expect(endsOf(made)).toHaveLength(1)
  })
})

describe('where the end of a session is read', () => {
  it('names the journal the cost report reads', () => {
    expect(SESSION_JOURNAL).toBe(TURN_JOURNAL_FILE)
  })

  it('reads the line the SessionEnd hook itself writes', () => {
    const { made, root, sweep } = bench()
    started(made)
    const hook = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION, reason: 'prompt_input_exit' }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' })
    expect(hook.status).toBe(0)
    expect(sweep()).toHaveLength(1)
    expect(endsOf(made)).toEqual([expect.objectContaining({ session: SESSION, stopped: false })])
  })

  it('reads the journal in the tree the card was started on', () => {
    const { made, later, sweep } = bench()
    const tree = treeWithJournal()
    started(made, { worktree: tree })
    sessionEnd(tree, later())
    expect(sweep()).toHaveLength(1)
  })

  it('takes the latest end when the bus root holds the later of two', () => {
    const { made, root, later, sweep } = bench()
    const tree = treeWithJournal()
    started(made, { worktree: tree })
    sessionEnd(tree, later())
    const latest = later()
    sessionEnd(root, latest)
    expect(sweep()).toEqual([endedLine(latest)])
  })

  it('takes the latest end when the tree of the card holds the later of two', () => {
    const { made, root, later, sweep } = bench()
    const tree = treeWithJournal()
    started(made, { worktree: tree })
    sessionEnd(root, later())
    const latest = later()
    sessionEnd(tree, latest)
    expect(sweep()).toEqual([endedLine(latest)])
  })

  it('reads the journal in the project root the heartbeats of the session name', () => {
    const { made, later, sweep } = bench()
    const project = treeWithJournal()
    started(made)
    heartbeat(made, later(), project)
    sessionEnd(project, later())
    expect(sweep()).toHaveLength(1)
  })

  it('takes the last end of a session a journal holds twice', () => {
    expect([...lastEndsOfSessions('{"kind":"session-end","session":"a","at":"1"}\n{"kind":"turn","session":"a"}\n{"kind":"session-end","session":"a","at":"2"}\n[]\nnull\n')]).toEqual([['a', '2']])
  })
})

describe('the takeover ground of an ended window session', () => {
  it('an open pull request keeps its bus route: the session end alone is no ground', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    made.gitHub.open({ number: CARD - 100 })
    made.tick()
    expect(made.db.prepare('SELECT card_id FROM prs WHERE pr = ?').get(CARD - 100)).toEqual({ card_id: CARD })
    sessionEnd(root, later())
    expect(sweep()).toHaveLength(1)
    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('the bus has its route') as unknown })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([])
  })

  it('a stop after the start is judged by the stop, not by the ground', () => {
    const { made, root, later, sweep } = bench()
    started(made)
    sessionEnd(root, later())
    sweep()
    appendEvent(made.db, { ts: later(), type: CARD_STOPPED, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_OWNER, detail: 'a question' }, legacy: false })
    made.tick()
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ ground: expect.stringContaining('owner stop') as unknown })])
  })
})

describe('the supervisor tick', () => {
  it('runs the sweep on each tick and prints what it wrote', async () => {
    const { made, root, ends, later } = bench()
    started(made)
    const at = later()
    sessionEnd(root, at)
    made.clock.advance(WINDOW_SESSION_SWEEP_MS)
    const printed: string[] = []
    const replaced: BgResult = { stdout: [], stderr: [], exitCode: 0 }
    let steps = 0
    await superviseUntilReplaced({
      supervisor: { step: async () => [], get ownCodeBehind() {
        return steps++ === 0 ? null : 'new-head'
      } } as unknown as BusSupervisor,
      keeper: { step: () => [] } as unknown as WorkerKeeper,
      windowEnds: ends,
      relaunch: () => replaced,
      print: line => printed.push(line),
      pause: async () => {},
    })
    expect(printed).toContain(`${CARD_SESSION_ENDED} #${CARD}: its window session ${SESSION} ended at ${at}`)
    expect(endsOf(made)).toHaveLength(1)
  })
})
