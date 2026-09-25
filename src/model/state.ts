import type { Fact, RepositoryModel } from './schema.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateCoverage } from './coverage.js'

export const FACT_EVALUATIONS = ['holds', 'does-not-hold', 'unevaluable'] as const
export type FactEvaluation = (typeof FACT_EVALUATIONS)[number]

export const MODEL_STATES = ['held', 'unsupported', 'unknown'] as const
export type ModelState = (typeof MODEL_STATES)[number]

export interface FactOutcome {
  path: string
  evaluation: Exclude<FactEvaluation, 'holds'>
}

export type StageFinding
  = | { state: 'held' }
    | { state: 'unsupported', doesNotHold: [string, ...string[]] }
    | { state: 'unknown', reason: 'unevaluable', unevaluable: [string, ...string[]] }
    | { state: 'unknown', reason: 'no-fact-named' }

export interface ClaimStages {
  enforcement: StageFinding
  verification: StageFinding
}

export type ModelEvidence
  = | { reports: 'withheld' }
    | { reports: 'read', constructPaths: readonly string[] }

export const WITHHELD_EVIDENCE: ModelEvidence = { reports: 'withheld' }

export interface ModelStateReport {
  facts: Record<string, FactEvaluation>
  hypotheses: Record<string, StageFinding>
  claims: Record<string, ClaimStages>
}

const NEGATED: Record<FactEvaluation, FactEvaluation> = {
  'holds': 'does-not-hold',
  'does-not-hold': 'holds',
  'unevaluable': 'unevaluable',
}

function evaluateFile(fact: Fact, target: string): FactEvaluation {
  if (!existsSync(target))
    return fact.kind === 'file-lacks' ? 'unevaluable' : 'does-not-hold'
  if (fact.kind === 'file-exists')
    return 'holds'
  const found = readFileSync(target, 'utf8').includes(fact.needle ?? '')
  return found === (fact.kind === 'file-contains') ? 'holds' : 'does-not-hold'
}

function coverageOf(fact: Fact, root: string, evidence: ModelEvidence): FactEvaluation {
  return evidence.reports === 'read' ? evaluateCoverage(fact, root, evidence.constructPaths) : 'unevaluable'
}

function evaluateFact(fact: Fact, root: string, evidence: ModelEvidence): FactEvaluation {
  try {
    if (fact.kind === 'report-covers')
      return coverageOf(fact, root, evidence)
    if (fact.kind === 'report-misses')
      return NEGATED[coverageOf(fact, root, evidence)]
    return evaluateFile(fact, path.join(root, fact.path))
  }
  catch {
    return 'unevaluable'
  }
}

export function evaluateFacts(model: RepositoryModel, root: string, evidence: ModelEvidence = WITHHELD_EVIDENCE): Record<string, FactEvaluation> {
  return Object.fromEntries(model.facts.map(fact => [fact.id, evaluateFact(fact, root, evidence)]))
}

function pathsOf(outcomes: readonly FactOutcome[], evaluation: Exclude<FactEvaluation, 'holds'>): string[] {
  return [...new Set(outcomes.filter(fact => fact.evaluation === evaluation).map(fact => fact.path))]
}

export function resolveFinding(facts: readonly Fact[], supportedBy: readonly string[], evaluations: Record<string, FactEvaluation>): StageFinding {
  if (supportedBy.length === 0)
    return { state: 'unknown', reason: 'no-fact-named' }
  const outcomes = factOutcomes(facts, supportedBy, evaluations)
  const [firstUnevaluable, ...restUnevaluable] = pathsOf(outcomes, 'unevaluable')
  if (firstUnevaluable !== undefined)
    return { state: 'unknown', reason: 'unevaluable', unevaluable: [firstUnevaluable, ...restUnevaluable] }
  const [firstDoesNotHold, ...restDoesNotHold] = pathsOf(outcomes, 'does-not-hold')
  if (firstDoesNotHold === undefined)
    return { state: 'held' }
  return { state: 'unsupported', doesNotHold: [firstDoesNotHold, ...restDoesNotHold] }
}

export function factOutcomes(facts: readonly Fact[], supportedBy: readonly string[], evaluations: Record<string, FactEvaluation>): FactOutcome[] {
  return supportedBy.flatMap((id) => {
    const evaluation = evaluations[id] ?? 'unevaluable'
    if (evaluation === 'holds')
      return []
    return [{ path: facts.find(fact => fact.id === id)?.path ?? id, evaluation }]
  })
}

export function deriveModelState(model: RepositoryModel, root: string, evidence: ModelEvidence = WITHHELD_EVIDENCE): ModelStateReport {
  const facts = evaluateFacts(model, root, evidence)
  return {
    facts,
    hypotheses: Object.fromEntries(model.hypotheses.map(hypothesis => [hypothesis.id, resolveFinding(model.facts, hypothesis.supportedBy, facts)])),
    claims: Object.fromEntries(model.claims.map(claim => [claim.id, {
      enforcement: resolveFinding(model.facts, claim.enforcement?.supportedBy ?? [], facts),
      verification: resolveFinding(model.facts, claim.verification?.supportedBy ?? [], facts),
    }])),
  }
}
