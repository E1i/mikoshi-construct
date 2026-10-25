import type { Capability } from './vocabulary.js'

export interface Unresolved {
  level: 'REASONING_REQUIRED' | 'DECISION_REQUIRED'
  reason: string
  source: string
}

export interface Contour {
  after: string[]
  parallelWith: string[]
  worktree: string | null
  locks: string[]
  executor: 'ladder' | 'direct' | null
  merge: 'auto' | 'owner' | null
  capabilities: Capability[]
  notes: string[]
}

export interface Row {
  task: string
  paths: { write: string[], immutable: string[] }
  effort: string | null
  verification: Capability[]
  class: 'R2' | 'R1.5' | 'R1' | null
  why: string[]
  contour: Contour
  unresolved: Unresolved[]
}
