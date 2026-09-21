import type { DetectReport } from '../detect/index.js'
import type { Manifest } from '../manifest.js'
import type { FileOp } from '../materialize/plan.js'
import type { AiTarget, Preset, PresetId, ReviewProvider, TemplateVars } from '../presets/index.js'
import type { Ui } from '../ui/console.js'
import type { Prompter } from '../ui/prompts.js'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_COMPOSITION_DIR, detect } from '../detect/index.js'
import { buildManifest, readManifest, recordedShas, recordedVariants, writeManifest } from '../manifest.js'
import { applyPlan } from '../materialize/apply.js'
import { planMaterialize } from '../materialize/plan.js'
import { repositoryCarriesTheSample } from '../materialize/sample.js'
import { withoutStillbornClaims } from '../model/birth.js'
import { buildModel, mergeModel, readModel, writeModel } from '../model/write.js'
import { AI_TARGET_LABELS, DEFAULT_REVIEW_MODEL, defaultProjectName, getPreset, groupsFor, isPresetId, keysGivenADefault, PRESET_LIST, sampleGroups, sampleMounts, workspacePackagesFor } from '../presets/index.js'
import { isValidProjectName } from '../ui/prompts.js'
import { VERSION } from '../version.js'
import { printDetectReport } from './soulkill.js'

export interface InitOptions {
  dir: string
  preset?: string
  ai?: string
  yes: boolean
  dryRun: boolean
  name?: string
  review?: string
  reviewModel?: string
}

export interface InitResult {
  status: 'done' | 'dry-run' | 'aborted'
  written: string[]
  skipped: string[]
  conflicts: string[]
}

interface InitChoices {
  presetId: PresetId
  ai: AiTarget
  projectName: string
  review: ReviewProvider
  reviewModel: string
  answeredByTheRecord: string[]
}

interface RecordedChoices {
  presetId?: PresetId
  ai?: AiTarget
  projectName?: string
  review?: ReviewProvider
  reviewModel?: string
}

function choicesAlreadyRecorded(previous: Manifest | null): RecordedChoices {
  if (previous == null)
    return {}
  const name = previous.vars?.projectName
  return {
    presetId: isPresetId(previous.preset) ? previous.preset : undefined,
    ai: isAiTarget(previous.ai) ? previous.ai : undefined,
    projectName: typeof name === 'string' && isValidProjectName(name) ? name : undefined,
    review: previous.review == null ? 'none' : previous.review.provider,
    reviewModel: previous.review?.model,
  }
}

const CANCELLED = Symbol('cancelled')

const RESTATED_BY_THE_RUNNING_BINARY = ['constructVersion']

function varsThisRunChanged(previous: Manifest, vars: TemplateVars): { name: string, from: string, to: string }[] {
  return Object.entries(vars)
    .filter(([name]) => !RESTATED_BY_THE_RUNNING_BINARY.includes(name))
    .flatMap(([name, to]) => {
      const from = previous.vars[name]
      return from == null || from === to ? [] : [{ name, from, to }]
    })
}

interface RecordDelta {
  carriedOver: number
  added: number
}

function recordDelta(previous: Manifest, applied: FileOp[]): RecordDelta {
  const recorded = recordedShas(previous)
  const targets = new Set(applied.map(op => op.target))
  return {
    carriedOver: Object.keys(recorded).filter(target => !targets.has(target)).length,
    added: applied.filter(op => recorded[op.target] == null).length,
  }
}

const DEPENDENCY_MANIFESTS = ['package.json', 'pnpm-workspace.yaml']

function declaresDependencies(target: string): boolean {
  return DEPENDENCY_MANIFESTS.includes(path.basename(target))
}

function changesTheTree(root: string, op: FileOp): boolean {
  if (op.action === 'create')
    return true
  const absolute = path.join(root, op.target)
  return !existsSync(absolute) || readFileSync(absolute, 'utf8') !== op.content
}

function nextStepAfter(changing: FileOp[], vars: TemplateVars): string | null {
  if (changing.length === 0)
    return null
  return changing.some(op => declaresDependencies(op.target))
    ? `${vars.packageManager} install && ${vars.harnessCommand}`
    : vars.harnessCommand
}

interface SampleReading {
  preset: Preset
  vars: TemplateVars
  ai: AiTarget
  review: ReviewProvider
  omittedGroups: string[]
  previous: Manifest | null
}

function sampleMaterializedByThisRun(preset: Preset, omittedGroups: string[]): boolean {
  const groups = sampleGroups(preset)
  return groups.length > 0 && groups.every(group => !omittedGroups.includes(group))
}

function sampleIsHere(reading: SampleReading): boolean {
  if (sampleMaterializedByThisRun(reading.preset, reading.omittedGroups))
    return true
  if (reading.previous == null)
    return false
  return repositoryCarriesTheSample({
    groups: groupsFor(reading.preset, reading.ai, reading.review),
    sampleMounts: sampleMounts(reading.preset),
    vars: reading.vars,
    ai: reading.ai,
    recorded: recordedShas(reading.previous),
  })
}

function aborted(skipped: string[] = [], conflicts: string[] = []): InitResult {
  return { status: 'aborted', written: [], skipped, conflicts }
}

function suggestedPreset(report: DetectReport): PresetId | undefined {
  if (report.layout === 'unknown')
    return undefined
  return report.layout === 'monorepo' ? 'monorepo' : 'node-backend'
}

function parsePreset(value: string): PresetId {
  if (!isPresetId(value))
    throw new Error(`unknown preset "${value}"`)
  return value
}

function isAiTarget(value: string): value is AiTarget {
  return value === 'claude' || value === 'cursor' || value === 'both'
}

function parseAi(value: string): AiTarget {
  if (isAiTarget(value))
    return value
  throw new Error(`unknown AI target "${value}" (claude | cursor | both)`)
}

function parseReview(value: string): ReviewProvider {
  if (value === 'claude' || value === 'none')
    return value
  throw new Error(`unknown review provider "${value}" (claude | none)`)
}

function parseProjectName(value: string): string {
  if (!isValidProjectName(value))
    throw new Error(`invalid project name "${value}"`)
  return value
}

async function askChoices(ui: Ui, options: InitOptions, report: DetectReport, root: string, prompter: Prompter | undefined, previous: Manifest | null): Promise<InitChoices | typeof CANCELLED> {
  const suggested = suggestedPreset(report)
  const recorded = choicesAlreadyRecorded(previous)
  const answeredByTheRecord: string[] = []
  const fromTheRecord = <T>(name: string, value: T | undefined): T | undefined => {
    if (value !== undefined)
      answeredByTheRecord.push(name)
    return value
  }

  let presetId: PresetId | undefined = options.preset == null ? undefined : parsePreset(options.preset)
  presetId ??= fromTheRecord('preset', recorded.presetId)
  if (presetId == null) {
    if (report.layout === 'unknown')
      ui.glitch(ui.lore.unknownStructure)
    if (prompter == null) {
      if (suggested == null)
        return CANCELLED
      presetId = suggested
    }
    else {
      presetId = await prompter.preset(PRESET_LIST, suggested)
      if (presetId == null)
        return CANCELLED
    }
  }

  let ai: AiTarget | undefined = options.ai == null ? undefined : parseAi(options.ai)
  ai ??= fromTheRecord('agents', recorded.ai)
  if (ai == null) {
    ai = prompter == null ? 'claude' : await prompter.aiTarget('claude')
    if (ai == null)
      return CANCELLED
  }

  let projectName: string | undefined = options.name == null ? undefined : parseProjectName(options.name)
  projectName ??= fromTheRecord('project name', recorded.projectName)
  if (projectName == null) {
    const fallback = defaultProjectName(root)
    projectName = prompter == null ? fallback : await prompter.projectName(fallback)
    if (projectName == null)
      return CANCELLED
  }

  let review: ReviewProvider | undefined = options.review == null ? undefined : parseReview(options.review)
  review ??= fromTheRecord('code review', recorded.review)
  if (review == null) {
    const wanted = prompter == null ? false : await prompter.review(false)
    if (wanted == null)
      return CANCELLED
    review = wanted ? 'claude' : 'none'
  }

  const reviewModel = options.reviewModel ?? recorded.reviewModel ?? DEFAULT_REVIEW_MODEL

  return { presetId, ai, projectName, review, reviewModel, answeredByTheRecord }
}

export async function runInit(ui: Ui, options: InitOptions, prompter?: Prompter): Promise<InitResult> {
  const root = path.resolve(options.dir)
  mkdirSync(root, { recursive: true })

  if (!options.yes && prompter == null) {
    ui.glitch(ui.lore.needsTerminal)
    return aborted()
  }
  const interactive = options.yes ? undefined : prompter

  ui.soulkiller()
  ui.line(`  ${ui.theme.dim('└─')} ${ui.theme.dim(ui.lore.soulkillerDetail)}`)
  ui.line()

  const report = detect(root)
  ui.phase(1, 4, '⚡', ui.lore.phaseScan)
  printDetectReport(ui, report)
  ui.line()

  const previous = readManifest(root)

  ui.phase(2, 4, '🧠', ui.lore.phaseConfigure)
  const choices = await askChoices(ui, options, report, root, interactive, previous)
  if (choices === CANCELLED)
    return aborted()
  const { presetId, ai, projectName, review, reviewModel, answeredByTheRecord } = choices
  const preset = getPreset(presetId)
  if (!preset.available)
    throw new Error(`preset "${presetId}" is not available yet in v${VERSION}`)

  if (report.packageManager !== 'pnpm' && report.packageManager !== 'none')
    ui.glitch(`This repository uses ${report.packageManager}; the construct harness scripts assume pnpm in v${VERSION}.`)

  ui.tree([
    ['Project', projectName],
    ['Preset', `${preset.label} — ${preset.description}`],
    ['AI Netrunners', AI_TARGET_LABELS[ai]],
    ['Code review', review === 'claude' ? `Claude on pull requests (${reviewModel})` : 'none'],
  ])
  if (answeredByTheRecord.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.recordAnswered(answeredByTheRecord)}`))
  ui.line()

  const recordedPolicy = previous?.policy?.workspaceImports ?? null
  const policy = preset.policy?.(report, projectName, recordedPolicy) ?? null
  const policyKeysAdded = preset.policy == null ? [] : keysGivenADefault(workspacePackagesFor(report, projectName), recordedPolicy)

  const vars: TemplateVars = {
    projectName,
    scope: `@${projectName}`,
    nodeMajor: String(report.nodeMajor),
    contracts: preset.contracts ? 'true' : 'false',
    contractPath: 'contracts/api/openapi.yaml',
    contractTypesOutput: 'src/contracts/openapi.ts',
    compositionDir: report.existing.compositionDir ?? DEFAULT_COMPOSITION_DIR,
    harnessCommand: 'pnpm run quality',
    packageManager: 'pnpm',
    pnpmVersion: report.pnpmVersion ?? '',
    reviewModel,
    constructVersion: VERSION,
    ...preset.vars(report, projectName, policy),
  }

  const groups = groupsFor(preset, ai, review)
  const plan = planMaterialize(root, groups, vars, {
    emptyTarget: report.layout === 'empty',
    ai,
    recordedVariants: previous == null ? undefined : recordedVariants(previous),
  })

  ui.phase(3, 4, '💾', ui.lore.phaseMaterialize)
  ui.tree([[ui.lore.materializeAi], [ui.lore.materializeContracts], [ui.lore.materializePolicies]])
  ui.line()

  const creates = plan.ops.filter(op => op.action === 'create')
  const merges = plan.ops.filter(op => op.action === 'merge' || op.action === 'append')
  const skips = plan.ops.filter(op => op.action === 'skip')
  const skipped = skips.map(op => op.target)
  const applied = plan.ops.filter(op => op.action !== 'skip')

  if (previous != null) {
    const delta = recordDelta(previous, applied)
    ui.line(ui.theme.dim(`  ${ui.lore.recordCarriedOver(delta.carriedOver, delta.added)}`))
    const changed = varsThisRunChanged(previous, vars)
    if (changed.length > 0)
      ui.line(ui.theme.dim(`  ${ui.lore.recordVarsChanged(changed)}`))
    if (policyKeysAdded.length > 0 && policy != null)
      ui.line(ui.theme.dim(`  ${ui.lore.policyGainedKeys(policyKeysAdded.map(dir => ({ dir, allowed: policy[dir] ?? [] })))}`))
    ui.line()
  }

  for (const op of creates)
    ui.line(`  ${ui.theme.ok('+')} ${op.target}`)
  for (const op of merges)
    ui.line(`  ${ui.theme.accent('~')} ${op.target} ${ui.theme.dim(`(${op.action})`)}`)
  for (const op of skips)
    ui.line(`  ${ui.theme.dim('=')} ${ui.theme.dim(`${op.target} — ${op.note ?? 'exists'}`)}`)
  ui.line()

  if (plan.omittedGroups.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.sampleOmitted}`))
  if (report.existing.compositionDir != null && report.existing.compositionDir !== DEFAULT_COMPOSITION_DIR)
    ui.line(ui.theme.dim(`  Existing composition models found at ${report.existing.compositionDir}/ — kept there, not moved.`))
  if (plan.conflicts.length > 0)
    ui.glitch('Existing values kept; review these keys by hand:', plan.conflicts)
  if (skips.length > 0 && !report.existing.constructJson)
    ui.glitch(ui.lore.wireHarness, ui.lore.wireHarnessSteps)

  if (options.dryRun) {
    ui.line(ui.theme.dim(ui.lore.dryRun))
    return { status: 'dry-run', written: [], skipped, conflicts: plan.conflicts }
  }

  if (interactive != null && (await interactive.confirm(ui.lore.confirm)) !== true)
    return aborted(skipped, plan.conflicts)

  const existingModel = readModel(root)
  const changing = applied.filter(op => changesTheTree(root, op))
  const next = nextStepAfter(changing, vars)
  const written = applyPlan(root, plan.ops)
  const manifest = buildManifest({ version: VERSION, preset: presetId, ai, review, vars, written, contracts: preset.contracts, previous, policy })
  writeManifest(root, manifest)
  const sample = sampleIsHere({ preset, vars, ai, review, omittedGroups: plan.omittedGroups, previous })
  const born = withoutStillbornClaims(buildModel({ vars, contracts: preset.contracts, sample }), existingModel, root)
  const merged = mergeModel(existingModel, born.model)
  writeModel(root, merged.model)
  for (const claim of born.stillborn)
    ui.line(ui.theme.dim(`  ${ui.lore.recordClaimNotBorn(claim.claimId, claim.doesNotHold)}`))
  if (merged.retained.length > 0) {
    const standingOn = [...new Set(merged.retained.flatMap(fact => fact.stoodOnBy))]
    ui.line(ui.theme.dim(`  ${ui.lore.recordFactsRetained(merged.retained.map(fact => fact.id), standingOn)}`))
  }
  ui.phase(4, 4, '✅', ui.lore.phaseOnline)
  ui.tree([
    ['Written', ui.lore.written(written.length, changing.length)],
    ...next == null ? [] : [['Next', next] as [string, string]],
    ['Then', ai === 'cursor' ? 'open Cursor and ask the agent to run the construct discovery' : 'claude → /construct-discover'],
  ])
  return { status: 'done', written: written.map(op => op.target), skipped, conflicts: plan.conflicts }
}
