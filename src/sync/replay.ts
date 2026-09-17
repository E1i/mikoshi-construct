import type { Manifest } from '../manifest.js'
import type { FileOp } from '../materialize/plan.js'
import type { TemplateGroup, TemplateVars } from '../presets/index.js'
import type { PathClassification } from './classify.js'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recordedShas } from '../manifest.js'
import { planMaterialize } from '../materialize/plan.js'
import { aiGroups, getPreset, reviewGroups } from '../presets/index.js'
import { classifyRepository } from './classify.js'

const NO_TREE_TO_PLAN_AGAINST = path.join(tmpdir(), 'mikoshi-construct-replay-renders-against-no-tree')

export interface ReplayInput {
  root: string
  manifest: Manifest
  version: string
}

export interface ReplayReport {
  fromVersion: string
  toVersion: string
  present: Record<string, string>
  produced: Record<string, string>
  classifications: PathClassification[]
}

function replayedGroups(manifest: Manifest): TemplateGroup[] {
  const preset = getPreset(manifest.preset)
  return [...preset.groups, ...aiGroups(manifest.ai), ...reviewGroups(manifest.review?.provider ?? 'none')]
}

function varsRecordingMisses(manifest: Manifest, version: string, missed: Set<string>): TemplateVars {
  const asRecordedExceptTheRunningVersion: Record<string, string> = { ...manifest.vars, constructVersion: version }
  return new Proxy(asRecordedExceptTheRunningVersion, {
    get(target, key) {
      if (typeof key !== 'string')
        return Reflect.get(target, key)
      const value = target[key]
      if (value != null)
        return value
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

function producedByTemplates(manifest: Manifest, vars: TemplateVars, recorded: Record<string, string>): Record<string, string> {
  const groups = replayedGroups(manifest)
  const plan = (emptyTarget: boolean): ReturnType<typeof planMaterialize> =>
    planMaterialize(NO_TREE_TO_PLAN_AGAINST, groups, vars, { emptyTarget, ai: manifest.ai })

  const withoutSamples = plan(false)
  if (withoutSamples.omittedGroups.length === 0)
    return contentByTarget(withoutSamples.ops)

  const kept = contentByTarget(withoutSamples.ops)
  const withSamples = contentByTarget(plan(true).ops)
  const sampleWasMaterialized = Object.keys(withSamples).some(target => !(target in kept) && recorded[target] != null)
  return sampleWasMaterialized ? withSamples : kept
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
  const vars = varsRecordingMisses(input.manifest, input.version, missed)
  const recorded = recordedShas(input.manifest)
  const produced = producedByTemplates(input.manifest, vars, recorded)
  if (missed.size > 0)
    throw new Error(missingVariables(input.manifest, missed))

  const present = presentInTree(input.root, [...Object.keys(recorded), ...Object.keys(produced)])
  return {
    fromVersion: input.manifest.construct,
    toVersion: input.version,
    present,
    produced,
    classifications: classifyRepository({ recorded, present, produced }),
  }
}
