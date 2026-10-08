import type { Fact, FactKind } from './schema.js'
import type { FactEvaluation, ModelEvidence, StageFinding } from './state.js'

export const ABILITY_STATUSES = ['confirmed', 'assumption', 'unknown'] as const
export type AbilityStatus = (typeof ABILITY_STATUSES)[number]

export const ABILITY_REASONS = ['absent', 'not-run', 'confirmed-elsewhere', 'written-in-repo'] as const
export type AbilityReason = (typeof ABILITY_REASONS)[number]

export const WITNESS_KINDS: readonly FactKind[] = ['report-covers']

type PaintedState = StageFinding['state']

export type AbilityFinding
  = | { status: 'confirmed', state: 'held' }
    | { status: Exclude<AbilityStatus, 'confirmed'>, reason: AbilityReason, state: PaintedState }

interface NamedFact {
  witness: boolean
  failed: boolean
  evaluation: FactEvaluation
}

function unconfirmed(status: Exclude<AbilityStatus, 'confirmed'>, reason: AbilityReason): AbilityFinding {
  return { status, reason, state: reason === 'absent' ? 'unsupported' : 'unknown' }
}

function namedFacts(facts: readonly Fact[], supportedBy: readonly string[], evaluations: Record<string, FactEvaluation>, failed: ReadonlySet<string>): NamedFact[] {
  return supportedBy.map((id) => {
    const kind = facts.find(fact => fact.id === id)?.kind
    return { witness: kind !== undefined && WITNESS_KINDS.includes(kind), failed: failed.has(id), evaluation: evaluations[id] ?? 'unevaluable' }
  })
}

function openReason(open: readonly NamedFact[], evidence: ModelEvidence): AbilityReason {
  if (open.length === 0)
    return 'written-in-repo'
  return evidence.reports === 'withheld' && open.some(fact => fact.witness) ? 'confirmed-elsewhere' : 'not-run'
}

export function abilityOf(facts: readonly Fact[], supportedBy: readonly string[], evaluations: Record<string, FactEvaluation>, failed: ReadonlySet<string>, evidence: ModelEvidence): AbilityFinding {
  const named = namedFacts(facts, supportedBy, evaluations, failed)
  if (named.some(fact => fact.evaluation === 'does-not-hold' || fact.failed))
    return unconfirmed('unknown', 'absent')
  const held = named.filter(fact => fact.evaluation === 'holds')
  const open = named.filter(fact => fact.evaluation === 'unevaluable')
  if (open.length === 0 && held.some(fact => fact.witness))
    return { status: 'confirmed', state: 'held' }
  return unconfirmed(held.length > 0 ? 'assumption' : 'unknown', openReason(open, evidence))
}
