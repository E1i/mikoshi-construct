import type { Fact, RepositoryModel } from './schema.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const FACT_EVALUATIONS = ['holds', 'does-not-hold', 'unevaluable'] as const
export type FactEvaluation = (typeof FACT_EVALUATIONS)[number]

export const MODEL_STATES = ['held', 'unsupported', 'unknown'] as const
export type ModelState = (typeof MODEL_STATES)[number]

export interface ClaimStages {
  enforcement: ModelState
  verification: ModelState
}

export interface ModelStateReport {
  facts: Record<string, FactEvaluation>
  hypotheses: Record<string, ModelState>
  claims: Record<string, ClaimStages>
}

function evaluateFact(fact: Fact, root: string): FactEvaluation {
  const target = path.join(root, fact.path)
  try {
    if (!existsSync(target))
      return 'does-not-hold'
    if (fact.kind === 'file-exists')
      return 'holds'
    return readFileSync(target, 'utf8').includes(fact.needle ?? '') ? 'holds' : 'does-not-hold'
  }
  catch {
    return 'unevaluable'
  }
}

export function evaluateFacts(model: RepositoryModel, root: string): Record<string, FactEvaluation> {
  return Object.fromEntries(model.facts.map(fact => [fact.id, evaluateFact(fact, root)]))
}

export function resolveState(supportedBy: readonly string[], evaluations: Record<string, FactEvaluation>): ModelState {
  if (supportedBy.length === 0)
    return 'unknown'
  const states = supportedBy.map(id => evaluations[id] ?? 'unevaluable')
  if (states.includes('unevaluable'))
    return 'unknown'
  return states.includes('does-not-hold') ? 'unsupported' : 'held'
}

export function deriveModelState(model: RepositoryModel, root: string): ModelStateReport {
  const facts = evaluateFacts(model, root)
  return {
    facts,
    hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, resolveState(hypothesis.supportedBy, facts)])),
    claims: Object.fromEntries(model.claims.map(claim => [claim.id, {
      enforcement: resolveState(claim.enforcement?.supportedBy ?? [], facts),
      verification: resolveState(claim.verification?.supportedBy ?? [], facts),
    }])),
  }
}
