export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none'
export type Layout = 'empty' | 'single' | 'monorepo' | 'unknown'
export type MonorepoTool = 'pnpm-workspace' | 'npm-workspaces' | 'turbo' | 'nx'

export interface ExistingFiles {
  packageJson: boolean
  tsconfig: boolean
  eslintConfig: boolean
  githubWorkflows: boolean
  claudeMd: boolean
  agentsMd: boolean
  cursorRules: boolean
  openapi: string | null
  constructJson: boolean
}

export interface WorkspacePackage {
  dir: string
  name: string
}

export interface DetectReport {
  dir: string
  packageManager: PackageManager
  pnpmVersion: string | null
  layout: Layout
  monorepoTools: MonorepoTool[]
  workspaceDirs: string[]
  workspacePackages: WorkspacePackage[]
  hasSrc: boolean
  nodeMajor: number
  existing: ExistingFiles
}
