import type { Claim, RepositoryModel } from './schema.js'
import type { ClaimStages } from './state.js'
import { authoredByOwner } from './ownership.js'
import { deriveModelState } from './state.js'
import { factsStoodOn } from './write.js'

export interface StillbornClaim {
  claimId: string
  doesNotHold: [string, ...string[]]
}

export interface BirthReport {
  model: RepositoryModel
  stillborn: StillbornClaim[]
}

function supportingFactIds(claim: Claim): string[] {
  return [...claim.enforcement?.supportedBy ?? [], ...claim.verification?.supportedBy ?? []]
}

function evidenceThatDoesNotHold(claim: Claim, stages: ClaimStages | undefined): string[] {
  const declared = [
    ...claim.enforcement == null ? [] : [stages?.enforcement],
    ...claim.verification == null ? [] : [stages?.verification],
  ]
  return [...new Set(declared.flatMap(stage => (stage?.state === 'unsupported' ? stage.doesNotHold : [])))]
}

export function withoutStillbornClaims(fresh: RepositoryModel, existing: RepositoryModel | null, root: string): BirthReport {
  const alreadyRecorded = new Set((existing?.claims ?? []).map(claim => claim.id))
  const derived = deriveModelState(fresh, root)
  const stillborn: StillbornClaim[] = []
  const dropped: Claim[] = []

  const claims = fresh.claims.filter((claim) => {
    if (authoredByOwner(claim) !== 'construct' || alreadyRecorded.has(claim.id))
      return true
    const [first, ...rest] = evidenceThatDoesNotHold(claim, derived.claims[claim.id])
    if (first === undefined)
      return true
    stillborn.push({ claimId: claim.id, doesNotHold: [first, ...rest] })
    dropped.push(claim)
    return false
  })

  const released = new Set(dropped.flatMap(supportingFactIds))
  const stoodOn = factsStoodOn(claims, fresh.hypotheses)
  return {
    model: {
      ...fresh,
      claims,
      facts: fresh.facts.filter(fact => !released.has(fact.id) || stoodOn.has(fact.id)),
    },
    stillborn,
  }
}
