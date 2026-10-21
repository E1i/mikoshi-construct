import type { DatabaseSync } from 'node:sqlite'
import type { InForceDecision } from './decisions.js'
import type { CleanUpdate } from './update-done.js'
import { OWNER_SOURCE } from '../decisions/decisions.js'
import { PR_OPENED } from './card-automaton.js'
import { isFullSha } from './identifiers.js'
import { PR_OBSERVED } from './operator-work.js'

const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?allow-merge PR #${pr} at ${head}(?![0-9a-f])`).test(text)
}

const HEADS_OF_A_PR = `SELECT head FROM events WHERE type IN ('${PR_OPENED}', '${PR_OBSERVED}') AND legacy = 0 AND pr = ? AND head IS NOT NULL ORDER BY id`

export function observedHeadsOf(db: DatabaseSync, pr: number): string[] {
  const heads = (db.prepare(HEADS_OF_A_PR).all(pr) as { head: string }[]).map(row => row.head)
  return heads.filter((head, at) => at === 0 || heads[at - 1] !== head)
}

function headsWithTheSameDiff(head: string, cleanUpdates: readonly CleanUpdate[]): string[] {
  const heads = [head]
  for (let current = head; ;) {
    const from = cleanUpdates.find(update => update.to === current)?.from
    if (from === undefined || heads.includes(from))
      return heads
    heads.push(from)
    current = from
  }
}

function headObservedBefore(head: string, observedHeads: readonly string[]): string | undefined {
  const at = observedHeads.lastIndexOf(head)
  return at > 0 ? observedHeads[at - 1] : undefined
}

export function dryRunHoldsAt(dryRunHead: string, head: string, observedHeads: readonly string[], cleanUpdates: readonly CleanUpdate[]): boolean {
  if (!isFullSha(dryRunHead) || !isFullSha(head))
    return false
  return headsWithTheSameDiff(head, cleanUpdates).some(same => same === dryRunHead || headObservedBefore(same, observedHeads) === dryRunHead)
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return decisions.find(decision => heads.some(decided => namesPrAtHead(decision.text, pr, decided)))?.decisionId ?? null
}
