import type { ReadFile, SpecifierTargets } from './specifiers.js'
import path from 'node:path'
import { parseJsonc } from './jsonc.js'
import { isRecord, strings } from './specifiers.js'

export interface WorkspacePackage {
  name: string
  directory: string
  manifest: Record<string, unknown>
}

const PACKAGE_MANIFEST = 'package.json'
const PNPM_WORKSPACE = 'pnpm-workspace.yaml'
const PACKAGES_KEY = /^packages\s*:(.*)$/
const LIST_ITEM = /^\s+-\s*(\S.*)$/
const SKIPPED_LINE = /^\s*(?:#|$)/
const TRAILING_YAML_COMMENT = /\s+#.*$/

function unquote(value: string): string {
  const trimmed = value.trim()
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

export function pnpmWorkspacePatterns(text: string): string[] {
  const lines = text.split('\n').map(line => line.replace(TRAILING_YAML_COMMENT, ''))
  const start = lines.findIndex(line => PACKAGES_KEY.test(line))
  if (start === -1)
    return []
  const inline = PACKAGES_KEY.exec(lines[start])?.[1].trim() ?? ''
  if (inline.startsWith('['))
    return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(pattern => pattern !== '')
  const patterns: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (SKIPPED_LINE.test(line))
      continue
    const item = LIST_ITEM.exec(line)
    if (item == null)
      break
    patterns.push(unquote(item[1]))
  }
  return patterns
}

function manifestPatterns(manifest: unknown): string[] {
  if (!isRecord(manifest))
    return []
  const workspaces = manifest.workspaces
  return isRecord(workspaces) ? strings(workspaces.packages) : strings(workspaces)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

export function globMatcher(glob: string): RegExp {
  const segments = glob.replace(/^\.\//, '').replace(/\/+$/, '').split('/')
  const source = segments.map(segment => segment === '**' ? '.*' : segment.split('*').map(escapeRegExp).join('[^/]*')).join('/')
  return new RegExp(`^${source}$`)
}

export function workspacePackages(tracked: string[], read: ReadFile): WorkspacePackage[] {
  const patterns = [...pnpmWorkspacePatterns(read(PNPM_WORKSPACE) ?? ''), ...manifestPatterns(parseJsonc(read(PACKAGE_MANIFEST) ?? ''))]
  const included = patterns.filter(pattern => !pattern.startsWith('!')).map(globMatcher)
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => globMatcher(pattern.slice(1)))
  const packages: WorkspacePackage[] = []
  for (const file of tracked) {
    if (!file.endsWith(`/${PACKAGE_MANIFEST}`))
      continue
    const directory = path.posix.dirname(file)
    if (!included.some(matcher => matcher.test(directory)) || excluded.some(matcher => matcher.test(directory)))
      continue
    const manifest = parseJsonc(read(file) ?? '')
    if (isRecord(manifest) && typeof manifest.name === 'string')
      packages.push({ name: manifest.name, directory, manifest })
  }
  return packages
}

export function leaves(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]
  if (Array.isArray(value))
    return value.flatMap(leaves)
  return isRecord(value) ? Object.values(value).flatMap(leaves) : []
}

function exportTargets(exports: unknown, subpath: string): string[] {
  const isSubpathMap = isRecord(exports) && Object.keys(exports).some(key => key.startsWith('.'))
  if (isSubpathMap)
    return leaves(exports[subpath])
  return subpath === '.' ? leaves(exports) : []
}

function packageTargets(workspace: WorkspacePackage, subpath: string): string[] {
  const { manifest } = workspace
  const entries = subpath === '.'
    ? [...exportTargets(manifest.exports, '.'), ...[manifest.module, manifest.main].filter((entry): entry is string => typeof entry === 'string'), '.']
    : [...exportTargets(manifest.exports, subpath), subpath]
  return entries.map(entry => path.posix.normalize(path.posix.join(workspace.directory, entry)))
}

export function readWorkspaces(tracked: string[], read: ReadFile): SpecifierTargets {
  const packages = workspacePackages(tracked, read).sort((left, right) => right.name.length - left.name.length)
  return (_from, specifier) => {
    const workspace = packages.find(candidate => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`))
    return workspace === undefined ? null : packageTargets(workspace, `.${specifier.slice(workspace.name.length)}`)
  }
}
