import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const KNOWN_CALLERS = 'scripts/core/gh-callers.known.json'
export const GH_PORT = 'scripts/core/gh.ts'

const SCANNED_ROOT = 'scripts'
const UNSCANNED = 'scripts/tests/'
const SPAWNING_MODULES = new Set(['node:child_process', 'child_process'])
const GH_COMMAND = 'gh'
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.mjs', '.js']

function importsSpawn(source: ts.SourceFile): boolean {
  return source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && SPAWNING_MODULES.has(statement.moduleSpecifier.text))
}

function namesGh(source: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === GH_COMMAND)
      found = true
    if (!found)
      ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

export function spawnsGh(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return importsSpawn(source) && namesGh(source)
}

export function ghCallers(sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([file, text]) => file !== GH_PORT && spawnsGh(file, text)).map(([file]) => file).sort()
}

function scriptsUnder(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
      return `${relative}/` === UNSCANNED ? [] : scriptsUnder(root, relative)
    return SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension)) && !entry.name.endsWith('.d.ts') ? [relative] : []
  })
}

export function repositoryScripts(root: string): Map<string, string> {
  return new Map(scriptsUnder(root, SCANNED_ROOT).map(file => [file, readFileSync(path.join(root, file), 'utf8')]))
}

export function knownCallers(root: string): string[] {
  return JSON.parse(readFileSync(path.join(root, KNOWN_CALLERS), 'utf8')) as string[]
}

export function unrecordedCallers(found: string[], known: string[]): string[] {
  return found.filter(file => !known.includes(file))
}

export function staleCallers(found: string[], known: string[]): string[] {
  return unrecordedCallers(known, found)
}
