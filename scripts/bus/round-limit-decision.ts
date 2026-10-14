import type { InForceDecision } from './decisions.js'
import { OWNER_SOURCE } from '../decisions/add.js'
import { isFullSha } from './identifiers.js'

const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?allow-merge PR #${pr} at ${head}(?![0-9a-f])`).test(text)
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string): number | null {
  if (!isFullSha(head))
    return null
  return decisions.find(decision => namesPrAtHead(decision.text, pr, head))?.decisionId ?? null
}
