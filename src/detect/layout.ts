import type { Layout, MonorepoTool, WorkspacePackage } from './report.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const IGNORED_ENTRIES = new Set(['.git', '.DS_Store', '.gitignore', '.gitattributes', 'LICENSE', 'README.md', '.idea', '.vscode'])

export function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir))
    return true
  return readdirSync(dir).every(entry => IGNORED_ENTRIES.has(entry))
}

function hasWorkspacesField(dir: string): boolean {
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest))
    return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown }
    return parsed.workspaces != null
  }
  catch {
    return false
  }
}

export function detectMonorepoTools(dir: string): MonorepoTool[] {
  const tools: MonorepoTool[] = []
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml')))
    tools.push('pnpm-workspace')
  if (hasWorkspacesField(dir))
    tools.push('npm-workspaces')
  if (existsSync(path.join(dir, 'turbo.json')))
    tools.push('turbo')
  if (existsSync(path.join(dir, 'nx.json')))
    tools.push('nx')
  return tools
}

export function detectWorkspaceDirs(dir: string): string[] {
  return ['apps', 'packages', 'libs', 'services']
    .filter(name => existsSync(path.join(dir, name)) && statSync(path.join(dir, name)).isDirectory())
}

function packageName(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null
  }
  catch {
    return null
  }
}

export function detectWorkspacePackages(root: string, workspaceDirs: string[]): WorkspacePackage[] {
  return workspaceDirs.flatMap(parent =>
    readdirSync(path.join(root, parent))
      .sort()
      .map(entry => `${parent}/${entry}`)
      .filter(dir => existsSync(path.join(root, dir, 'package.json')))
      .map(dir => ({ dir, name: packageName(path.join(root, dir)) ?? dir.split('/').at(-1) ?? dir })))
}

export function detectLayout(dir: string, monorepoTools: MonorepoTool[], workspaceDirs: string[], hasSrc: boolean): Layout {
  if (isEmptyDir(dir))
    return 'empty'
  if (monorepoTools.length > 0 || workspaceDirs.length > 0)
    return 'monorepo'
  if (hasSrc || existsSync(path.join(dir, 'package.json')))
    return 'single'
  return 'unknown'
}
