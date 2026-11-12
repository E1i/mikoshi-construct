import type { RequestExecutor } from './context.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { changesRoundsOf, cleanUpdatesOf, decisionsInForceAt, dryRunHoldsAt, isFullSha, observedHeadsOf, prOf, REVIEW_ROUNDS, roundLimitDecisionOf } from './reach.js'
import { HEAD_WORD, text } from './request.js'

export const ALLOW_MERGE_RECORD = 'architecture/decisions/window-allow-merge.md'
const RULE_ACCEPTED = /^Status: accepted\b/m

export function allowMergeRuleInForce(repository: string): boolean {
  const record = path.join(repository, ALLOW_MERGE_RECORD)
  return existsSync(record) && RULE_ACCEPTED.test(readFileSync(record, 'utf8'))
}

export const execute: RequestExecutor = (context, _request, payload) => {
  const [pr, session] = [prOf(payload.pr), text(payload.dry_run)]
  const head = payload.head === HEAD_WORD && pr !== null ? context.observed(pr)?.head ?? null : isFullSha(payload.head) ? payload.head : null
  if (pr === null || head === null || session === null)
    return { done: false, why: `allow-merge needs a pr, a full head sha or ${HEAD_WORD} on an observed head, and the reviewer session of its dry run` }
  const inForce = decisionsInForceAt(context.db, context.clock())
  if (!allowMergeRuleInForce(context.repository))
    return { done: false, why: `${ALLOW_MERGE_RECORD} is not in force in ${context.repository}: absent, or its status is not accepted` }
  const row = context.observed(pr)
  if (row?.state !== 'open')
    return { done: false, why: `PR #${pr} is not open` }
  if (row.card_id === null)
    return { done: false, why: `PR #${pr} names no card; the version pull request stays the owner's` }
  if (row.head !== head)
    return { done: false, why: `PR #${pr} is at ${row.head ?? 'no head'}, not ${head}` }
  const rounds = changesRoundsOf(context.db, pr)
  if (rounds < REVIEW_ROUNDS)
    return { done: false, why: `PR #${pr} has ${rounds} of ${REVIEW_ROUNDS} review rounds, not past the round limit` }
  const dryRun = context.tools.dryRunOf(session)
  const cleanUpdates = cleanUpdatesOf(context.db, pr)
  if (dryRun?.pr !== pr || !dryRunHoldsAt(dryRun.head, head, observedHeadsOf(context.db, pr), cleanUpdates))
    return { done: false, why: `the dry run ${session} is not of PR #${pr} at ${head}` }
  const decided = roundLimitDecisionOf(inForce, pr, head, cleanUpdates)
  if (decided !== null)
    return { done: false, why: `D-${decided} already allows the merge of PR #${pr} at ${head}` }
  const written = context.tools.addDecision(['--card', `#${row.card_id}`, `[owner] allow-merge PR #${pr} at ${head} · by ${ALLOW_MERGE_RECORD}`])
  return { done: written.code === 0, why: written.lines.join('; ') }
}
