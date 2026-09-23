import type { FileOp } from '../../materialize/plan.js'
import type { TemplateVars } from '../../presets/index.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { planMaterialize } from '../../materialize/plan.js'
import { ATTACH_CARRIERS, defaultProjectName } from '../../presets/index.js'
import { VERSION } from '../../version.js'

function carrierVars(root: string, harnessCommand: string): TemplateVars {
  const projectName = defaultProjectName(root)
  return {
    projectName,
    scope: `@${projectName}`,
    nodeMajor: '',
    contracts: 'false',
    contractPath: '',
    contractTypesOutput: '',
    compositionDir: '',
    harnessCommand,
    packageManager: '',
    pnpmVersion: '',
    reviewModel: '',
    constructVersion: VERSION,
  }
}

export function planCarriers(root: string, harnessCommand: string): FileOp[] {
  const targets: readonly string[] = ATTACH_CARRIERS.targets
  const plan = planMaterialize(root, [...ATTACH_CARRIERS.groups], carrierVars(root, harnessCommand), { emptyTarget: false, ai: 'claude' })
  const ops = targets.flatMap(target => plan.ops.filter(op => op.target === target))
  const missing = targets.filter(target => !ops.some(op => op.target === target))
  if (missing.length > 0)
    throw new Error(`attach carriers missing from the plan: ${missing.join(', ')}`)
  return ops
}

function ancestors(target: string): string[] {
  const segments = target.split('/').slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

export function directoriesToCreate(root: string, targets: string[]): string[] {
  const created: string[] = []
  for (const target of targets) {
    for (const dir of ancestors(target)) {
      if (!created.includes(dir) && !existsSync(path.join(root, dir)))
        created.push(dir)
    }
  }
  return created
}
