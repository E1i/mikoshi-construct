import type { InForceDecision } from './decisions.js'
import { OWNER_SOURCE } from '../decisions/decisions.js'

const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

export function allowLiveText(queue: string): string {
  return `allow-live ${queue}`
}

export function namesQueueLive(text: string, queue: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?${allowLiveText(queue)}$`).test(text.trim())
}

export function liveDecisionOf(decisions: readonly InForceDecision[], queue: string): number | null {
  return decisions.find(decision => namesQueueLive(decision.text, queue))?.decisionId ?? null
}

export function allowLiveCommand(queue: string): string {
  return `pnpm decisions:add "${OWNER_SOURCE} ${allowLiveText(queue)}"`
}
