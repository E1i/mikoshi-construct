import type { OwnerWaitRow } from '../../core/card-readings.js'
import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed } from './request.js'
import { openWaitsOfCard, ownerWaitOf } from '../../core/card-readings.js'
import { events } from '../../core/events-query.js'
import { askedOwnerMoveOf, mergeWaitRefusal, ownerMoveReasonOf } from '../../core/owner-commands.js'
import { payloadOf } from '../../core/stored.js'
import { ANSWER_SOURCE, cardIdOf, changesRoundsOf, closeOwnerWait, consumeOwnerWordClosing, decisionOnAWait, inTransaction, OPEN_WAIT, openPrOfCard, OWNER_SOURCE, OWNER_WAIT_OPENED, OWNER_WORD_NOT_FOUND, QUEUE_ACTOR, REQUEST_DONE, REQUEST_REFUSED, REVIEW_ROUNDS, storedByKey, WINDOW_REQUEST } from './reach.js'
import { flagsOf, text, unreleasedWord } from './request.js'

type Wait = Omit<OwnerWaitRow, 'state'>

const CONTINUE_FIXES = 'continue-fixes'
const ANSWER_WORD = 'answer'
const NEEDS_A_DECISION_ANSWERS: ReadonlySet<string> = new Set(['decision', 'command'])

function waitOf({ id, need, card_id, pr }: OwnerWaitRow): Wait {
  return { id, need, card_id, pr }
}

function openWaits(context: RequestContext, id: string | null, card: number | null): Wait[] {
  if (id === null)
    return card === null ? [] : openWaitsOfCard(context.db, card).map(waitOf)
  const wait = ownerWaitOf(context.db, id)
  return wait === null || wait.state !== OPEN_WAIT ? [] : [waitOf(wait)]
}

function roundLimitedPr(context: RequestContext, wait: Wait | null, card: number | null): number | null {
  if (wait !== null && !NEEDS_A_DECISION_ANSWERS.has(wait.need))
    return null
  const pr = wait?.pr ?? (card === null ? null : openPrOfCard(context.db, card))
  return pr !== null && changesRoundsOf(context.db, pr) >= REVIEW_ROUNDS ? pr : null
}

function bound(context: RequestContext, words: string, card: number | null): { done: boolean, why: string } {
  if (card === null)
    return { done: true, why: 'bound to no card' }
  if (context.sameWordsBoundTo(words, [card]) !== null)
    return { done: true, why: `a decision with these words is bound to card #${card} already` }
  const written = context.writtenDecision([...flagsOf('--card', `#${card}`), ...context.settledFlags(), `${OWNER_SOURCE} ${words}`])
  return { done: written.code === 0, why: written.lines.join('; ') }
}

function sameMoveTarget(asked: Record<string, unknown>, written: Record<string, unknown> | null | undefined): boolean {
  return written !== null && written !== undefined && written.kind === asked.kind && written.card === asked.card && written.task_key === asked.task_key && written.from === ANSWER_SOURCE
}

function moveNotDone(context: RequestContext, request: number, waitId: string, words: string): string | null {
  const [opened] = events(context.db, { types: [OWNER_WAIT_OPENED], keys: [`${OWNER_WAIT_OPENED}:${waitId}`], limit: 1 })
  const command = opened?.data?.command
  const asked = askedOwnerMoveOf(typeof command === 'string' ? command : null)
  if (opened === undefined || asked === null || ownerMoveReasonOf(asked.move, words) === null)
    return null
  const kind = String(asked.request.kind)
  const [moved] = events(context.db, { types: [WINDOW_REQUEST], since: opened.id, before: request, newestFirst: true }).filter(written => sameMoveTarget(asked.request, written.data))
  if (moved === undefined)
    return `the owner's answer confirms ${kind} ${asked.target}, and no ${kind} request of the owner's answer follows ${waitId}; ${waitId} stays open`
  const answered = storedByKey(context.db, `${WINDOW_REQUEST}:${moved.id}:answered`) as ReturnType<typeof storedByKey> | undefined
  if (answered?.type === REQUEST_DONE)
    return null
  if (answered?.type === REQUEST_REFUSED)
    return `the move ${waitId} waits for, window.request ${moved.id} (${kind} ${asked.target}), was refused (${String(payloadOf(answered).detail)}); ${waitId} stays open`
  return `the move ${waitId} waits for, window.request ${moved.id} (${kind} ${asked.target}), has no outcome yet; ${waitId} stays open until it is done`
}

type Binding = 'by-need' | 'always' | 'never'

function binds(binding: Binding, wait: Wait): boolean {
  return binding === 'always' || (binding === 'by-need' && NEEDS_A_DECISION_ANSWERS.has(wait.need))
}

function closed(context: RequestContext, request: number, wait: Wait, answer: string, binding: Binding): Executed {
  const shut = inTransaction(context.db, () => closeOwnerWait(context.db, context.now(), QUEUE_ACTOR, wait.id, answer, request))
  if (!shut)
    return { done: false, why: `${wait.id} is closed already` }
  if (!binds(binding, wait))
    return { done: true, why: `closed ${wait.id}: ${answer}` }
  const decision = bound(context, decisionOnAWait(wait.id, answer), wait.card_id)
  return { done: true, why: `closed ${wait.id}: ${answer}; ${decision.done ? `bound to card #${wait.card_id} as a decision: ${decision.why}` : `the decision binding it to card #${wait.card_id} is not written: ${decision.why}`}` }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const words = text(payload.text)
  const id = text(payload.id)
  const card = cardIdOf(payload.card)
  if (words === null || text(payload.from) !== ANSWER_SOURCE || (id === null && card === null))
    return { done: false, why: `owner.answer needs a wait id Q<N> or a card, the owner's words and --from ${ANSWER_SOURCE}` }
  const target = id ?? `#${card}`
  const waits = openWaits(context, id, card)
  if (id !== null && waits.length === 0)
    return { done: false, why: `${id} is no open owner wait; nothing moves` }
  if (waits.length > 1)
    return { done: false, why: `card #${card} has ${waits.length} open waits (${waits.map(wait => wait.id).join(', ')}); answer one by its id; nothing moves` }
  const only = waits[0]
  if (only?.need === 'merge' && only.pr !== null)
    return { done: false, why: mergeWaitRefusal(only.id, only.pr) }
  const unmoved = waits[0] === undefined ? null : moveNotDone(context, request, waits[0].id, words)
  if (unmoved !== null)
    return { done: false, why: unmoved }
  const word = consumeOwnerWordClosing(context.ownerChannel, `${ANSWER_WORD} ${target}`, context.clock())
  if (word === null || word.words !== words) {
    const released = word === null || word.release() ? '' : `; ${unreleasedWord(word.file)}`
    return { done: false, why: `${OWNER_WORD_NOT_FOUND}: the owner's answer to ${target} is the line "${ANSWER_WORD} ${target}: ${words}" in the owner channel${released}` }
  }
  const wait = waits[0] ?? null
  const cardId = wait?.card_id ?? card
  const keepWord = (why: string): Executed => ({ done: false, why: `${why}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` })
  const pr = roundLimitedPr(context, wait, cardId)
  if (pr !== null) {
    const head = context.observed(pr)?.head ?? null
    if (head === null)
      return keepWord(`PR #${pr} is past its review round limit and the bus has observed no head of it to name in continue-fixes`)
    const decided = `${CONTINUE_FIXES} PR #${pr} at ${head}: ${words}`
    const written = bound(context, decided, cardId)
    if (!written.done)
      return keepWord(`PR #${pr} is past its review round limit and continue-fixes is not written: ${written.why}`)
    const fixes = `continue-fixes for PR #${pr} at ${head}: ${written.why}`
    if (wait === null)
      return { done: true, why: fixes }
    const shut = closed(context, request, wait, decided, 'never')
    return { done: shut.done, why: `${fixes}; ${shut.why}` }
  }
  if (wait !== null)
    return closed(context, request, wait, words, id === null ? 'always' : 'by-need')
  const decision = bound(context, words, cardId)
  if (!decision.done)
    return keepWord(`the decision binding the answer to card #${cardId} is not written: ${decision.why}`)
  return { done: true, why: `card #${cardId} has no open wait; bound to card #${cardId} as a decision: ${decision.why}` }
}
