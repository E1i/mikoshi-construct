import type { DetectReport } from './report.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { detectExisting } from './existing.js'
import { detectLayout, detectMonorepoTools, detectWorkspaceDirs } from './layout.js'
import { detectPackageManager } from './package-manager.js'

export type { DetectReport, ExistingFiles, Layout, MonorepoTool, PackageManager } from './report.js'

export function detect(dir: string): DetectReport {
  const root = path.resolve(dir)
  const monorepoTools = detectMonorepoTools(root)
  const workspaceDirs = detectWorkspaceDirs(root)
  const hasSrc = existsSync(path.join(root, 'src'))
  return {
    dir: root,
    packageManager: detectPackageManager(root),
    layout: detectLayout(root, monorepoTools, workspaceDirs, hasSrc),
    monorepoTools,
    workspaceDirs,
    hasSrc,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    existing: detectExisting(root),
  }
}
