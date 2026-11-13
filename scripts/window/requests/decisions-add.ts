import type { RequestExecutor } from './context.js'
import { OWNER_SAY_COMMAND } from '../../core/owner-commands.js'
import { ANSWER_SOURCE, cardIdOf, consumeOwnerWord, OWNER_SOURCE, OWNER_WORD_NOT_FOUND } from './reach.js'
import { flagsOf, HEAD_WORD, text, unreleasedWord } from './request.js'

const AT_HEAD_OF_A_PR = new RegExp(`\\bPR #(\\d+) at ${HEAD_WORD}(?![\\w-])`, 'g')

export const execute: RequestExecutor = (context, _request, payload) => {
  const decision = text(payload.text)
  const from = text(payload.from)
  if (decision === null || from === null)
    return { done: false, why: `decisions:add needs the owner's text and --from ${ANSWER_SOURCE}` }
  if (from !== ANSWER_SOURCE)
    return { done: false, why: `decisions:add --from ${from} is not ${ANSWER_SOURCE}; a decision comes only from the owner's word that ${OWNER_SAY_COMMAND} put into the owner channel, never from an owner order file` }
  const words = decision.startsWith(OWNER_SOURCE) ? decision.slice(OWNER_SOURCE.length).trim() : decision
  const filled = [...decision.matchAll(AT_HEAD_OF_A_PR)].some(match => context.observed(Number(match[1]))?.head == null) ? null : decision.replace(AT_HEAD_OF_A_PR, (_, pr: string) => `PR #${pr} at ${context.observed(Number(pr))!.head!}`)
  if (words === '' || filled === null)
    return { done: false, why: words === '' ? `decisions:add: an empty decision; the bus writes only the owner's own words` : `decisions:add: the decision names a PR at ${HEAD_WORD} whose head the bus has not observed, so the bus has no sha to put in` }
  const word = consumeOwnerWord(context.ownerChannel, words, context.clock())
  if (word === null)
    return { done: false, why: OWNER_WORD_NOT_FOUND }
  const already = context.sameWordsBoundTo(words, (Array.isArray(payload.cards) ? payload.cards : []).map(card => cardIdOf(card)).filter((card): card is number => card !== null))
  if (already !== null)
    return { done: true, why: `D-${already} already holds these words of the owner for the same cards, so no second decision is written and no second answer is queued; owner word ${word.file} used` }
  const written = context.writtenDecision([...flagsOf('--supersedes', payload.supersedes), ...flagsOf('--card', payload.cards), ...flagsOf('--until', payload.until), ...context.settledFlags(), filled])
  const done = written.code === 0
  const fate = done ? 'used' : word.release() ? 'left unused' : unreleasedWord(word.file)
  return { done, why: [...written.lines, `owner word ${word.file} ${fate}`].join('; ') }
}
