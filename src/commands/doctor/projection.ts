import type { OwnerReader } from '../../model/ownership.js'
import type { SelectedPath } from '../../model/path.js'
import type { Claim, RepositoryModel } from '../../model/schema.js'
import type { StageFinding } from '../../model/state.js'
import type { CheckVerdict } from './verdict.js'
import { authoredByOwner } from '../../model/ownership.js'
import { selectPath } from '../../model/path.js'
import { deriveModelState } from '../../model/state.js'

export interface KnowledgeProjection {
  checks: CheckVerdict[]
  youAreHere: SelectedPath | null
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

const NOTHING_NAMED: StageFinding = { state: 'unknown', reason: 'no-fact-named' }

export function projectKnowledge(model: RepositoryModel | null, root: string, owner: OwnerReader = authoredByOwner): KnowledgeProjection {
  if (model == null)
    return { checks: [], youAreHere: null }
  const derived = deriveModelState(model, root)
  const checks = model.claims.map(claim => verdict(claim, derived.claims[claim.id]?.enforcement ?? NOTHING_NAMED, owner))
  return { checks, youAreHere: selectPath(model, derived) }
}
