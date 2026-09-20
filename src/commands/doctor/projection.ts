import type { OwnerReader } from '../../model/ownership.js'
import type { SelectedPath } from '../../model/path.js'
import type { Claim, RepositoryModel } from '../../model/schema.js'
import type { CheckId, CheckVerdict } from './verdict.js'
import { authoredByOwner } from '../../model/ownership.js'
import { selectPath } from '../../model/path.js'
import { deriveModelState } from '../../model/state.js'
import { CHECK_IDS } from './verdict.js'

export const CHECK_CLAIMS: Record<CheckId, string> = {
  'lint-policy': 'lint-policy',
  'ci': 'every-change-passes-the-harness',
}

export interface KnowledgeProjection {
  checks: CheckVerdict[]
  youAreHere: SelectedPath | null
}

function verdict(id: CheckId, claim: Claim, state: CheckVerdict['state'], owner: OwnerReader): CheckVerdict {
  return {
    id,
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
  const checks = CHECK_IDS.flatMap((id) => {
    const claim = model.claims.find(entry => entry.id === CHECK_CLAIMS[id])
    if (claim == null)
      return []
    return [verdict(id, claim, derived.claims[claim.id]?.enforcement ?? 'unknown', owner)]
  })
  return { checks, youAreHere: selectPath(model, derived) }
}
