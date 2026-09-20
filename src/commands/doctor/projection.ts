import type { OwnerReader } from '../../model/ownership.js'
import type { SelectedPath } from '../../model/path.js'
import type { Claim, RepositoryModel } from '../../model/schema.js'
import type { CheckVerdict } from './verdict.js'
import { authoredByOwner } from '../../model/ownership.js'
import { selectPath } from '../../model/path.js'
import { deriveModelState } from '../../model/state.js'

export interface KnowledgeProjection {
  checks: CheckVerdict[]
  youAreHere: SelectedPath | null
}

function verdict(claim: Claim, state: CheckVerdict['state'], owner: OwnerReader): CheckVerdict {
  return {
    id: claim.checkId ?? claim.id,
    claimId: claim.id,
    level: claim.enforcement?.level ?? 'L0',
    state,
    authoredBy: owner(claim),
    evidence: claim.enforcement?.mechanism ?? claim.statement,
  }
}

export function projectKnowledge(model: RepositoryModel | null, root: string, owner: OwnerReader = authoredByOwner): KnowledgeProjection {
  if (model == null)
    return { checks: [], youAreHere: null }
  const derived = deriveModelState(model, root)
  const checks = model.claims.map(claim => verdict(claim, derived.claims[claim.id]?.enforcement ?? 'unknown', owner))
  return { checks, youAreHere: selectPath(model, derived) }
}
