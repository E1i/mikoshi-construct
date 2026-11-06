import type { OwnerWaitAsk } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { amendedText } from '../../../src/commands/intake/amend.js'
import { appendEvent, openBusWait, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, QUESTION_OWNER, SHARD_ISSUED } from '../../core/events.js'
import { ANSWER_SOURCE, OPEN_OWNER_STOP_OF_CARD } from '../../core/inbox.js'
import { leaseNext } from '../../core/lease.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerOutsideTouches } from '../../nodes/answer/answerer.js'
import { OWNER_WORD_NOT_FOUND, sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { cardDecisionCommand, DECISIONS_SCOPE } from '../../policy/shards.js'
import { requestOf, runRequest, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1492
const CARD_PR = CARD - 100
const RESERVED_QUESTION = 'may I change architecture/owner-merges.md?'
const OWNER_WORDS = 'Q: yes, change it'

interface Room {
  made: MergeBench
  channel: string
  stop: number
  wait: string
  body: string
}

const rooms: { made: MergeBench, root: string }[] = []

afterEach(() => {
  for (const { made, root } of rooms.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function lastEventId(made: MergeBench): number {
  return Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function admit(made: MergeBench, text: string, generation: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${generation}`, payload: { card: `#${CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
  reduce(made.db)
}

function stoppedRoom(question: string = RESERVED_QUESTION, underAShard = true, admittedBefore = true, bodyEnd = 'Do it.'): Room {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'stop-lift-'))
  rooms.push({ made, root })
  const body = `card: #${CARD} stoplift [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/stoplift\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\n${bodyEnd}\n`
  if (admittedBefore)
    admit(made, body, 'body-1')
  const now = made.clock.now()
  if (underAShard)
    appendEvent(made.db, { ts: now.toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'owner', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
  const { stop, wait } = stopWithItsWait(made, question, 'first')
  return { made, channel: path.join(root, 'owner-answers'), stop, wait, body }
}

function stopWithItsWait(made: MergeBench, question: string, generation: string): { stop: number, wait: string } {
  const ts = made.clock.now().toISOString()
  const wait = openBusWait(made.db, ts, 'worker:answer:s1', { need: 'decision', text: `card #${CARD} asks: ${question}`, command: cardDecisionCommand(CARD), card: CARD })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:${generation}`, payload: { reason: QUESTION_OWNER, detail: question }, legacy: false })
  const stop = lastEventId(made)
  reduce(made.db)
  return { stop, wait }
}

function openStop(room: Room): number | null {
  reduce(room.made.db)
  return (room.made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD) as { id: number } | undefined)?.id ?? null
}

function waitState(room: Room): string {
  reduce(room.made.db)
  return (room.made.db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(room.wait) as { state: string }).state
}

function closes(room: Room, answer: string, ...flags: string[]): { kind: string, detail: string } {
  const refuse = (): never => {
    throw new Error('not this request')
  }
  const argv = ['owner.wait.close', '--id', room.wait, '--answer', answer, ...flags]
  expect(runRequest(argv, room.made.db, room.made.clock.now(), 'test', () => {})).toBe(0)
  const [outcome] = new WindowRequests(room.made.db, room.made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, room.channel).run()
  return outcome!
}

function amendsWithNote(room: Room, generation: string, note: string): void {
  const edited = amendedText(room.body, { note })
  if (edited.kind !== 'edited')
    throw new Error(edited.why)
  room.body = edited.text
  admit(room.made, edited.text, generation)
}

describe('a question.owner stop has a named lift for each route', () => {
  it('owner answer lifts a reserved stop', () => {
    const room = stoppedRoom()
    const word = sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())
    expect(openStop(room)).toBe(room.stop)

    const outcome = closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE)

    expect(outcome.kind).toBe('done')
    expect(outcome.detail).toContain(`lifted the card #${CARD} stop ${room.stop}`)
    expect(waitState(room)).toBe('closed')
    expect(openStop(room)).toBeNull()
    expect(existsSync(`${word}${USED_WORD}`)).toBe(true)
  })

  it('owner answer lifts a stop with no shard active, where a window close is refused', () => {
    const answered = stoppedRoom('may the retry back off?', false)
    sayToOwnerChannel(answered.channel, OWNER_WORDS, answered.made.clock.now())
    expect(closes(answered, OWNER_WORDS, '--from', ANSWER_SOURCE).kind).toBe('done')
    expect(openStop(answered)).toBeNull()

    const refused = stoppedRoom('may the retry back off?', false)
    expect(closes(refused, 'yes').kind).toBe('refused')
    expect(waitState(refused)).toBe('open')
    expect(openStop(refused)).toBe(refused.stop)
  })

  it('--from answer without the word in the channel is refused and lifts nothing', () => {
    const room = stoppedRoom()

    expect(closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE)).toMatchObject({ kind: 'refused', detail: OWNER_WORD_NOT_FOUND })
    expect(waitState(room)).toBe('open')
    expect(openStop(room)).toBe(room.stop)
  })

  it('--from anything but answer is refused even with the word in the channel', () => {
    const room = stoppedRoom()
    const word = sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

    expect(closes(room, OWNER_WORDS, '--from', 'order-file').kind).toBe('refused')
    expect(waitState(room)).toBe('open')
    expect(openStop(room)).toBe(room.stop)
    expect(existsSync(word)).toBe(true)
  })

  it('a wait already closed spends no owner word', () => {
    const room = stoppedRoom('may the retry back off?', false)
    sayToOwnerChannel(room.channel, 'yes', room.made.clock.now())
    expect(closes(room, 'yes', '--from', ANSWER_SOURCE).kind).toBe('done')
    reduce(room.made.db)
    const word = sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

    expect(closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE)).toMatchObject({ kind: 'refused', detail: `${room.wait} is closed already` })
    expect(existsSync(word)).toBe(true)
  })

  it('a close that fails after the word is claimed leaves the word unused', () => {
    const room = stoppedRoom()
    const word = sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())
    appendEvent(room.made.db, { ts: room.made.clock.now().toISOString(), type: OWNER_WAIT_CLOSED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${OWNER_WAIT_CLOSED}:not-reduced-yet`, payload: { id: room.wait, answer: 'closed elsewhere' }, legacy: false })

    const outcome = closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE)

    expect(outcome.kind).toBe('refused')
    expect(outcome.detail).toContain('left unused')
    expect(existsSync(word)).toBe(true)
  })

  it('an owner answer before the stop does not lift it', () => {
    const room = stoppedRoom('first question', false)
    sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())
    expect(closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE).kind).toBe('done')
    appendEvent(room.made.db, { ts: room.made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:second`, payload: { reason: QUESTION_OWNER, detail: 'second question' }, legacy: false })

    expect(openStop(room)).toBe(lastEventId(room.made))
  })

  it('window close of a reserved stop stays refused', () => {
    const room = stoppedRoom()
    sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

    const outcome = closes(room, OWNER_WORDS)

    expect(outcome.kind).toBe('refused')
    expect(outcome.detail).toContain(`stop ${room.stop} on owner-merges`)
    expect(waitState(room)).toBe('open')
    expect(openStop(room)).toBe(room.stop)
  })

  it('amend that answers the question lifts the stop', () => {
    for (const named of [(room: Room) => `answers stop ${room.stop}`, (room: Room) => `answers ${room.wait}: yes`]) {
      const room = stoppedRoom()
      amendsWithNote(room, 'other', 'widens nothing the question asked')
      expect(openStop(room)).toBe(room.stop)

      amendsWithNote(room, 'named', named(room))
      expect(openStop(room)).toBeNull()
    }
  })

  it('an amend does not lift on a longer name, a first admission, or a name it only carried forward', () => {
    const longer = stoppedRoom()
    amendsWithNote(longer, 'stop-prefix', `see ${longer.stop}0 and ${longer.wait}0`)
    expect(openStop(longer)).toBe(longer.stop)

    const first = stoppedRoom(RESERVED_QUESTION, true, false)
    admit(first.made, `${first.body}\nanswers ${first.wait}\n`, 'first')
    expect(openStop(first)).toBe(first.stop)

    const carried = stoppedRoom(RESERVED_QUESTION, true, true, 'earlier mention of Q1')
    expect(carried.wait).toBe('Q1')
    amendsWithNote(carried, 'carried-forward', 'something else')
    expect(openStop(carried)).toBe(carried.stop)
  })

  it('an amend that answered an earlier stop does not lift a later one', () => {
    const room = stoppedRoom('first question', false)
    amendsWithNote(room, 'named', `answers ${room.wait}`)
    expect(openStop(room)).toBeNull()
    appendEvent(room.made.db, { ts: room.made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:second`, payload: { reason: QUESTION_OWNER, detail: 'second question' }, legacy: false })

    expect(openStop(room)).toBe(lastEventId(room.made))
  })

  it('an amend naming the card\'s older wait lifts only the stop of that wait', () => {
    const room = stoppedRoom('first question', false)
    sayToOwnerChannel(room.channel, 'yes', room.made.clock.now())
    expect(closes(room, 'yes', '--from', ANSWER_SOURCE).kind).toBe('done')
    reduce(room.made.db)
    const later = stopWithItsWait(room.made, 'second question', 'second')
    expect(later.wait).not.toBe(room.wait)

    amendsWithNote(room, 'names-older', `see ${room.wait}`)
    expect(openStop(room)).toBe(later.stop)

    amendsWithNote(room, 'names-later', `answers ${later.wait}`)
    expect(openStop(room)).toBeNull()
  })

  it('an amend naming another wait of the card does not lift the stop', () => {
    const room = stoppedRoom()
    const other = openOwnerWait(room.made.db, room.made.clock.now().toISOString(), 'policy', { need: 'merge', text: 'merge it', card: CARD, pr: CARD_PR })
    reduce(room.made.db)

    amendsWithNote(room, 'names-other', `see ${other}`)

    expect(openStop(room)).toBe(room.stop)
  })

  it('the owner\'s word on a second wait of the card closes that wait and lifts nothing', () => {
    const asks: OwnerWaitAsk[] = [
      { need: 'command', text: 'run it', command: 'pnpm bus:status', card: CARD },
      { need: 'decision', text: 'another need', command: cardDecisionCommand(CARD), card: CARD, request: 7 },
      { need: 'decision', text: 'another pull request', command: cardDecisionCommand(CARD), card: CARD, pr: CARD_PR },
    ]
    for (const ask of asks) {
      const room = stoppedRoom()
      const other = openOwnerWait(room.made.db, room.made.clock.now().toISOString(), 'policy', ask)
      reduce(room.made.db)
      sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

      const outcome = closes({ ...room, wait: other }, OWNER_WORDS, '--from', ANSWER_SOURCE)

      expect(outcome.kind).toBe('done')
      expect(outcome.detail).not.toContain('lifted')
      expect(waitState({ ...room, wait: other })).toBe('closed')
      expect(waitState(room)).toBe('open')
      expect(openStop(room)).toBe(room.stop)
    }
  })

  it('a stop that took a wait still open shares it, and the owner\'s word on it lifts both', () => {
    const room = stoppedRoom('first question', false)
    const later = stopWithItsWait(room.made, 'second question', 'second')
    expect(later.wait).toBe(room.wait)
    sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

    expect(closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE).detail).toContain(`lifted the card #${CARD} stop ${later.stop}`)

    expect(openStop(room)).toBeNull()
  })

  it('a request with no valid form prints how the owner\'s word closes a wait', () => {
    const room = stoppedRoom()
    const lines: string[] = []

    expect(runRequest(['owner.wait.close', '--id', room.wait], room.made.db, room.made.clock.now(), 'test', line => lines.push(line))).toBe(2)

    expect(lines.at(-1)).toContain(`--from ${ANSWER_SOURCE}`)
  })

  it('--from reaches the request only when it is given', () => {
    expect(requestOf(['owner.wait.close', '--id', 'Q1', '--answer', 'yes'])).toEqual({ kind: 'owner.wait.close', id: 'Q1', answer: 'yes' })
    expect(requestOf(['owner.wait.close', '--id', 'Q1', '--answer', 'yes', '--from', ANSWER_SOURCE])).toEqual({ kind: 'owner.wait.close', id: 'Q1', answer: 'yes', from: ANSWER_SOURCE })
  })
})

const OWNER_PATH = 'architecture/owner-merges.md'

function bodyTouching(touches: string): string {
  return `card: #${CARD} stoplift [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/stoplift\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo it.\n`
}

async function answerRefusedOutsideTouches(refused: readonly string[]) {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'stop-lift-'))
  rooms.push({ made, root })
  const worktree = path.join(root, `mc-${CARD}`)
  mkdirSync(worktree)
  admit(made, bodyTouching('src/a.ts'), 'body-1')
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: 'feat/stoplift', base: sha('1') }, legacy: false })
  made.gitHub.open({ number: CARD_PR, required: 'failure', failed: ['lint'] })
  made.tick()
  made.tick()
  const answered: string[] = []
  const answerer: Answerer = async (request) => {
    if (answered.push(request.lease.taskKey) === 1)
      throw new AnswerOutsideTouches(request.lease, refused)
    return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('e'), owner: null }
  }
  const cardTrees: CardTreeTools = { home: root, exists: existsSync, branchOf: () => 'feat/stoplift', recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => `- ${OWNER_PATH}\n`, clock: made.clock.now, trees: cardTrees, liveSession: () => null })
  const lease = (): Lease | null => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  const outcome = await executor.answer(lease()!)
  made.tick()
  return { made, root, executor, lease, outcome, answered, stop: lastEventOf(made, CARD_STOPPED) }
}

function lastEventOf(made: MergeBench, type: string): { id: number, payload: { widen?: string[] } } {
  const row = made.db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type) as { id: number, payload: string }
  return { id: Number(row.id), payload: JSON.parse(row.payload) as { widen?: string[] } }
}

function openStopOn(made: MergeBench): number | null {
  return (made.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(CARD) as { id: number } | undefined)?.id ?? null
}

describe('the outside-touches stop of the answer node', () => {
  it('amend covering the refused paths lifts the outside-touches stop', async () => {
    const run = await answerRefusedOutsideTouches(['package.json', 'scripts/b.ts'])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.payload.widen).toEqual(['package.json', 'scripts/b.ts'])
    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
    const waitsAtTheStop = eventsOf(run.made.db, OWNER_WAIT_OPENED).length

    admit(run.made, bodyTouching('src/a.ts, package.json, scripts/b.ts'), 'body-2')
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBeNull()
    expect(eventsOf(run.made.db, OWNER_WAIT_OPENED)).toHaveLength(waitsAtTheStop)
    const again = run.lease()
    expect(again).toMatchObject({ queue: 'answer', cardId: CARD, pr: CARD_PR })
    expect(await run.executor.answer(again!)).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(run.answered).toHaveLength(2)
  })

  it('the owner\'s word on the wait the node opened with its stop lifts the stop', async () => {
    const run = await answerRefusedOutsideTouches(['package.json'])
    const wait = String(eventsOf(run.made.db, OWNER_WAIT_OPENED).at(-1)!.id)
    const room: Room = { made: run.made, channel: path.join(run.root, 'owner-answers'), stop: run.stop.id, wait, body: '' }
    sayToOwnerChannel(room.channel, OWNER_WORDS, room.made.clock.now())

    expect(closes(room, OWNER_WORDS, '--from', ANSWER_SOURCE).kind).toBe('done')

    expect(openStop(room)).toBeNull()
  })

  it('an amend naming the wait the node opened with its stop lifts the stop', async () => {
    const run = await answerRefusedOutsideTouches(['package.json'])
    const wait = String(eventsOf(run.made.db, OWNER_WAIT_OPENED).at(-1)!.id)

    admit(run.made, `${bodyTouching('src/a.ts')}\nanswers ${wait}\n`, 'body-2')

    expect(openStopOn(run.made)).toBeNull()
  })

  it('an amend covering only some of the refused paths does not lift it', async () => {
    const run = await answerRefusedOutsideTouches(['package.json', 'scripts/b.ts'])

    admit(run.made, bodyTouching('src/a.ts, package.json'), 'body-2')
    run.made.tick()
    run.made.tick()

    expect(openStopOn(run.made)).toBe(run.stop.id)
    expect(run.lease()).toBeNull()
  })

  it('a refused owner path records no widen, so an amend covering it does not lift the stop', async () => {
    const run = await answerRefusedOutsideTouches([OWNER_PATH])
    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(run.stop.payload.widen).toBeUndefined()

    admit(run.made, bodyTouching(`src/a.ts, ${OWNER_PATH}`), 'body-2')
    run.made.tick()

    expect(openStopOn(run.made)).toBe(run.stop.id)
  })
})
