import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed } from './request.js'
import { OWNER_SAY_COMMAND } from '../../core/owner-commands.js'
import { activeDecisionsShard, allowMergeOfPrAtHead, ANSWER_SOURCE, appendEvent, BOARD_ALARM, cardBodyShaOfCard, closeOwnerWait, consumeOwnerWordClosing, deciderUnderAShard, decisionOnAWait, inTransaction, OPEN_OWNER_STOP_OF_CARD, OPEN_WAIT, OWNER_DECIDES, OWNER_SOURCE, OWNER_WAITS, OWNER_WORD_NOT_FOUND, ownerWordAwaited, QUEUE_ACTOR, queueTask, queueTaskWithin, reviewInputOf, SHARD_DECIDED, stopKindOf } from './reach.js'
import { flagsOf, LIVE_TASK_OF_CARD, messageOf, OWNER_ANSWER_USAGE, OWNER_WORD_NEEDED, text, unreleasedWord } from './request.js'

interface WaitToClose {
  state: string
  card_id: number | null
  need: string
  pr: number | null
}

const WAITS_A_DECISION_ANSWERS: ReadonlySet<string> = new Set(['decision', 'command'])
const MERGE_NEED = 'merge'
const PR_NO_LONGER_REWORKED: ReadonlySet<string | null> = new Set(['merged', 'closed'])
const OPEN_PR = 'open'
const DEAD_END_ALARM = 'dead_end'

type OwnerAction = 'merge' | 'review' | 'answer' | 'launch' | 'none'

const ACTION_WORDS: ReadonlyMap<string, OwnerAction> = new Map([['merge', 'merge'], ['review', 'review'], ['answer', 'answer'], ['continue', 'answer'], ['launch', 'launch']])
const LEADING_WORD = /^\P{L}*(\p{L}+)/u

function ownerActionOf(answer: string): OwnerAction {
  const word = LEADING_WORD.exec(answer)?.[1]?.toLowerCase()
  return word === undefined ? 'none' : ACTION_WORDS.get(word) ?? 'none'
}

interface Binding {
  line: string
  decision: number | null
}

const WRITTEN_DECISION_ID = /\bD-(\d+)\b/

function decisionIdIn(lines: readonly string[]): number | null {
  const found = lines.map(line => WRITTEN_DECISION_ID.exec(line)).find(match => match !== null)
  return found === undefined || found === null ? null : Number(found[1])
}

function bindingWordsToTheCard(context: RequestContext, cardId: number, words: string): Binding {
  const already = context.sameWordsBoundTo(words, [cardId])
  if (already !== null)
    return { line: `a decision with these words is bound to card #${cardId} already`, decision: already }
  const written = context.writtenDecision([...flagsOf('--card', `#${cardId}`), ...context.settledFlags(), `${OWNER_SOURCE} ${words}`])
  if (written.code !== 0)
    return { line: `the decision binding it to card #${cardId} is not written: ${written.lines.join('; ')}`, decision: null }
  return { line: `bound to card #${cardId} as a decision: ${written.lines.join('; ')}`, decision: decisionIdIn(written.lines) }
}

function bindingToTheCard(context: RequestContext, id: string, cardId: number, answer: string): Binding {
  return bindingWordsToTheCard(context, cardId, decisionOnAWait(id, answer))
}

function boundToTheCard(context: RequestContext, id: string, cardId: number, answer: string): string {
  return bindingToTheCard(context, id, cardId, answer).line
}

function answerRoundOnARefusedMerge(context: RequestContext, id: string, cardId: number, pr: number | null, answer: string): string {
  if (pr === null)
    return `${id} names no PR, so no answer round is queued`
  const observed = context.observed(pr)
  if (observed === undefined || PR_NO_LONGER_REWORKED.has(observed.state) || observed.head === null)
    return `PR #${pr} is ${observed?.state ?? 'not observed'}, so no answer round is queued`
  const { line: bound, decision } = bindingToTheCard(context, id, cardId, answer)
  if (decision === null)
    return `${bound}; no answer round is queued without the decision that carries the answer`
  const cardBody = cardBodyShaOfCard(context.db, cardId) ?? undefined
  const queued = queueTask(context.db, context.now(), { queue: 'answer', cardId, pr, head: observed.head, cardBody, decision })
  return `${bound}; ${queued ? 'queued' : 'already queued'} the answer round on PR #${pr} at ${observed.head} carrying D-${decision}: a merge wait closed while its PR is open refuses the merge`
}

interface OpenHead {
  pr: number
  head: string
  bodySha: string | null
}

function openHeadOf(context: RequestContext, pr: number | null): OpenHead | string {
  if (pr === null)
    return 'the wait names no PR'
  const observed = context.observed(pr)
  if (observed === undefined || observed.state !== OPEN_PR || observed.head === null)
    return `PR #${pr} is ${observed?.state ?? 'not observed'}${observed?.head === null ? ' with no observed head' : ''}`
  const row = context.db.prepare('SELECT body_sha FROM prs WHERE pr = ?').get(pr) as { body_sha: unknown } | undefined
  return { pr, head: observed.head, bodySha: typeof row?.body_sha === 'string' ? row.body_sha : null }
}

interface Move {
  within: () => string
  after: () => string
}

interface Answered {
  id: string
  request: number
  cardId: number
  wait: WaitToClose
  stop: number | null
  answer: string
}

const NOTHING_AFTER = (): string => ''

function deadEndWithin(context: RequestContext, at: Answered): string {
  const { cardId } = at
  if (at.wait.need === MERGE_NEED || at.stop !== null || context.routeOf(cardId, true) !== null)
    return ''
  if (context.db.prepare(LIVE_TASK_OF_CARD).get(cardId) !== undefined || context.openSessionOf(cardId) !== null)
    return ''
  const detail = `the owner's answer to ${at.id} names no node action and card #${cardId} has no queued or leased task and no live session`
  appendEvent(context.db, { ts: context.now(), type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId, pr: at.wait.pr, head: null, dedupeKey: `${BOARD_ALARM}:${DEAD_END_ALARM}:${cardId}:${at.request}`, payload: { reason: DEAD_END_ALARM, detail }, legacy: false })
  return `raised ${BOARD_ALARM} ${DEAD_END_ALARM}: ${detail}`
}

function todaysAnswer(context: RequestContext, at: Answered): string {
  if (at.wait.need === MERGE_NEED)
    return answerRoundOnARefusedMerge(context, at.id, at.cardId, at.wait.pr, at.answer)
  return WAITS_A_DECISION_ANSWERS.has(at.wait.need) ? boundToTheCard(context, at.id, at.cardId, at.answer) : ''
}

function noActionMove(context: RequestContext, at: Answered, why: string): Move {
  return { within: () => [why, deadEndWithin(context, at)].filter(line => line !== '').join('; '), after: () => todaysAnswer(context, at) }
}

function mergeMove(context: RequestContext, at: Answered): Move | Binding {
  const open = openHeadOf(context, at.wait.pr)
  if (typeof open === 'string')
    return noActionMove(context, at, `${open}, so no merge task is queued`)
  const binding = bindingWordsToTheCard(context, at.cardId, `${allowMergeOfPrAtHead(open.pr, open.head)} — ${decisionOnAWait(at.id, at.answer)}`)
  const { decision } = binding
  if (decision === null)
    return binding
  const prBody = open.bodySha ?? undefined
  return {
    within: () => {
      const queued = queueTaskWithin(context.db, context.now(), { queue: 'merge', cardId: at.cardId, pr: open.pr, head: open.head, prBody, decision })
      return `${binding.line}; ${queued ? 'queued' : 'already queued'} the merge task on PR #${open.pr} at ${open.head} carrying D-${decision}: the merge node runs its own checks, only the round limit is answered`
    },
    after: NOTHING_AFTER,
  }
}

function reviewMove(context: RequestContext, at: Answered): Move {
  const open = openHeadOf(context, at.wait.pr)
  if (typeof open === 'string')
    return noActionMove(context, at, `${open}, so no review task is queued`)
  const input = reviewInputOf(open.bodySha, cardBodyShaOfCard(context.db, at.cardId))
  return {
    within: () => {
      const queued = queueTaskWithin(context.db, context.now(), { queue: 'review', cardId: at.cardId, pr: open.pr, head: open.head, input })
      return `${queued ? 'queued' : 'already queued'} the review task on PR #${open.pr} at ${open.head}`
    },
    after: NOTHING_AFTER,
  }
}

function launchMove(context: RequestContext, at: Answered): Move {
  const generation = `owner-${at.request}`
  return {
    within: () => {
      const session = context.openSessionOf(at.cardId)
      if (session !== null)
        return `card #${at.cardId} runs the session started at event ${session}, so no launch task is queued`
      if ((context.db.prepare(LIVE_TASK_OF_CARD).get(at.cardId) as { queue: string } | undefined)?.queue === 'launch')
        return `card #${at.cardId} has a launch task queued already`
      const queued = queueTaskWithin(context.db, context.now(), { queue: 'launch', cardId: at.cardId, generation })
      return `${queued ? 'queued' : 'already queued'} the launch task launch:${at.cardId}:${generation}`
    },
    after: NOTHING_AFTER,
  }
}

function moveOf(context: RequestContext, at: Answered): Move | Binding {
  switch (ownerActionOf(at.answer)) {
    case 'merge':
      return mergeMove(context, at)
    case 'review':
      return reviewMove(context, at)
    case 'launch':
      return launchMove(context, at)
    case 'answer':
      return { within: () => '', after: () => answerRoundOnARefusedMerge(context, at.id, at.cardId, at.wait.pr, at.answer) }
    default:
      return noActionMove(context, at, '')
  }
}

const CLOSE_ONLY: Move = { within: () => '', after: NOTHING_AFTER }

function closedWith(context: RequestContext, request: number, id: string, answer: string, move: Move): { closed: false, refusal: string } | { closed: true, within: string } {
  try {
    return inTransaction(context.db, () => {
      if (!closeOwnerWait(context.db, context.now(), QUEUE_ACTOR, id, answer, request))
        return { closed: false as const, refusal: `${id} is closed already` }
      return { closed: true as const, within: move.within() }
    })
  }
  catch (error) {
    return { closed: false, refusal: `owner.wait.close failed: ${messageOf(error)}` }
  }
}

function closeWaitOnOwnerWord(context: RequestContext, request: number, id: string, wait: WaitToClose, stop: number | null): Executed {
  if (wait.state !== OPEN_WAIT)
    return { done: false, why: `${id} is closed already` }
  const word = consumeOwnerWordClosing(context.ownerChannel, id, context.clock())
  if (word === null)
    return { done: false, why: `${OWNER_WORD_NOT_FOUND}: ${ownerWordAwaited(id)}` }
  const answer = word.words
  const left = (why: string): Executed => ({ done: false, why: `${why}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` })
  const move = wait.card_id === null ? CLOSE_ONLY : moveOf(context, { id, request, cardId: wait.card_id, wait, stop, answer })
  if (!('within' in move))
    return left(`${id} stays open: ${move.line}`)
  const outcome = closedWith(context, request, id, answer, move)
  if (!outcome.closed)
    return left(outcome.refusal)
  const stillOpen = context.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number } | undefined
  const closed = stop === null || stillOpen?.id === stop ? `closed ${id} on the owner's word ${word.file}: ${answer}` : `closed ${id} and lifted the card #${wait.card_id} stop ${stop} on the owner's word ${word.file}: ${answer}`
  return { done: true, why: [closed, outcome.within, move.after()].filter(line => line !== '').join('; ') }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const { db } = context
  const id = text(payload.id)
  const answer = text(payload.answer)
  const from = text(payload.from)
  if (id === null || (answer === null && from === null))
    return { done: false, why: 'owner.wait.close needs an id Q<N> and an answer, or --from the owner channel' }
  if (from !== null && from !== ANSWER_SOURCE)
    return { done: false, why: `owner.wait.close --from ${from} is not ${ANSWER_SOURCE}; only the owner's word that ${OWNER_SAY_COMMAND} put into the owner channel closes a wait as the owner's answer` }
  const wait = db.prepare(`SELECT state, card_id, need, pr FROM ${OWNER_WAITS} WHERE id = ?`).get(id) as WaitToClose | undefined
  if (wait === undefined)
    return { done: false, why: `${id} is not an owner wait the bus has reduced` }
  const stop = wait.card_id === null ? undefined : db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number, payload: string } | undefined
  if (from !== null || answer === null)
    return closeWaitOnOwnerWord(context, request, id, wait, stop?.id ?? null)
  const shard = stop === undefined ? null : activeDecisionsShard(db, context.clock())
  const question = stop === undefined ? '' : String((JSON.parse(stop.payload) as Record<string, unknown>).detail ?? '')
  const reserved = shard !== null && deciderUnderAShard(question) === OWNER_DECIDES ? stopKindOf(question) : null
  if (reserved !== null)
    return { done: false, why: `${id} answers the card #${wait.card_id} stop ${stop!.id} on ${reserved}, which stays the owner's under any shard` }
  const ts = context.now()
  const closed = shard !== null && wait.state === OPEN_WAIT && inTransaction(db, () => {
    if (!closeOwnerWait(db, ts, QUEUE_ACTOR, id, answer, request))
      return false
    appendEvent(db, { ts, type: SHARD_DECIDED, actor: QUEUE_ACTOR, cardId: wait.card_id, pr: null, head: null, dedupeKey: `${SHARD_DECIDED}:${stop!.id}:${request}`, payload: { shard: shard.id, stop: stop!.id, wait: id, question, answer, ground: `the window's answer to ${id} under shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until})` }, legacy: false })
    return true
  })
  if (!closed)
    return { done: false, why: shard === null && wait.state === OPEN_WAIT ? `${id} stays open: ${OWNER_WORD_NEEDED}; ${OWNER_ANSWER_USAGE}` : `${id} is closed already` }
  return { done: true, why: `closed ${id} and lifted the card #${wait.card_id} stop ${stop!.id} as a decision under shard ${shard.id}: ${answer}` }
}
