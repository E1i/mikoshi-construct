import type { Manifest } from '../../manifest.js'
import type { Claim, RepositoryModel } from '../../model/schema.js'
import type { FactEvaluation } from '../../model/state.js'
import type { TemplateVars } from '../../presets/index.js'
import { deriveModelState } from '../../model/state.js'
import { buildModel } from '../../model/write.js'
import { getPreset, isPresetId, sampleGroups } from '../../presets/index.js'

export const NOT_CARRIED_READINGS = ['does-not-hold', 'unevaluable', 'every-fact-holds'] as const
export type NotCarriedReading = (typeof NOT_CARRIED_READINGS)[number]

export type ClaimNotCarried
  = | { claimId: string, reading: 'does-not-hold', path: string }
    | { claimId: string, reading: 'unevaluable', path: string }
    | { claimId: string, reading: 'every-fact-holds' }

function supportingFactIds(claim: Claim): string[] {
  return [...claim.enforcement?.supportedBy ?? [], ...claim.verification?.supportedBy ?? []]
}

function expectedModel(manifest: Manifest): RepositoryModel | null {
  if (!isPresetId(manifest.preset))
    return null
  return buildModel({
    vars: manifest.vars as TemplateVars,
    contracts: manifest.contracts != null,
    sample: sampleGroups(getPreset(manifest.preset)).length > 0,
  })
}

function firstPathEvaluating(claim: Claim, expected: RepositoryModel, evaluations: Record<string, FactEvaluation>, to: FactEvaluation): string | null {
  const id = supportingFactIds(claim).find(factId => evaluations[factId] === to)
  return expected.facts.find(fact => fact.id === id)?.path ?? null
}

function readingFor(claim: Claim, expected: RepositoryModel, evaluations: Record<string, FactEvaluation>): ClaimNotCarried {
  const contradicted = firstPathEvaluating(claim, expected, evaluations, 'does-not-hold')
  if (contradicted != null)
    return { claimId: claim.id, reading: 'does-not-hold', path: contradicted }
  const unreadable = firstPathEvaluating(claim, expected, evaluations, 'unevaluable')
  if (unreadable != null)
    return { claimId: claim.id, reading: 'unevaluable', path: unreadable }
  return { claimId: claim.id, reading: 'every-fact-holds' }
}

export function claimsNotCarried(root: string, manifest: Manifest, carried: RepositoryModel | null): ClaimNotCarried[] {
  const expected = expectedModel(manifest)
  if (expected == null)
    return []
  const present = new Set((carried?.claims ?? []).map(claim => claim.id))
  const absent = expected.claims.filter(claim => !present.has(claim.id))
  if (absent.length === 0)
    return []

  const evaluations = deriveModelState(expected, root).facts
  return absent.map(claim => readingFor(claim, expected, evaluations))
}
