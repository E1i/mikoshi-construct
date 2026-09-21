import type { DetectReport } from '../detect/index.js'

export type PresetId = 'node-backend' | 'node-frontend' | 'node-library' | 'monorepo'
export type AiTarget = 'claude' | 'cursor' | 'both'

export const AI_TARGET_LABELS: Record<AiTarget, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  both: 'Claude Code, Cursor',
}

export interface TemplateVars extends Record<string, string> {
  projectName: string
  scope: string
  nodeMajor: string
  contracts: string
  contractPath: string
  contractTypesOutput: string
  compositionDir: string
  harnessCommand: string
  packageManager: string
  pnpmVersion: string
  reviewModel: string
  constructVersion: string
}

export interface TemplateMount {
  group: string
  into?: string
  onlyWhenEmpty?: boolean
}

export type TemplateGroup = string | TemplateMount

export interface Preset {
  id: PresetId
  label: string
  description: string
  groups: TemplateGroup[]
  contracts: boolean
  available: boolean
  vars: (report: DetectReport, projectName: string) => Partial<TemplateVars>
}

const EXPRESS_APP = 'stacks/express-api/app'
const EXPRESS_REPO = 'stacks/express-api/repo'
const HTTP_CONTRACT = 'stacks/http-contract'

interface WorkspacePackage {
  dir: string
  name: string
}

function sampleWorkspace(scope: string): WorkspacePackage[] {
  return [
    { dir: 'packages/shared', name: `${scope}/shared` },
    { dir: 'apps/api', name: `${scope}/api` },
  ]
}

function quote(value: string): string {
  return `'${value}'`
}

export function renderWorkspacePolicy(packages: WorkspacePackage[], sample: boolean): { workspacePackages: string, allowedWorkspaceImports: string } {
  const names = packages.map(pkg => pkg.name)
  const allowedFor = (pkg: WorkspacePackage): string[] => {
    if (sample)
      return pkg.dir.startsWith('apps/') ? names.filter(name => name !== pkg.name) : []
    return names.filter(name => name !== pkg.name)
  }
  const lines = packages.map(pkg => `  ${quote(pkg.dir)}: [${allowedFor(pkg).map(quote).join(', ')}],`)
  return {
    workspacePackages: `[${names.map(quote).join(', ')}]`,
    allowedWorkspaceImports: `{\n${lines.join('\n')}\n}`,
  }
}

const PRESETS: Record<PresetId, Preset> = {
  'node-backend': {
    id: 'node-backend',
    label: 'Node.js backend',
    description: 'Express + TypeScript, contract-first HTTP API, composition root, harness',
    groups: [
      'base',
      'harness',
      HTTP_CONTRACT,
      { group: EXPRESS_APP, onlyWhenEmpty: true },
      { group: EXPRESS_REPO, onlyWhenEmpty: true },
      { group: 'presets/node-backend/sample', onlyWhenEmpty: true },
      'presets/node-backend/baseline',
    ],
    contracts: true,
    available: true,
    vars: () => ({
      contractPath: 'contracts/api/openapi.yaml',
      contractTypesOutput: 'src/contracts/openapi.ts',
      contractTypesImport: './openapi.js',
      contractPathFromConfig: '../contracts/api/openapi.yaml',
      appRoot: '',
    }),
  },
  'node-frontend': {
    id: 'node-frontend',
    label: 'Node.js frontend',
    description: 'Vite + TypeScript, platform CSS rules, composition root, harness; no API contract',
    groups: [
      'base',
      'harness',
      { group: 'presets/node-frontend/sample', onlyWhenEmpty: true },
      'presets/node-frontend/baseline',
    ],
    contracts: false,
    available: true,
    vars: () => ({
      contractPath: '',
      contractTypesOutput: '',
    }),
  },
  'node-library': {
    id: 'node-library',
    label: 'Node.js library or CLI',
    description: 'TypeScript package with no HTTP contract: architecture policy, composition models, harness',
    groups: ['base', 'harness'],
    contracts: false,
    available: true,
    vars: () => ({
      contractPath: '',
      contractTypesOutput: '',
    }),
  },
  'monorepo': {
    id: 'monorepo',
    label: 'pnpm monorepo',
    description: 'apps/* + packages/*, catalog:, contract types in packages/shared, dependency policy in lint',
    groups: [
      'base',
      'harness',
      HTTP_CONTRACT,
      { group: EXPRESS_APP, into: 'apps/api', onlyWhenEmpty: true },
      { group: EXPRESS_REPO, onlyWhenEmpty: true },
      { group: 'presets/monorepo/sample', onlyWhenEmpty: true },
      'presets/monorepo/baseline',
    ],
    contracts: true,
    available: true,
    vars: (report, projectName) => {
      const detected = report.workspacePackages
      const packages = detected.length > 0 ? detected : sampleWorkspace(`@${projectName}`)
      return {
        contractPath: 'contracts/api/openapi.yaml',
        contractTypesOutput: 'packages/shared/src/api/openapi.ts',
        contractTypesImport: `@${projectName}/shared`,
        contractPathFromConfig: '../../../contracts/api/openapi.yaml',
        appRoot: 'apps/api/',
        ...renderWorkspacePolicy(packages, detected.length === 0),
      }
    },
  },
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]
export const PRESET_LIST = Object.values(PRESETS)

export function isPresetId(value: string): value is PresetId {
  return value in PRESETS
}

export function getPreset(id: PresetId): Preset {
  return PRESETS[id]
}

export function sampleMounts(preset: Preset): TemplateGroup[] {
  return preset.groups.filter(group => (typeof group === 'string' ? group : group.group).endsWith('/sample'))
}

export function sampleGroups(preset: Preset): string[] {
  return sampleMounts(preset).map(group => (typeof group === 'string' ? group : group.group))
}

export function groupsFor(preset: Preset, ai: AiTarget, review: ReviewProvider): TemplateGroup[] {
  return [...preset.groups, ...aiGroups(ai), ...reviewGroups(review)]
}

export function aiGroups(target: AiTarget): string[] {
  return target === 'both' ? ['ai/shared', 'ai/claude', 'ai/cursor'] : ['ai/shared', `ai/${target}`]
}

export type ReviewProvider = 'claude' | 'none'

export const DEFAULT_REVIEW_MODEL = 'claude-sonnet-5'

export function reviewGroups(provider: ReviewProvider): string[] {
  return provider === 'claude' ? ['ai/review'] : []
}

export function defaultProjectName(dir: string): string {
  const base = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project'
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}
