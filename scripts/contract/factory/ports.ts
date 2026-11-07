import type { ParsedFile } from './walk.js'
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
}

export const PORTS_VERSION = 2

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

export function portsSection(root: string): PortsSection {
  return { portsVersion: PORTS_VERSION, modules: Object.fromEntries(parsedFiles(root, [PORTS_TREE]).map(parsed => [parsed.file, moduleOf(parsed)])) }
}
