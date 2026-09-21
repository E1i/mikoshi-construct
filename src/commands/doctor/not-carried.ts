import type { Manifest } from '../../manifest.js'
import type { Claim, RepositoryModel } from '../../model/schema.js'
import type { TemplateVars } from '../../presets/index.js'
import { deriveModelState } from '../../model/state.js'
import { buildModel } from '../../model/write.js'
import { getPreset, isPresetId, sampleGroups } from '../../presets/index.js'

export interface ClaimNotCarried {
  claimId: string
  doesNotHold: string | null
}

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

export function claimsNotCarried(root: string, manifest: Manifest, carried: RepositoryModel | null): ClaimNotCarried[] {
  const expected = expectedModel(manifest)
  if (expected == null)
    return []
  const present = new Set((carried?.claims ?? []).map(claim => claim.id))
  const absent = expected.claims.filter(claim => !present.has(claim.id))
  if (absent.length === 0)
    return []

  const evaluations = deriveModelState(expected, root).facts
  return absent.map((claim) => {
    const failing = supportingFactIds(claim).find(id => evaluations[id] !== 'holds')
    const fact = expected.facts.find(entry => entry.id === failing)
    return { claimId: claim.id, doesNotHold: fact?.path ?? null }
  })
}
