import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnerWait } from '../../core/db.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { consumeOwnerWord, consumeOwnerWordClosing, OWNER_WORD_TERM_MS, sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { busProjections } from '../../supervisor/composition.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'
import { mergeBench } from '../bus/merge-bench.js'

const CARD = 1876
const ANSWER = 'the second path'
const HOUR_MS = 3_600_000

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
  const root = mkdtempSync(path.join(tmpdir(), 'word-bound-to-one-wait-'))
  rooms.push({ made, root })
  return { made, channel: path.join(root, 'owner-answers') }
}

function waitFor({ made }: Room, text = 'which path?'): string {
  const wait = openOwnerWait(made.db, made.clock.now().toISOString(), 'policy', { need: 'decision', text, card: CARD, request: 7 })
  reduce(made.db, 'pending', busProjections())
  return wait
}

function close({ made, channel }: Room, wait: string, answer?: string): { kind: string, detail: string } {
  const refuse = (): never => {
    throw new Error('closing a wait uses no tool')
  }
  expect(runRequest(['owner.wait.close', '--id', wait, ...(answer === undefined ? [] : ['--answer', answer]), '--from', ANSWER_SOURCE], made.db, made.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(made.db, made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, channel).run()
  return outcome!
}

function stateOf({ made }: Room, wait: string): string {
  reduce(made.db, 'pending', busProjections())
  return (made.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(wait) as { state: string }).state
}

describe('a word of the owner is bound to one wait, used once, within its term', () => {
  it('an old word does not close a new wait with the same text', () => {
    const open = room()
    const earlier = waitFor(open)
    const forTheEarlier = sayToOwnerChannel(open.channel, `${earlier}: ${ANSWER}`, open.made.clock.now())
    const bare = sayToOwnerChannel(open.channel, ANSWER, open.made.clock.now())
    open.made.clock.advance(OWNER_WORD_TERM_MS + 1)
    const later = waitFor(open)
    const stale = sayToOwnerChannel(open.channel, `${later}: ${ANSWER}`, new Date(open.made.clock.now().getTime() - OWNER_WORD_TERM_MS - 1))

    expect(close(open, later, ANSWER).kind).toBe('refused')
    expect(stateOf(open, later)).toBe('open')
    expect(close(open, earlier).kind).toBe('refused')
    expect(stateOf(open, earlier)).toBe('open')
    expect([forTheEarlier, bare, stale].every(existsSync)).toBe(true)

    const fresh = sayToOwnerChannel(open.channel, `${later}: ${ANSWER}`, open.made.clock.now())
    expect(close(open, later).kind).toBe('done')
    expect(stateOf(open, later)).toBe('closed')
    expect(existsSync(`${fresh}${USED_WORD}`)).toBe(true)
  })

  it('a word naming another wait does not close this one', () => {
    const open = room()
    const one = waitFor(open)
    const other = waitFor(open, 'which other path?')
    const word = sayToOwnerChannel(open.channel, `${other}: ${ANSWER}`, open.made.clock.now())

    expect(close(open, one, `${other}: ${ANSWER}`).kind).toBe('refused')
    expect(stateOf(open, one)).toBe('open')
    expect(existsSync(word)).toBe(true)
    expect(consumeOwnerWordClosing(open.channel, `${one}0`, open.made.clock.now())).toBeNull()
  })

  it('a used word does not fire twice', () => {
    const open = room()
    const wait = waitFor(open)
    sayToOwnerChannel(open.channel, `${wait}: ${ANSWER}`, open.made.clock.now())
    expect(close(open, wait).kind).toBe('done')
    expect(consumeOwnerWordClosing(open.channel, wait, open.made.clock.now())).toBeNull()

    const move = 'requeue launch:1876'
    sayToOwnerChannel(open.channel, move, open.made.clock.now())
    expect(consumeOwnerWord(open.channel, move, open.made.clock.now())).not.toBeNull()
    expect(consumeOwnerWord(open.channel, move, open.made.clock.now())).toBeNull()
  })

  it('a move word past its term moves nothing', () => {
    const open = room()
    const move = 'requeue launch:1876'
    sayToOwnerChannel(open.channel, move, open.made.clock.now())
    const later = new Date(open.made.clock.now().getTime() + OWNER_WORD_TERM_MS + HOUR_MS)
    expect(consumeOwnerWord(open.channel, move, later)).toBeNull()
    expect(consumeOwnerWord(open.channel, move, open.made.clock.now())).not.toBeNull()
  })
})
