import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const KNOWN_CALLERS = 'scripts/core/gh-callers.known.json'
export const GH_PORT = 'scripts/core/gh.ts'
export const GH_CALLER_SCAN = 'scripts/core/gh-callers.ts'

const SCANNED_ROOT = 'scripts'
const UNSCANNED = 'scripts/tests/'
const SPAWNING_MODULES = new Set(['node:child_process', 'child_process'])
const SHELL_SPAWNS = new Set(['exec', 'execSync'])
const GH_COMMAND = 'gh'
const GH_SHELL_LINE = /^gh\s/
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.mjs', '.js']

function sourceOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function isText(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function leadingText(node: ts.Node): string | null {
  if (isText(node))
    return node.text
  return ts.isTemplateExpression(node) ? node.head.text : null
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression))
    return call.expression.text
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null
}

function relativeImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.(m?js)$/, '.ts')
}

function ghConstants(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement))
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && isText(declaration.initializer) && declaration.initializer.text === GH_COMMAND)
        names.add(declaration.name.text)
    }
  }
  return names
}

function importedGhNames(file: string, source: ts.SourceFile, constants: ReadonlyMap<string, Set<string>>): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const target = relativeImport(file, statement.moduleSpecifier.text)
    const exported = target === null ? undefined : constants.get(target)
    const bindings = statement.importClause?.namedBindings
    if (exported === undefined || bindings === undefined || !ts.isNamedImports(bindings))
      continue
    for (const element of bindings.elements) {
      if (exported.has((element.propertyName ?? element.name).text))
        names.add(element.name.text)
    }
  }
  return names
}

class CallerScan {
  namesSpawnModule = false
  namesGh = false
  callsGh = false

  constructor(private readonly ghNames: Set<string>) {}

  private isGh(node: ts.Node): boolean {
    return (isText(node) && node.text === GH_COMMAND) || (ts.isIdentifier(node) && this.ghNames.has(node.text))
  }

  visit(node: ts.Node): void {
    if (isText(node) && SPAWNING_MODULES.has(node.text))
      this.namesSpawnModule = true
    if (this.isGh(node) && !(ts.isIdentifier(node) && ts.isImportSpecifier(node.parent)))
      this.namesGh = true
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0]!
      const shellLine = leadingText(first)
      if (this.isGh(first) || (SHELL_SPAWNS.has(calleeName(node) ?? '') && shellLine !== null && GH_SHELL_LINE.test(shellLine)))
        this.callsGh = true
    }
    ts.forEachChild(node, child => this.visit(child))
  }

  get spawnsGh(): boolean {
    return this.callsGh || (this.namesSpawnModule && this.namesGh)
  }
}

export function ghCallers(sources: ReadonlyMap<string, string>): string[] {
  const parsed = new Map([...sources].map(([file, text]) => [file, sourceOf(file, text)] as const))
  const constants = new Map([...parsed].map(([file, source]) => [file, ghConstants(source)] as const))
  return [...parsed].filter(([file, source]) => {
    if (file === GH_PORT || file === GH_CALLER_SCAN)
      return false
    const scan = new CallerScan(importedGhNames(file, source, constants))
    scan.visit(source)
    return scan.spawnsGh
  }).map(([file]) => file).sort()
}

export function spawnsGh(file: string, text: string): boolean {
  return ghCallers(new Map([[file, text]])).includes(file)
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
