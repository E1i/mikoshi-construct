import type { DetectReport } from '../detect/index.js'
import type { AiTarget, PresetId, ReviewProvider, TemplateVars } from '../presets/index.js'
import type { Ui } from '../ui/console.js'
import type { Prompter } from '../ui/prompts.js'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { detect } from '../detect/index.js'
import { buildManifest, writeManifest } from '../manifest.js'
import { applyPlan } from '../materialize/apply.js'
import { planMaterialize } from '../materialize/plan.js'
import { AI_TARGET_LABELS, aiGroups, DEFAULT_REVIEW_MODEL, defaultProjectName, getPreset, isPresetId, PRESET_LIST, reviewGroups } from '../presets/index.js'
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
}

const CANCELLED = Symbol('cancelled')

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

function parseAi(value: string): AiTarget {
  if (value === 'claude' || value === 'cursor' || value === 'both')
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

async function askChoices(ui: Ui, options: InitOptions, report: DetectReport, root: string, prompter: Prompter | undefined): Promise<InitChoices | typeof CANCELLED> {
  const suggested = suggestedPreset(report)

  let presetId: PresetId | undefined = options.preset == null ? undefined : parsePreset(options.preset)
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
  if (ai == null) {
    ai = prompter == null ? 'claude' : await prompter.aiTarget('claude')
    if (ai == null)
      return CANCELLED
  }

  let projectName: string | undefined = options.name == null ? undefined : parseProjectName(options.name)
  if (projectName == null) {
    const fallback = defaultProjectName(root)
    projectName = prompter == null ? fallback : await prompter.projectName(fallback)
    if (projectName == null)
      return CANCELLED
  }

  let review: ReviewProvider | undefined = options.review == null ? undefined : parseReview(options.review)
  if (review == null) {
    const wanted = prompter == null ? false : await prompter.review(false)
    if (wanted == null)
      return CANCELLED
    review = wanted ? 'claude' : 'none'
  }

  return { presetId, ai, projectName, review }
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

  ui.phase(2, 4, '🧠', ui.lore.phaseConfigure)
  const choices = await askChoices(ui, options, report, root, interactive)
  if (choices === CANCELLED)
    return aborted()
  const { presetId, ai, projectName, review } = choices
  const preset = getPreset(presetId)
  if (!preset.available)
    throw new Error(`preset "${presetId}" is not available yet in v${VERSION}`)

  if (report.packageManager !== 'pnpm' && report.packageManager !== 'none')
    ui.glitch(`This repository uses ${report.packageManager}; the construct harness scripts assume pnpm in v${VERSION}.`)

  ui.tree([
    ['Project', projectName],
    ['Preset', `${preset.label} — ${preset.description}`],
    ['AI Netrunners', AI_TARGET_LABELS[ai]],
    ['Code review', review === 'claude' ? `Claude on pull requests (${options.reviewModel ?? DEFAULT_REVIEW_MODEL})` : 'none'],
  ])
  ui.line()

  const vars: TemplateVars = {
    projectName,
    scope: `@${projectName}`,
    nodeMajor: String(report.nodeMajor),
    contracts: preset.contracts ? 'true' : 'false',
    contractPath: 'contracts/api/openapi.yaml',
    contractTypesOutput: 'src/contracts/openapi.ts',
    compositionDir: report.existing.compositionDir ?? 'architecture/composition',
    harnessCommand: 'pnpm run quality',
    packageManager: 'pnpm',
    pnpmVersion: report.pnpmVersion ?? '',
    reviewModel: options.reviewModel ?? DEFAULT_REVIEW_MODEL,
    constructVersion: VERSION,
    ...preset.vars(report, projectName),
  }

  const groups = [...preset.groups, ...aiGroups(ai), ...reviewGroups(review)]
  const plan = planMaterialize(root, groups, vars, { emptyTarget: report.layout === 'empty', ai })

  ui.phase(3, 4, '💾', ui.lore.phaseMaterialize)
  ui.tree([[ui.lore.materializeAi], [ui.lore.materializeContracts], [ui.lore.materializePolicies]])
  ui.line()

  const creates = plan.ops.filter(op => op.action === 'create')
  const merges = plan.ops.filter(op => op.action === 'merge' || op.action === 'append')
  const skips = plan.ops.filter(op => op.action === 'skip')
  const skipped = skips.map(op => op.target)

  for (const op of creates)
    ui.line(`  ${ui.theme.ok('+')} ${op.target}`)
  for (const op of merges)
    ui.line(`  ${ui.theme.accent('~')} ${op.target} ${ui.theme.dim(`(${op.action})`)}`)
  for (const op of skips)
    ui.line(`  ${ui.theme.dim('=')} ${ui.theme.dim(`${op.target} — ${op.note ?? 'exists'}`)}`)
  ui.line()

  if (plan.omittedGroups.length > 0)
    ui.line(ui.theme.dim(`  ${ui.lore.sampleOmitted}`))
  if (report.existing.compositionDir != null && report.existing.compositionDir !== 'architecture/composition')
    ui.line(ui.theme.dim(`  Existing composition models found at ${report.existing.compositionDir}/ — kept there, not moved.`))
  if (plan.conflicts.length > 0)
    ui.glitch('Existing values kept; review these keys by hand:', plan.conflicts)

  if (options.dryRun) {
    ui.line(ui.theme.dim(ui.lore.dryRun))
    return { status: 'dry-run', written: [], skipped, conflicts: plan.conflicts }
  }

  if (interactive != null && (await interactive.confirm(ui.lore.confirm)) !== true)
    return aborted(skipped, plan.conflicts)

  const written = applyPlan(root, plan.ops)
  writeManifest(root, buildManifest({ version: VERSION, preset: presetId, ai, review, vars, written, contracts: preset.contracts }))

  ui.phase(4, 4, '✅', ui.lore.phaseOnline)
  ui.tree([
    ['Written', `${written.length} files`],
    ['Next', `${vars.packageManager} install && ${vars.harnessCommand}`],
    ['Then', ai === 'cursor' ? 'open Cursor and ask the agent to run the construct discovery' : 'claude → /construct-discover'],
  ])
  return { status: 'done', written: written.map(op => op.target), skipped, conflicts: plan.conflicts }
}
