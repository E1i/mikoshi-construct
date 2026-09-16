import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const TOP_LEVEL_PACKAGES_KEY = /^packages:(.*)$/m
const EMPTY_FLOW_SEQUENCE = /^\[\s*\]$/
const BLOCK_SEQUENCE_ENTRY = /^[ \t]+-[ \t]*\S/

function readIfPresent(file: string): string | null {
  if (!existsSync(file))
    return null
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

function startsBlockSequence(rest: string): boolean {
  for (const line of rest.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#'))
      continue
    return BLOCK_SEQUENCE_ENTRY.test(line)
  }
  return false
}

export function declaresPnpmPackages(dir: string): boolean {
  const content = readIfPresent(path.join(dir, 'pnpm-workspace.yaml'))
  if (content == null)
    return false
  const match = TOP_LEVEL_PACKAGES_KEY.exec(content)
  if (match == null)
    return false
  const inline = match[1].trim()
  if (inline.startsWith('['))
    return !EMPTY_FLOW_SEQUENCE.test(inline)
  if (inline !== '')
    return false
  return startsBlockSequence(content.slice(match.index + match[0].length))
}

export function declaresNpmWorkspaces(dir: string): boolean {
  const content = readIfPresent(path.join(dir, 'package.json'))
  if (content == null)
    return false
  let workspaces: unknown
  try {
    ({ workspaces } = JSON.parse(content) as { workspaces?: unknown })
  }
  catch {
    return false
  }
  if (Array.isArray(workspaces))
    return workspaces.length > 0
  const packages = (workspaces as { packages?: unknown } | null)?.packages
  return Array.isArray(packages) && packages.length > 0
}
