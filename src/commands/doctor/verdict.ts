import type { EnforcementLevel, EntryAuthor } from '../../model/schema.js'
import type { ModelState } from '../../model/state.js'
import { ENFORCEMENT_LEVELS } from '../../model/schema.js'

export const LEVELS = ENFORCEMENT_LEVELS

export type Level = EnforcementLevel
export type CheckState = ModelState

export interface CheckVerdict {
  id: string
  claimId: string
  level: Level
  state: CheckState
  authoredBy: EntryAuthor
  evidence: string
}
