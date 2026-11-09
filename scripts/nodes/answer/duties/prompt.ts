import type { ShiftGate } from '../../../../src/manifest.js'
import type { Lease } from '../../../core/lease.js'
import type { FailedJobLog } from '../../../ports/ci-reading.js'
import type { AnswerSource, CardSession } from '../answer-source.js'
import type { AnswerRequest } from '../answerer.js'
import { existsSync, readFileSync } from 'node:fs'
import { cardDecisionBlock } from '../../../core/card-decisions.js'
import { ciLogForPrompt } from '../../../ports/ci-reading.js'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'

export interface FreshBaseMerge {
  problem: string
  task: string
}

const DIFF_PROMPT_LIMIT = 100_000

function ciLogLines(ciLog: FailedJobLog | null | undefined): string[] {
  if (ciLog === undefined)
    return ['Read their logs (gh pr checks, gh run view --log-failed) and fix every one.']
  if (ciLog === null)
    return ['The bus could not read the failed-job log; fix every failed check from what the tree shows.']
  return ['The failures and the tail of the failed-job log the bus read:', ciLogForPrompt(ciLog), 'Fix every failure it shows.']
}

function redCiLines(failedChecks: string[], ciLog: FailedJobLog | null | undefined): string[] {
  return [
    failedChecks.length === 0 ? 'CI is red on this head and the bus recorded no failed check by name.' : `CI is red on this head. The failed checks: ${failedChecks.join(', ')}.`,
    ...ciLogLines(ciLog),
  ]
}

export function asksAboutRedCi(source: AnswerSource): boolean {
  return source.kind === 'ci' || (source.kind === 'changes' && source.failedChecks !== undefined)
}

function sourceLines(source: AnswerSource, ciLog?: FailedJobLog | null): string[] {
  if (source.kind === 'changes') {
    return [
      source.findings.length === 0 ? 'The review asked for changes and recorded no findings on the bus; read the review on the pull request.' : 'The review asked for changes. Its findings:',
      ...source.findings.map(finding => `- ${finding}`),
      'Address every finding.',
      ...(source.failedChecks === undefined ? [] : redCiLines(source.failedChecks, ciLog)),
    ]
  }
  if (source.kind === 'ci')
    return redCiLines(source.failedChecks, ciLog)
  if (source.kind === 'decision')
    return [`The owner decided on this card: D-${source.decisionId}: ${source.text}`, 'Continue the card under that decision; the card body is unchanged.']
  return [`The card stopped with a question for the agent: ${source.detail}`, 'Answer it as the Operator role would and continue the card.']
}

function cardLines(cardId: number, cardText: string | null): string[] {
  if (cardText === null)
    return [`Card #${cardId} has no admitted body in the bus; read the card from the pull request.`]
  return [`The card as the bus holds it now, witnesses admitted after the verdict included:`, cardText.trim()]
}

function diffLines(card: CardSession, diff: string | null | undefined): string[] {
  if (diff === undefined)
    return []
  if (diff === null)
    return [`The diff of the tree against ${MAIN_BRANCH} could not be read; read it with git diff in ${card.worktree}.`]
  if (diff.length > DIFF_PROMPT_LIMIT)
    return [`The diff of the tree against ${MAIN_BRANCH}, cut at ${DIFF_PROMPT_LIMIT} characters; read the rest with git diff in ${card.worktree}:`, diff.slice(0, DIFF_PROMPT_LIMIT)]
  return [`The diff of the tree against ${MAIN_BRANCH}:`, diff]
}

export function gateLine(gate: ShiftGate): string {
  return gate.prepush.length === 0 ? `the card's witnesses` : `the card's witnesses and the pre-push checks this repository declares, ${gate.prepush.join(', ')}`
}

export function answerPrompt(request: AnswerRequest, cardText: string | null, gateRule: string, diff?: string | null, ciLog?: FailedJobLog | null): string {
  const { lease, source, widened, card } = request
  return [
    `[answer:${lease.taskKey}]`,
    `Card #${lease.cardId}${lease.pr === null ? '' : `, pull request #${lease.pr} at ${lease.head}`}, in its tree ${card.worktree} on ${card.branch}.`,
    ...cardLines(lease.cardId, cardText),
    ...cardDecisionBlock(source.decisions),
    ...sourceLines(source, ciLog),
    ...diffLines(card, diff),
    ...(widened === null ? [] : [`The touches are widened: ${widened}.`]),
    `The card's latest events, oldest first:`,
    ...source.events.map(event => JSON.stringify(event)),
    gateRule,
  ].join('\n')
}

export function mergePrompt(lease: Lease, card: CardSession, merge: FreshBaseMerge, ownerQuestion: string): string {
  return [
    `[answer:${lease.taskKey}]`,
    `The bus merges a fresh origin/${MAIN_BRANCH} into ${card.branch} before it pushes, and that merge ${merge.problem}; nothing was pushed.`,
    `Your part: ${merge.task}.`,
    `Then repeat the window gate of D-194 in ${card.worktree} and end the session; the bus merges again and pushes. If the merge cannot be settled without the owner, write the question for the owner, one line, to ${ownerQuestion}; the bus then pushes nothing.`,
  ].join('\n')
}

export function handoffLines(handoff: string, fresh: boolean): string[] {
  const stop = `On the context warn (the Eddies warn on the session's context): finish the step you are in, write what is done and what is not to ${handoff}, leave the tree as it is and end the session; the bus pushes nothing and continues in a fresh session from that handoff and the tree.`
  const left = fresh && existsSync(handoff) ? readFileSync(handoff, 'utf8').trim() : ''
  return left === '' ? [stop] : ['The session before this one stopped at the context warn and left this handoff; continue from it:', left, stop]
}
