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

export interface TemplateFile {
  group: string
  source: string
  target: string
  rendered: boolean
}

function toTargetPath(relative: string): { target: string, rendered: boolean } {
  const segments = relative.split(path.sep).map(segment => (segment.startsWith('_') ? `.${segment.slice(1)}` : segment))
  const joined = segments.join('/')
  return joined.endsWith('.eta')
    ? { target: joined.slice(0, -'.eta'.length), rendered: true }
    : { target: joined, rendered: false }
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
    const { target, rendered } = toTargetPath(relative)
    return { group, source: path.join(root, relative), target, rendered }
  })
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name]
    if (value == null)
      throw new Error(`template variable "${name}" is not defined (${match})`)
    return value
  })
}
