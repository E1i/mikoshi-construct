import type { OwnerReader } from '../../model/ownership.js'
import type { SelectedPath } from '../../model/path.js'
import type { Claim, Hypothesis, RepositoryModel } from '../../model/schema.js'
import type { ClaimStages, ModelEvidence, ModelStateReport, StageFinding } from '../../model/state.js'
import type { CheckVerdict } from './verdict.js'
import { authoredByOwner } from '../../model/ownership.js'
import { selectPath } from '../../model/path.js'
import { deriveModelState, WITHHELD_EVIDENCE } from '../../model/state.js'

export const CLAIM_PLACEMENTS = ['stop', 'no-stop', 'no-claim', 'no-model'] as const
export type PlacementName = (typeof CLAIM_PLACEMENTS)[number]

export type ClaimPlacement
  = | { at: 'stop', stop: SelectedPath }
    | { at: Exclude<PlacementName, 'stop'> }

export type HypothesisReading = {
  hypothesisId: string
  statement: string
  baseSha: string | null
  evidenceClean: boolean
} & StageFinding

export interface KnowledgeProjection {
  checks: CheckVerdict[]
  hypotheses: HypothesisReading[]
  youAreHere: ClaimPlacement
  stages: Record<string, ClaimStages>
}

function verdict(claim: Claim, finding: StageFinding, owner: OwnerReader): CheckVerdict {
  return {
    id: claim.checkId ?? claim.id,
    claimId: claim.id,
    level: claim.enforcement?.level ?? 'L0',
    authoredBy: owner(claim),
    mechanism: claim.enforcement?.mechanism ?? claim.statement,
    ...finding,
  }
}

function reading(hypothesis: Hypothesis, finding: StageFinding): HypothesisReading {
  return {
    hypothesisId: hypothesis.id,
    statement: hypothesis.statement,
    baseSha: hypothesis.baseSha,
    evidenceClean: hypothesis.evidenceClean,
    ...finding,
  }
}

const NOTHING_NAMED: StageFinding = { state: 'unknown', reason: 'no-fact-named' }

function placeClaim(model: RepositoryModel, derived: ModelStateReport): ClaimPlacement {
  if (model.claims.length === 0)
    return { at: 'no-claim' }
  const stop = selectPath(model, derived)
  return stop == null ? { at: 'no-stop' } : { at: 'stop', stop }
}

export function projectKnowledge(model: RepositoryModel | null, root: string, owner: OwnerReader = authoredByOwner, evidence: ModelEvidence = WITHHELD_EVIDENCE): KnowledgeProjection {
  if (model == null)
    return { checks: [], hypotheses: [], youAreHere: { at: 'no-model' }, stages: {} }
  const derived = deriveModelState(model, root, evidence)
  const checks = model.claims.map(claim => verdict(claim, derived.claims[claim.id]?.enforcement ?? NOTHING_NAMED, owner))
  const hypotheses = model.hypotheses.map(hypothesis => reading(hypothesis, derived.hypotheses[hypothesis.id] ?? NOTHING_NAMED))
  return { checks, hypotheses, youAreHere: placeClaim(model, derived), stages: derived.claims }
}
