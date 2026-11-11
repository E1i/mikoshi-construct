import type { InForceDecision } from './decisions/index.js'
import { decisionCommand, OWNER_SOURCE } from './decisions/decisions.js'

const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `
const UNTIL_TAIL = ' · until \\S+'

export function allowLiveText(queue: string): string {
  return `allow-live ${queue}`
}

export function namesQueueLive(text: string, queue: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?${allowLiveText(queue)}(?:${UNTIL_TAIL})?$`).test(text.trim())
}

export function liveDecisionOf(decisions: readonly InForceDecision[], queue: string): number | null {
  return decisions.find(decision => namesQueueLive(decision.text, queue))?.decisionId ?? null
}

export function allowLiveCommand(queue: string): string {
  return decisionCommand(allowLiveText(queue))
}
