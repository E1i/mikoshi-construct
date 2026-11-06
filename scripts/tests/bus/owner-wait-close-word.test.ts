import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBusWait, openOwnerWait } from '../../core/db.js'
import { CARD_STOPPED, OWNER_WAIT_CLOSED, QUESTION_OWNER, SHARD_DECIDED, SHARD_ISSUED } from '../../core/events.js'
import { ANSWER_SOURCE, OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { cardDecisionCommand, DECISIONS_SCOPE } from '../../policy/shards.js'
import { OWNER_WORD_NEEDED, runRequest, WindowRequests } from '../../window/window-requests.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1680
const WORDS = 'Q: the owner says go'

interface Room {
  made: MergeBench
  channel: string
}

const rooms: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of rooms.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function room(): Room {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'owner-wait-close-word-'))
  rooms.push({ made, root })
  return { made, channel: path.join(root, 'owner-answers') }
}

function plainWait({ made }: Room): string {
  const wait = openOwnerWait(made.db, made.clock.now().toISOString(), 'policy', { need: 'decision', text: 'which path?', card: CARD, request: 7 })
  reduce(made.db)
  return wait
}

function stoppedWait({ made }: Room): string {
  const ts = made.clock.now().toISOString()
  const wait = openBusWait(made.db, ts, 'worker:answer:s1', { need: 'decision', text: `card #${CARD} asks: may the retry back off?`, command: cardDecisionCommand(CARD), card: CARD })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_OWNER, detail: 'may the retry back off?' }, legacy: false })
  reduce(made.db)
  return wait
}

function liveDecisionsShard({ made }: Room): void {
  const now = made.clock.now()
  appendEvent(made.db, { ts: now.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'owner', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
}

function closes({ made, channel }: Room, wait: string, ...flags: string[]): { kind: string, detail: string } {
  const refuse = (): never => {
    throw new Error('closing a wait uses no tool')
  }
  expect(runRequest(['owner.wait.close', '--id', wait, '--answer', WORDS, ...flags], made.db, made.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(made.db, made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, channel).run()
  return outcome!
}

function stateOf({ made }: Room, wait: string): string {
  reduce(made.db)
  return (made.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

function openStopOf({ made }: Room): number | null {
  reduce(made.db)
  return (made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD) as { id: number } | undefined)?.id ?? null
}

describe('closing an owner wait needs the owner\'s word', () => {
  it('owner.wait.close without --from on an owner wait is refused', () => {
    const open = room()
    const wait = plainWait(open)

    const outcome = closes(open, wait)

    expect(outcome.kind).toBe('refused')
    expect(outcome.detail).toContain(OWNER_WORD_NEEDED)
    expect(outcome.detail).toContain(`--from ${ANSWER_SOURCE}`)
    expect(stateOf(open, wait)).toBe('open')
    expect(eventsOf(open.made.db, OWNER_WAIT_CLOSED)).toEqual([])
  })

  it('the word sitting in the channel does not stand in for --from', () => {
    const open = room()
    const wait = plainWait(open)
    const word = sayToOwnerChannel(open.channel, WORDS, open.made.clock.now())

    expect(closes(open, wait).kind).toBe('refused')
    expect(stateOf(open, wait)).toBe('open')
    expect(existsSync(word)).toBe(true)
  })

  it('a close without --from on a stopped card with no shard leaves the wait and the stop open', () => {
    const open = room()
    const wait = stoppedWait(open)
    const stop = openStopOf(open)
    expect(stop).not.toBeNull()

    expect(closes(open, wait).kind).toBe('refused')
    expect(stateOf(open, wait)).toBe('open')
    expect(openStopOf(open)).toBe(stop)
  })

  it('a live decisions shard is no ground where the card has no open stop to decide', () => {
    const open = room()
    liveDecisionsShard(open)
    const wait = plainWait(open)

    expect(closes(open, wait).kind).toBe('refused')
    expect(stateOf(open, wait)).toBe('open')
    expect(eventsOf(open.made.db, SHARD_DECIDED)).toEqual([])
  })

  it('the owner\'s word from the channel closes the wait', () => {
    const open = room()
    const wait = plainWait(open)
    const word = sayToOwnerChannel(open.channel, WORDS, open.made.clock.now())

    expect(closes(open, wait, '--from', ANSWER_SOURCE).kind).toBe('done')
    expect(stateOf(open, wait)).toBe('closed')
    expect(existsSync(`${word}${USED_WORD}`)).toBe(true)
  })

  it('under a live decisions shard the close on a stopped card is recorded as a shard decision', () => {
    const open = room()
    liveDecisionsShard(open)
    const wait = stoppedWait(open)

    expect(closes(open, wait).kind).toBe('done')
    expect(stateOf(open, wait)).toBe('closed')
    expect(eventsOf(open.made.db, SHARD_DECIDED)).toEqual([expect.objectContaining({ shard: 'ws-1', wait })])
  })

  it('a wait already closed is reported as closed, not as a missing word', () => {
    const open = room()
    const wait = plainWait(open)
    sayToOwnerChannel(open.channel, WORDS, open.made.clock.now())
    expect(closes(open, wait, '--from', ANSWER_SOURCE).kind).toBe('done')
    reduce(open.made.db)

    expect(closes(open, wait)).toMatchObject({ kind: 'refused', detail: `${wait} is closed already` })
  })
})
