import type { AiTarget, TemplateGroup, TemplateMount, TemplateVars } from '../presets/index.js'
import type { Strategy } from './strategies.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { mapRulesForTargets } from './rules.js'
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
  omittedGroups: string[]
}

function toMount(group: TemplateGroup): TemplateMount {
  return typeof group === 'string' ? { group } : group
}

function mountTarget(mount: TemplateMount, target: string): string {
  return mount.into == null || mount.into === '.' ? target : `${mount.into.replace(/\/$/, '')}/${target}`
}

function readTemplate(source: string, rendered: boolean, vars: TemplateVars): string {
  const raw = readFileSync(source, 'utf8')
  return rendered ? render(raw, vars) : raw
}

const SORTED_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const MANIFEST_KEY_ORDER = [
  'name',
  'type',
  'version',
  'private',
  'packageManager',
  'description',
  'author',
  'license',
  'homepage',
  'repository',
  'bugs',
  'keywords',
  'sideEffects',
  'exports',
  'main',
  'module',
  'types',
  'bin',
  'files',
  'engines',
  'scripts',
  'peerDependencies',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'pnpm',
  'overrides',
]

function sortSections(manifest: Record<string, unknown>): Record<string, unknown> {
  const result = { ...manifest }
  for (const section of SORTED_SECTIONS) {
    const value = result[section]
    if (typeof value === 'object' && value != null && !Array.isArray(value))
      result[section] = Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }
  return result
}

function orderManifestKeys(manifest: Record<string, unknown>): Record<string, unknown> {
  const rank = (key: string): number => {
    const index = MANIFEST_KEY_ORDER.indexOf(key)
    return index === -1 ? MANIFEST_KEY_ORDER.length : index
  }
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => rank(a) - rank(b)))
}

function layerJson(earlier: string, later: string): string {
  const base = JSON.parse(earlier) as Record<string, unknown>
  const override = JSON.parse(later) as Record<string, unknown>
  return `${JSON.stringify(orderManifestKeys(sortSections(mergeJson(override, base, []))), null, 2)}\n`
}

const NOT_ADDED_TO_EXISTING_MANIFEST = ['version']

function planOne(root: string, target: string, content: string, conflicts: string[], existingVariant?: string): FileOp {
  const strategy = strategyFor(target)
  const absolute = path.join(root, target)
  const exists = existsSync(absolute)

  if (!exists)
    return { target, strategy, action: 'create', content: strategy === 'append-block' ? appendBlock('', content, target) : content }

  if (strategy === 'merge-json') {
    const existing = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
    const incoming = JSON.parse(content) as Record<string, unknown>
    for (const key of NOT_ADDED_TO_EXISTING_MANIFEST)
      delete incoming[key]
    const localConflicts: string[] = []
    const merged = mergeJson(existing, incoming, localConflicts)
    conflicts.push(...localConflicts.map(key => `${target}: ${key}`))
    return { target, strategy, action: 'merge', content: `${JSON.stringify(orderManifestKeys(sortSections(merged)), null, 2)}\n` }
  }

  if (strategy === 'append-block') {
    const existing = readFileSync(absolute, 'utf8')
    return { target, strategy, action: 'append', content: appendBlock(existing, existingVariant ?? content, target) }
  }

  return { target, strategy, action: 'skip', content, note: 'exists, review manually' }
}

export interface PlanOptions {
  emptyTarget: boolean
  ai: AiTarget
}

export function planMaterialize(root: string, groups: TemplateGroup[], vars: TemplateVars, options: PlanOptions): MaterializePlan {
  const conflicts: string[] = []
  const omittedGroups: string[] = []
  const layered = new Map<string, string>()
  const existingVariants = new Map<string, string>()
  for (const mount of groups.map(toMount)) {
    if (mount.onlyWhenEmpty === true && !options.emptyTarget) {
      omittedGroups.push(mount.group)
      continue
    }
    for (const file of listTemplateFiles(mount.group)) {
      const target = mountTarget(mount, file.target)
      const content = readTemplate(file.source, file.rendered, vars)
      if (file.variant === 'existing') {
        existingVariants.set(target, content)
        continue
      }
      const previous = layered.get(target)
      layered.set(target, previous == null || strategyFor(target) !== 'merge-json' ? content : layerJson(previous, content))
    }
  }
  const ops = [...mapRulesForTargets(layered, options.ai).entries()]
    .map(([target, content]) => planOne(root, target, content, conflicts, existingVariants.get(target)))
    .sort((a, b) => a.target.localeCompare(b.target))
  return { ops, conflicts, omittedGroups }
}
