import type { DetectReport } from '../detect/index.js'
import type { AiTarget, PresetId, TemplateVars } from '../presets/index.js'
import type { Ui } from '../ui/console.js'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { detect } from '../detect/index.js'
import { buildManifest, writeManifest } from '../manifest.js'
import { applyPlan } from '../materialize/apply.js'
import { planMaterialize } from '../materialize/plan.js'
import { aiGroups, defaultProjectName, getPreset, isPresetId } from '../presets/index.js'
import { VERSION } from '../version.js'
import { printDetectReport } from './soulkill.js'

export interface InitOptions {
  dir: string
  preset?: string
  ai?: string
  yes: boolean
  dryRun: boolean
  name?: string
}

export interface InitResult {
  status: 'done' | 'dry-run' | 'aborted'
  written: string[]
  skipped: string[]
  conflicts: string[]
}

function resolvePreset(value: string | undefined, report: DetectReport): PresetId {
  if (value != null) {
    if (!isPresetId(value))
      throw new Error(`unknown preset "${value}"`)
    return value
  }
  return report.layout === 'monorepo' ? 'monorepo' : 'node-backend'
}

function resolveAi(value: string | undefined): AiTarget {
  if (value == null)
    return 'claude'
  if (value === 'claude' || value === 'cursor' || value === 'both')
    return value
  throw new Error(`unknown AI target "${value}" (claude | cursor | both)`)
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes'
  }
  finally {
    rl.close()
  }
}

export async function runInit(ui: Ui, options: InitOptions): Promise<InitResult> {
  const root = path.resolve(options.dir)
  mkdirSync(root, { recursive: true })

  ui.soulkiller()
  ui.line(`  ${ui.theme.dim('└─')} ${ui.theme.dim(ui.lore.soulkillerDetail)}`)
  ui.line()

  const report = detect(root)
  ui.phase(1, 4, '⚡', ui.lore.phaseScan)
  printDetectReport(ui, report)
  ui.line()

  if (report.layout === 'unknown' && options.preset == null) {
    ui.glitch(ui.lore.unknownStructure)
    return { status: 'aborted', written: [], skipped: [], conflicts: [] }
  }

  const presetId = resolvePreset(options.preset, report)
  const preset = getPreset(presetId)
  if (!preset.available)
    throw new Error(`preset "${presetId}" is not available yet in v${VERSION}`)
  const ai = resolveAi(options.ai)
  const projectName = options.name ?? defaultProjectName(root)

  if (report.packageManager !== 'pnpm' && report.packageManager !== 'none')
    ui.glitch(`This repository uses ${report.packageManager}; the construct harness scripts assume pnpm in v${VERSION}.`)

  ui.phase(2, 4, '🧠', ui.lore.phaseConfigure)
  ui.tree([
    ['Project', projectName],
    ['Preset', `${preset.label} — ${preset.description}`],
    ['AI Netrunners', ai === 'both' ? 'Claude Code, Cursor' : ai === 'claude' ? 'Claude Code' : 'Cursor'],
  ])
  ui.line()

  const vars: TemplateVars = {
    projectName,
    scope: `@${projectName}`,
    nodeMajor: String(report.nodeMajor),
    contractPath: 'contracts/api/openapi.yaml',
    contractTypesOutput: 'src/contracts/openapi.ts',
    harnessCommand: 'pnpm run quality',
    packageManager: 'pnpm',
    constructVersion: VERSION,
    ...preset.vars(report, projectName),
  }

  const groups = [...preset.groups, ...aiGroups(ai)]
  const plan = planMaterialize(root, groups, vars)

  ui.phase(3, 4, '💾', ui.lore.phaseMaterialize)
  ui.tree([[ui.lore.materializeAi], [ui.lore.materializeContracts], [ui.lore.materializePolicies]])
  ui.line()

  const creates = plan.ops.filter(op => op.action === 'create')
  const merges = plan.ops.filter(op => op.action === 'merge' || op.action === 'append')
  const skips = plan.ops.filter(op => op.action === 'skip')

  for (const op of creates)
    ui.line(`  ${ui.theme.ok('+')} ${op.target}`)
  for (const op of merges)
    ui.line(`  ${ui.theme.accent('~')} ${op.target} ${ui.theme.dim(`(${op.action})`)}`)
  for (const op of skips)
    ui.line(`  ${ui.theme.dim('=')} ${ui.theme.dim(`${op.target} — ${op.note ?? 'exists'}`)}`)
  ui.line()

  if (plan.conflicts.length > 0)
    ui.glitch('Existing values kept; review these keys by hand:', plan.conflicts)

  if (options.dryRun) {
    ui.line(ui.theme.dim(ui.lore.dryRun))
    return { status: 'dry-run', written: [], skipped: skips.map(op => op.target), conflicts: plan.conflicts }
  }

  if (!options.yes && !(await confirm(ui.lore.confirm)))
    return { status: 'aborted', written: [], skipped: skips.map(op => op.target), conflicts: plan.conflicts }

  const written = applyPlan(root, plan.ops)
  writeManifest(root, buildManifest({ version: VERSION, preset: presetId, ai, vars, written, contracts: preset.contracts }))

  ui.phase(4, 4, '✅', ui.lore.phaseOnline)
  ui.tree([
    ['Written', `${written.length} files`],
    ['Next', `${vars.packageManager} install && ${vars.harnessCommand}`],
    ['Then', ai === 'cursor' ? 'open Cursor and ask the agent to run the construct discovery' : 'claude → /construct-discover'],
  ])
  return { status: 'done', written: written.map(op => op.target), skipped: skips.map(op => op.target), conflicts: plan.conflicts }
}
