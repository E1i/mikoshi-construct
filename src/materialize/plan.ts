import type { TemplateVars } from '../presets/index.js'
import type { Strategy } from './strategies.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { appendBlock, mergeJson, strategyFor } from './strategies.js'
import { listTemplateFiles, render } from './templates.js'

export type FileAction = 'create' | 'merge' | 'append' | 'skip'

export interface FileOp {
  target: string
  strategy: Strategy
  action: FileAction
  content: string
  note?: string
}

export interface MaterializePlan {
  ops: FileOp[]
  conflicts: string[]
}

function readTemplate(source: string, rendered: boolean, vars: TemplateVars): string {
  const raw = readFileSync(source, 'utf8')
  return rendered ? render(raw, vars) : raw
}

const SORTED_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function sortSections(manifest: Record<string, unknown>): Record<string, unknown> {
  const result = { ...manifest }
  for (const section of SORTED_SECTIONS) {
    const value = result[section]
    if (typeof value === 'object' && value != null && !Array.isArray(value))
      result[section] = Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }
  return result
}

function layerJson(earlier: string, later: string): string {
  const base = JSON.parse(earlier) as Record<string, unknown>
  const override = JSON.parse(later) as Record<string, unknown>
  return `${JSON.stringify(sortSections(mergeJson(override, base, [])), null, 2)}\n`
}

function planOne(root: string, target: string, content: string, conflicts: string[]): FileOp {
  const strategy = strategyFor(target)
  const absolute = path.join(root, target)
  const exists = existsSync(absolute)

  if (!exists)
    return { target, strategy, action: 'create', content: strategy === 'append-block' ? appendBlock('', content, target) : content }

  if (strategy === 'merge-json') {
    const existing = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
    const incoming = JSON.parse(content) as Record<string, unknown>
    const localConflicts: string[] = []
    const merged = mergeJson(existing, incoming, localConflicts)
    conflicts.push(...localConflicts.map(key => `${target}: ${key}`))
    return { target, strategy, action: 'merge', content: `${JSON.stringify(sortSections(merged), null, 2)}\n` }
  }

  if (strategy === 'append-block') {
    const existing = readFileSync(absolute, 'utf8')
    return { target, strategy, action: 'append', content: appendBlock(existing, content, target) }
  }

  return { target, strategy, action: 'skip', content, note: 'exists, review manually' }
}

export function planMaterialize(root: string, groups: string[], vars: TemplateVars): MaterializePlan {
  const conflicts: string[] = []
  const byTarget = new Map<string, FileOp>()
  for (const group of groups) {
    for (const file of listTemplateFiles(group)) {
      const content = readTemplate(file.source, file.rendered, vars)
      const previous = byTarget.get(file.target)
      const layered = previous == null || previous.strategy !== 'merge-json'
        ? content
        : layerJson(previous.content, content)
      byTarget.set(file.target, planOne(root, file.target, layered, conflicts))
    }
  }
  return { ops: [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target)), conflicts }
}
