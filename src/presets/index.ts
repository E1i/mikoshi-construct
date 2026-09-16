import type { DetectReport } from '../detect/index.js'

export type PresetId = 'node-backend' | 'node-frontend' | 'monorepo'
export type AiTarget = 'claude' | 'cursor' | 'both'

export interface TemplateVars extends Record<string, string> {
  projectName: string
  scope: string
  nodeMajor: string
  contractPath: string
  contractTypesOutput: string
  harnessCommand: string
  packageManager: string
  constructVersion: string
}

export interface Preset {
  id: PresetId
  label: string
  description: string
  groups: string[]
  contracts: boolean
  available: boolean
  vars: (report: DetectReport, projectName: string) => Partial<TemplateVars>
}

const PRESETS: Record<PresetId, Preset> = {
  'node-backend': {
    id: 'node-backend',
    label: 'Node.js backend',
    description: 'Express + TypeScript, contract-first HTTP API, composition root, harness',
    groups: ['base', 'harness', 'presets/node-backend'],
    contracts: true,
    available: true,
    vars: () => ({
      contractPath: 'contracts/api/openapi.yaml',
      contractTypesOutput: 'src/contracts/openapi.ts',
    }),
  },
  'node-frontend': {
    id: 'node-frontend',
    label: 'Node.js frontend',
    description: 'Vite + TypeScript, CSS rules, harness (v0.1: day 2)',
    groups: ['base', 'harness', 'presets/node-frontend'],
    contracts: false,
    available: false,
    vars: () => ({}),
  },
  'monorepo': {
    id: 'monorepo',
    label: 'pnpm monorepo',
    description: 'apps/* + packages/*, catalog:, dependency policy in lint (v0.1: day 2)',
    groups: ['base', 'harness', 'presets/monorepo'],
    contracts: true,
    available: false,
    vars: () => ({
      contractPath: 'contracts/api/openapi.yaml',
      contractTypesOutput: 'packages/shared/src/api/openapi.ts',
    }),
  },
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]

export function isPresetId(value: string): value is PresetId {
  return value in PRESETS
}

export function getPreset(id: PresetId): Preset {
  return PRESETS[id]
}

export function aiGroups(target: AiTarget): string[] {
  return target === 'both' ? ['ai/shared', 'ai/claude', 'ai/cursor'] : ['ai/shared', `ai/${target}`]
}

export function defaultProjectName(dir: string): string {
  const base = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project'
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}
