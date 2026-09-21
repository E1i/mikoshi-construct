import type { Manifest } from '../manifest.js'
import type { FileOp } from '../materialize/plan.js'
import type { TemplateGroup, TemplateVars } from '../presets/index.js'
import type { PathClassification } from './classify.js'
import type { EstablishedVariant } from './variant.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { recordedShas, recordedVariants } from '../manifest.js'
import { NO_TREE_TO_PLAN_AGAINST, planMaterialize } from '../materialize/plan.js'
import { sampleWasMaterialized } from '../materialize/sample.js'
import { strategyFor } from '../materialize/strategies.js'
import { getPreset, groupsFor } from '../presets/index.js'
import { classifyRepository } from './classify.js'
import { establishVariant, existingForm } from './variant.js'

export interface ReplayInput {
  root: string
  manifest: Manifest
  version: string
  facts: Record<string, string>
}

export interface ReplayReport {
  fromVersion: string
  toVersion: string
  present: Record<string, string>
  produced: Record<string, string>
  variants: Record<string, EstablishedVariant>
  classifications: PathClassification[]
}

function replayedGroups(manifest: Manifest): TemplateGroup[] {
  return groupsFor(getPreset(manifest.preset), manifest.ai, manifest.review?.provider ?? 'none')
}

function varsRecordingMisses(manifest: Manifest, version: string, facts: Record<string, string>, missed: Set<string>): TemplateVars {
  const asRecordedExceptTheRunningVersion: Record<string, string> = { ...manifest.vars, constructVersion: version }
  return new Proxy(asRecordedExceptTheRunningVersion, {
    get(target, key) {
      if (typeof key !== 'string')
        return Reflect.get(target, key)
      const value = target[key]
      if (value != null)
        return value
      const established = facts[key]
      if (established != null)
        return established
      missed.add(key)
      return ''
    },
  }) as TemplateVars
}

function missingVariables(manifest: Manifest, missed: Set<string>): string {
  const names = [...missed].sort().join(', ')
  return `construct.json was written by construct ${manifest.construct} and carries no value for ${names}, which today's ${manifest.preset} templates render. Add ${missed.size === 1 ? 'it' : 'each of them'} under "vars" in construct.json and run the sync again.`
}

function contentByTarget(ops: FileOp[]): Record<string, string> {
  return Object.fromEntries(ops.map(op => [op.target, op.content]))
}

interface ReplayedTemplates {
  produced: Record<string, string>
  existingVariants: Record<string, string>
}

function producedByTemplates(manifest: Manifest, vars: TemplateVars, recorded: Record<string, string>): ReplayedTemplates {
  const groups = replayedGroups(manifest)
  const plan = (emptyTarget: boolean): ReturnType<typeof planMaterialize> =>
    planMaterialize(NO_TREE_TO_PLAN_AGAINST, groups, vars, { emptyTarget, ai: manifest.ai })

  const withoutSamples = plan(false)
  const kept = contentByTarget(withoutSamples.ops)
  if (withoutSamples.omittedGroups.length === 0)
    return { produced: kept, existingVariants: withoutSamples.existingVariants }

  const withSamples = plan(true)
  const sampled = contentByTarget(withSamples.ops)
  return sampleWasMaterialized(Object.keys(sampled), Object.keys(kept), recorded)
    ? { produced: sampled, existingVariants: withSamples.existingVariants }
    : { produced: kept, existingVariants: withoutSamples.existingVariants }
}

function establishedVariants(input: {
  manifest: Manifest
  recorded: Record<string, string>
  present: Record<string, string>
  templates: ReplayedTemplates
}): Record<string, EstablishedVariant> {
  const recordedVariant = recordedVariants(input.manifest)
  const established: Record<string, EstablishedVariant> = {}
  for (const [target, producedDefault] of Object.entries(input.templates.produced)) {
    const present = input.present[target]
    if (strategyFor(target) !== 'append-block' || present == null)
      continue
    const variant = establishVariant({
      target,
      recordedVariant: recordedVariant[target] ?? null,
      recordedSha: input.recorded[target] ?? null,
      present,
      producedDefault,
      existingTemplate: input.templates.existingVariants[target] ?? null,
    })
    if (variant != null)
      established[target] = variant
  }
  return established
}

function producedInTheVariantThatWroteIt(templates: ReplayedTemplates, variants: Record<string, EstablishedVariant>): Record<string, string> {
  const produced = { ...templates.produced }
  for (const [target, established] of Object.entries(variants)) {
    const template = templates.existingVariants[target]
    if (established.variant === 'existing' && template != null)
      produced[target] = existingForm(target, template)
  }
  return produced
}

function presentInTree(root: string, targets: string[]): Record<string, string> {
  const present: Record<string, string> = {}
  for (const target of new Set(targets)) {
    const absolute = path.join(root, target)
    if (existsSync(absolute))
      present[target] = readFileSync(absolute, 'utf8')
  }
  return present
}

export function replay(input: ReplayInput): ReplayReport {
  const missed = new Set<string>()
  const vars = varsRecordingMisses(input.manifest, input.version, input.facts, missed)
  const recorded = recordedShas(input.manifest)
  const templates = producedByTemplates(input.manifest, vars, recorded)
  if (missed.size > 0)
    throw new Error(missingVariables(input.manifest, missed))

  const present = presentInTree(input.root, [...Object.keys(recorded), ...Object.keys(templates.produced)])
  const variants = establishedVariants({ manifest: input.manifest, recorded, present, templates })
  const produced = producedInTheVariantThatWroteIt(templates, variants)
  return {
    fromVersion: input.manifest.construct,
    toVersion: input.version,
    present,
    produced,
    variants,
    classifications: classifyRepository({ recorded, present, produced, variants }),
  }
}
