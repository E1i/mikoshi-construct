import type { DetectReport } from './report.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { DEFAULT_COMPOSITION_DIR, detectExisting } from './existing.js'
import { detectLayout, detectMonorepoTools, detectWorkspaceDirs, detectWorkspacePackages } from './layout.js'
import { detectPackageManager, detectPnpmVersion } from './package-manager.js'

export { DEFAULT_COMPOSITION_DIR }
export type { DetectReport, ExistingFiles, Layout, MonorepoTool, PackageManager, WorkspacePackage } from './report.js'

export function detect(dir: string): DetectReport {
  const root = path.resolve(dir)
  const monorepoTools = detectMonorepoTools(root)
  const workspaceDirs = detectWorkspaceDirs(root)
  const hasSrc = existsSync(path.join(root, 'src'))
  return {
    dir: root,
    packageManager: detectPackageManager(root),
    pnpmVersion: detectPnpmVersion(),
    layout: detectLayout(root, monorepoTools, workspaceDirs, hasSrc),
    monorepoTools,
    workspaceDirs,
    workspacePackages: detectWorkspacePackages(root, workspaceDirs),
    hasSrc,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    existing: detectExisting(root),
  }
}
