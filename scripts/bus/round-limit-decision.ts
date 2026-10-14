import type { InForceDecision } from './decisions.js'
import { isFullSha } from './identifiers.js'

const ALLOW_MERGE = /(?<![\w-])allow-merge(?![\w-])/

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return ALLOW_MERGE.test(text) && new RegExp(`PR #${pr}(?!\\d)`).test(text) && new RegExp(`(?<![0-9a-f])${head}(?![0-9a-f])`).test(text)
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string): number | null {
  if (!isFullSha(head))
    return null
  return decisions.find(decision => namesPrAtHead(decision.text, pr, head))?.decisionId ?? null
}
