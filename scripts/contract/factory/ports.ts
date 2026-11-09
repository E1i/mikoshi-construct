import type { ParsedFile } from './walk.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { FACTORY_FOLDERS } from '../../core/factory-paths.js'
import { parsedFiles } from './walk.js'

export interface PortModule {
  functions: Record<string, string>
  types: Record<string, string>
  constants: string[]
  reexports: string[]
}

export interface PortsSection {
  portsVersion: number
  modules: Record<string, PortModule>
  boundary: Record<string, PortModule>
}

export type ImportedNames = ReadonlyMap<string, ReadonlySet<string>>

export const PORTS_VERSION = 3

const PRODUCT_TREE = 'src'
const FACTORY_TREE = 'scripts'
const SOURCE_SUFFIX = /\.js$/

const PORTS_TREE = FACTORY_FOLDERS.sharedCode.find(folder => folder.endsWith('/ports'))!
const DEFAULT_EXPORT = 'default'
const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true })

function printed(node: ts.Node, source: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, ' ').trim()
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false)
}

function signatureOf(node: ts.SignatureDeclaration, source: ts.SourceFile): string {
  const generics = node.typeParameters === undefined ? '' : `<${node.typeParameters.map(parameter => printed(parameter, source)).join(', ')}>`
  const parameters = node.parameters.map(parameter => printed(parameter, source)).join(', ')
  const returned = node.type === undefined ? '' : `: ${printed(node.type, source)}`
  return `${generics}(${parameters})${returned}`
}

function isPublicMember(member: ts.ClassElement): boolean {
  return !hasModifier(member, ts.SyntaxKind.PrivateKeyword)
    && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
    && !(member.name !== undefined && ts.isPrivateIdentifier(member.name))
}

function memberText(member: ts.ClassElement, source: ts.SourceFile): string[] {
  if (!isPublicMember(member))
    return []
  if (ts.isConstructorDeclaration(member))
    return [`constructor${signatureOf(member, source)}`]
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
    return [`${printed(member.name, source)}${signatureOf(member, source)}`]
  if (ts.isPropertyDeclaration(member))
    return [`${printed(member.name, source)}${member.type === undefined ? '' : `: ${printed(member.type, source)}`}`]
  return []
}

function classText(node: ts.ClassDeclaration, source: ts.SourceFile): string {
  const generics = node.typeParameters === undefined ? '' : `<${node.typeParameters.map(parameter => printed(parameter, source)).join(', ')}>`
  const heritage = (node.heritageClauses ?? []).map(clause => ` ${printed(clause, source)}`).join('')
  const members = node.members.flatMap(member => memberText(member, source)).join('; ')
  return `class ${node.name?.text ?? DEFAULT_EXPORT}${generics}${heritage} { ${members} }`
}

function addFunction(module: PortModule, name: string, signature: string): void {
  const earlier = module.functions[name]
  module.functions[name] = earlier === undefined ? signature : `${earlier}; ${signature}`
}

function addVariable(module: PortModule, declaration: ts.VariableDeclaration, source: ts.SourceFile): void {
  const name = declaration.name.getText(source)
  const value = declaration.initializer
  if (value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)))
    addFunction(module, name, signatureOf(value, source))
  else if (declaration.type !== undefined && ts.isFunctionTypeNode(declaration.type))
    addFunction(module, name, signatureOf(declaration.type, source))
  else
    module.constants.push(declaration.type === undefined ? name : `${name}: ${printed(declaration.type, source)}`)
}

function addStatement(module: PortModule, statement: ts.Statement, source: ts.SourceFile): void {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    module.reexports.push(...(clause !== undefined && ts.isNamedExports(clause) ? clause.elements.map(element => element.name.text) : [printed(statement, source)]))
    return
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword))
    return
  if (ts.isFunctionDeclaration(statement))
    addFunction(module, statement.name?.text ?? DEFAULT_EXPORT, signatureOf(statement, source))
  else if (ts.isClassDeclaration(statement))
    module.types[statement.name?.text ?? DEFAULT_EXPORT] = classText(statement, source)
  else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))
    module.types[statement.name.text] = printed(statement, source).replace(/^export /, '')
  else if (ts.isVariableStatement(statement))
    statement.declarationList.declarations.forEach(declaration => addVariable(module, declaration, source))
}

function moduleOf({ source }: ParsedFile): PortModule {
  const module: PortModule = { functions: {}, types: {}, constants: [], reexports: [] }
  source.statements.forEach(statement => addStatement(module, statement, source))
  return { ...module, constants: module.constants.sort(), reexports: module.reexports.sort() }
}

function importedFile(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)).replace(SOURCE_SUFFIX, '.ts')
  return target.startsWith(`${PRODUCT_TREE}/`) ? target : null
}

function namesOf(statement: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    return clause !== undefined && ts.isNamedExports(clause) ? clause.elements.map(element => (element.propertyName ?? element.name).text) : []
  }
  const clause = statement.importClause
  if (clause === undefined)
    return []
  const bindings = clause.namedBindings
  return [
    ...(clause.name === undefined ? [] : [DEFAULT_EXPORT]),
    ...(bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map(element => (element.propertyName ?? element.name).text) : []),
  ]
}

export function namesImportedAcross(importers: readonly ParsedFile[]): ImportedNames {
  const imported = new Map<string, Set<string>>()
  for (const { file, source } of importers.filter(({ file }) => file.startsWith(`${FACTORY_TREE}/`))) {
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const target = importedFile(file, statement.moduleSpecifier.text)
      if (target === null)
        continue
      const names = imported.get(target) ?? new Set<string>()
      namesOf(statement).forEach(name => names.add(name))
      imported.set(target, names)
    }
  }
  return imported
}

function named(record: Record<string, string>, names: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => names.has(name)))
}

function constantName(constant: string): string {
  return constant.split(':')[0]!
}

export function crossingPart(module: PortModule, names: ReadonlySet<string>): PortModule {
  return {
    functions: named(module.functions, names),
    types: named(module.types, names),
    constants: module.constants.filter(constant => names.has(constantName(constant))),
    reexports: module.reexports.filter(name => names.has(name)),
  }
}

export function namesOutside(module: PortModule, names: ReadonlySet<string>): string[] {
  const described = new Set([...Object.keys(module.functions), ...Object.keys(module.types), ...module.constants.map(constantName), ...module.reexports])
  return [...names].filter(name => !described.has(name)).sort()
}

export function boundarySection(products: readonly ParsedFile[], imported: ImportedNames): Record<string, PortModule> {
  const crossing = products.filter(({ file }) => imported.has(file))
  const undescribed = crossing.flatMap(parsed => namesOutside(moduleOf(parsed), imported.get(parsed.file)!).map(name => `${parsed.file} :: ${name}`))
  if (undescribed.length > 0)
    throw new Error(`${FACTORY_TREE}/ imports a name ${PRODUCT_TREE}/ exports by no declaration the ports section reads: ${undescribed.join(', ')}`)
  return Object.fromEntries(crossing.map(parsed => [parsed.file, crossingPart(moduleOf(parsed), imported.get(parsed.file)!)]))
}

export function portsSection(root: string): PortsSection {
  return {
    portsVersion: PORTS_VERSION,
    modules: Object.fromEntries(parsedFiles(root, [PORTS_TREE]).map(parsed => [parsed.file, moduleOf(parsed)])),
    boundary: existsSync(path.join(root, PRODUCT_TREE)) ? boundarySection(parsedFiles(root, [PRODUCT_TREE]), namesImportedAcross(parsedFiles(root, [FACTORY_TREE]))) : {},
  }
}
