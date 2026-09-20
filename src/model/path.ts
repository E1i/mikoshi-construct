import type { RepositoryModel } from './schema.js'
import type { ClaimStages, ModelState, ModelStateReport } from './state.js'

export const CHAIN_STAGES = ['enforcement', 'verification'] as const
export type ChainStage = (typeof CHAIN_STAGES)[number]

export type StoppingState = Exclude<ModelState, 'held'>

export interface SelectedPath {
  claimId: string
  stage: ChainStage
  state: StoppingState
}

function firstStop(claimId: string, stages: ClaimStages): SelectedPath | null {
  for (const stage of CHAIN_STAGES) {
    const state = stages[stage]
    if (state !== 'held')
      return { claimId, stage, state }
  }
  return null
}

export function selectPath(model: RepositoryModel, derived: ModelStateReport): SelectedPath | null {
  let selected: SelectedPath | null = null
  let selectedDepth: number = CHAIN_STAGES.length
  for (const claim of model.claims) {
    const stages = derived.claims[claim.id]
    if (stages === undefined)
      continue
    const stop = firstStop(claim.id, stages)
    if (stop === null)
      continue
    const depth = CHAIN_STAGES.indexOf(stop.stage)
    if (depth < selectedDepth) {
      selected = stop
      selectedDepth = depth
    }
  }
  return selected
}
