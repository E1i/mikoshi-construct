import type { Tree } from './tree.js'
import path from 'node:path'
import { isParseable, moduleSpecifiers, parse } from './syntax.js'

const CONFIG_EXTENSIONS = ['.json', '.yaml', '.yml', '.workflow']
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']
const TEST_SEGMENTS = ['tests', '__tests__', 'e2e', 'fixtures']
const TEST_BASENAME = /\.(?:test|spec)\./

export function isTestPath(file: string): boolean {
  const segments = file.split('/')
  return segments.slice(0, -1).some(segment => TEST_SEGMENTS.includes(segment)) || TEST_BASENAME.test(segments.at(-1)!)
}

export function isSource(file: string): boolean {
  return isParseable(file) && !isTestPath(file)
}

export function isCodeOrConfig(file: string): boolean {
  return isParseable(file) || CONFIG_EXTENSIONS.includes(path.extname(file))
}

export function isReadExtension(file: string): boolean {
  return isCodeOrConfig(file) || (file.startsWith('.claude/') && file.endsWith('.md'))
}

function withoutExtension(file: string): string {
  const extension = path.posix.extname(file)
  return MODULE_EXTENSIONS.includes(extension) ? file.slice(0, -extension.length) : file
}

function importedPaths(file: string, text: string): string[] {
  if (!isParseable(file))
    return []
  return moduleSpecifiers(parse(file, text))
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => withoutExtension(path.posix.join(path.posix.dirname(file), specifier)))
}

export function reaches(file: string, text: string, target: string): boolean {
  if (text.includes(target))
    return true
  const stem = withoutExtension(target)
  const indexed = path.posix.basename(stem) === 'index' ? path.posix.dirname(stem) : undefined
  return importedPaths(file, text).some(imported => imported === stem || imported === indexed)
}

export function unreachedFiles(tree: Tree, files: Iterable<string>): string[] {
  const reachers = [...tree.files].filter(file => !isTestPath(file) && (isCodeOrConfig(file) || (file.startsWith('.claude/') && file.endsWith('.md'))))
  return [...new Set(files)].filter(target => !reachers.some(file => file !== target && reaches(file, tree.read(file), target))).sort()
}

export function nameAppearsElsewhere(tree: Tree, declaringFile: string, name: string, nameStart: number): boolean {
  const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')
  return [...tree.files]
    .filter(file => !isTestPath(file) && isCodeOrConfig(file))
    .some(file => [...tree.read(file).matchAll(word)].some(match => file !== declaringFile || match.index !== nameStart))
}
