import type { EnforcementLevel, EntryAuthor } from '../../model/schema.js'
import type { ModelState } from '../../model/state.js'
import { ENFORCEMENT_LEVELS } from '../../model/schema.js'

export const CHECK_IDS = ['lint-policy', 'ci'] as const
export const LEVELS = ENFORCEMENT_LEVELS

export type CheckId = (typeof CHECK_IDS)[number]
export type Level = EnforcementLevel
export type CheckState = ModelState

export interface CheckVerdict {
  id: CheckId
  claimId: string
  level: Level
  state: CheckState
  authoredBy: EntryAuthor
  evidence: string
}
