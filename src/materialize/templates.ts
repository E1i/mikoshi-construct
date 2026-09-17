import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function templatesRoot(): string {
  const candidates = [path.resolve(HERE, '../templates'), path.resolve(HERE, '../../templates')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found == null)
    throw new Error(`templates directory not found next to ${HERE}`)
  return found
}

export type TemplateVariant = 'default' | 'existing'

export interface TemplateFile {
  group: string
  source: string
  target: string
  rendered: boolean
  variant: TemplateVariant
}

const EXISTING_SUFFIX = '.existing.eta'

function toTargetPath(relative: string): Pick<TemplateFile, 'target' | 'rendered' | 'variant'> {
  const segments = relative.split(path.sep).map(segment => (segment.startsWith('_') ? `.${segment.slice(1)}` : segment))
  const joined = segments.join('/')
  if (joined.endsWith(EXISTING_SUFFIX))
    return { target: joined.slice(0, -EXISTING_SUFFIX.length), rendered: true, variant: 'existing' }
  return joined.endsWith('.eta')
    ? { target: joined.slice(0, -'.eta'.length), rendered: true, variant: 'default' }
    : { target: joined, rendered: false, variant: 'default' }
}

function walk(root: string, current: string, files: string[]): void {
  for (const entry of readdirSync(current).sort()) {
    const absolute = path.join(current, entry)
    if (statSync(absolute).isDirectory())
      walk(root, absolute, files)
    else if (entry !== '.DS_Store')
      files.push(path.relative(root, absolute))
  }
}

export function listTemplateFiles(group: string): TemplateFile[] {
  const root = path.join(templatesRoot(), group)
  if (!existsSync(root))
    throw new Error(`template group "${group}" does not exist`)
  const files: string[] = []
  walk(root, root, files)
  return files.map((relative) => {
    const { target, rendered, variant } = toTargetPath(relative)
    return { group, source: path.join(root, relative), target, rendered, variant }
  })
}

const BLOCK = /^[ \t]*\{\{#(if|unless) (\w+)\}\}[ \t]*\n([\s\S]*?)^[ \t]*\{\{\/\1\}\}[ \t]*\n/gm
const VARIABLE = /\{\{\s*(\w+)\s*\}\}/g

function lookup(vars: Record<string, string>, name: string, match: string): string {
  const value = vars[name]
  if (value == null)
    throw new Error(`template variable "${name}" is not defined (${match})`)
  return value
}

function isTruthy(value: string): boolean {
  return value !== '' && value !== 'false'
}

export function render(template: string, vars: Record<string, string>): string {
  const expanded = template.replaceAll(BLOCK, (match, kind: string, name: string, body: string) =>
    (isTruthy(lookup(vars, name, match)) === (kind === 'if') ? body : ''))
  return expanded.replaceAll(VARIABLE, (match, name: string) => lookup(vars, name, match))
}
