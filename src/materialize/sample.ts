import type { AiTarget, TemplateGroup, TemplateVars } from '../presets/index.js'
import { NO_TREE_TO_PLAN_AGAINST, planMaterialize } from './plan.js'

export interface SampleQuestion {
  groups: TemplateGroup[]
  sampleMounts: TemplateGroup[]
  vars: TemplateVars
  ai: AiTarget
  recorded: Record<string, string>
}

export function sampleWasMaterialized(sampled: Iterable<string>, kept: Iterable<string>, recorded: Record<string, string>): boolean {
  const producedWithoutTheSample = new Set(kept)
  return [...sampled].some(target => !producedWithoutTheSample.has(target) && recorded[target] != null)
}

export function repositoryCarriesTheSample(question: SampleQuestion): boolean {
  if (question.sampleMounts.length === 0)
    return false
  const targetsOf = (groups: TemplateGroup[], emptyTarget: boolean): string[] =>
    planMaterialize(NO_TREE_TO_PLAN_AGAINST, groups, question.vars, { emptyTarget, ai: question.ai }).ops.map(op => op.target)
  return sampleWasMaterialized(targetsOf(question.sampleMounts, true), targetsOf(question.groups, false), question.recorded)
}
