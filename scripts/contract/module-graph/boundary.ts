import type { ModuleGraphSpec } from '../factory/modules.js'
import type { ImportEdge, PathAliases } from './imports.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { heldBy, isTool, MODULE_GRAPH } from '../factory/modules.js'
import { buildImportGraph, byText, isCodeFile, readAliases, resolveSpecifier } from './imports.js'
import { ownerOf, sourceFiles } from './ownership.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const COMPOSITION_ROOT = 'composition root'
const EXCLUSION = 'exclusion:'
const UNOWNED = 'unowned'

export const BOUNDARY_PREFIX = 'boundary:'

export const VIOLATION_REASONS = ['from-undecided', 'into-undecided', 'not-in-may-use', 'outside-contract', 'into-composition-root', 'into-exclusion', 'into-unowned', 'into-tool'] as const

export type ViolationReason = typeof VIOLATION_REASONS[number]

export interface Violation {
  from: string
  to: string
  fromModule: string
  toHolder: string
  reasons: ViolationReason[]
}

export interface BoundaryReport {
  graph: ImportEdge[]
  violations: Violation[]
  scc: string[][]
}

function holderOf(spec: ModuleGraphSpec, file: string): string {
  return ownerOf(spec, file)[0] ?? UNOWNED
}

function isModule(spec: ModuleGraphSpec, holder: string): boolean {
  return spec.modules[holder] !== undefined
}

export function isGraphModule(spec: ModuleGraphSpec, holder: string): boolean {
  return isModule(spec, holder) && !isTool(spec.modules[holder])
}

export function graphModules(spec: ModuleGraphSpec): string[] {
  return Object.keys(spec.modules).filter(id => isGraphModule(spec, id)).sort(byText)
}

function admittedIntoCompositionRoot(spec: ModuleGraphSpec, from: string, to: string): boolean {
  return spec.composition_imports[to]?.includes(from) === true
}

function reasonsFor(spec: ModuleGraphSpec, fromModule: string, toHolder: string, from: string, to: string): ViolationReason[] {
  if (toHolder === COMPOSITION_ROOT)
    return admittedIntoCompositionRoot(spec, from, to) ? [] : ['into-composition-root']
  if (toHolder.startsWith(EXCLUSION))
    return ['into-exclusion']
  const source = spec.modules[fromModule]!
  const target = spec.modules[toHolder]
  if (target === undefined)
    return ['into-unowned']
  if (isTool(target))
    return ['into-tool']
  const reasons: ViolationReason[] = []
  const written = source.may_use.includes(toHolder)
  const intoContract = heldBy(target.contract, to)
  const intoDecidedContractItNames = target.status === 'decided' && written && intoContract
  if (source.status === 'undecided' && !intoDecidedContractItNames)
    reasons.push('from-undecided')
  if (target.status === 'undecided')
    reasons.push('into-undecided')
  if (!written)
    reasons.push('not-in-may-use')
  if (!intoContract)
    reasons.push('outside-contract')
  return reasons
}

function judged(spec: ModuleGraphSpec, { from, to }: ImportEdge): Violation {
  const fromModule = holderOf(spec, from)
  const toHolder = holderOf(spec, to)
  const crossesBoundary = isGraphModule(spec, fromModule) && fromModule !== toHolder
  return { from, to, fromModule, toHolder, reasons: crossesBoundary ? reasonsFor(spec, fromModule, toHolder, from, to) : [] }
}

function isViolating(violation: Violation): boolean {
  return violation.reasons.length > 0
}

export function boundaryViolations(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): Violation[] {
  return graph.map(edge => judged(spec, edge)).filter(isViolating)
}

function moduleEdges(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>(graphModules(spec).map(id => [id, new Set<string>()]))
  for (const { from, to } of graph) {
    const [source, target] = [holderOf(spec, from), holderOf(spec, to)]
    if (source !== target && isGraphModule(spec, source) && isGraphModule(spec, target))
      edges.get(source)!.add(target)
  }
  return edges
}

export function stronglyConnected(spec: ModuleGraphSpec, graph: readonly ImportEdge[]): string[][] {
  const edges = moduleEdges(spec, graph)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  const visit = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    onStack.add(node)
    for (const next of [...edges.get(node)!].sort(byText)) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      }
      else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!))
      }
    }
    if (low.get(node) !== index.get(node))
      return
    const component: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (component.length > 1)
      components.push(component.sort(byText))
  }
  for (const node of edges.keys()) {
    if (!index.has(node))
      visit(node)
  }
  return components.sort((a, b) => byText(a[0]!, b[0]!))
}

export function graphImporters(spec: ModuleGraphSpec, files: readonly string[]): string[] {
  return files.filter(file => isCodeFile(file) && !holderOf(spec, file).startsWith(EXCLUSION))
}

export function boundaryReport(root: string = REPO_ROOT, spec: ModuleGraphSpec = MODULE_GRAPH, aliases: PathAliases = readAliases(root)): BoundaryReport {
  const files = sourceFiles(root)
  const graph = buildImportGraph(root, files, graphImporters(spec, files), aliases)
  return { graph, violations: boundaryViolations(spec, graph), scc: stronglyConnected(spec, graph) }
}

export function boundaryKey({ fromModule, toHolder }: Pick<Violation, 'fromModule' | 'toHolder'>): string {
  return `${BOUNDARY_PREFIX}${fromModule}->${toHolder.replaceAll(' ', '-')}`
}

export function boundaryNumbers(violations: readonly Violation[]): Record<string, number> {
  const numbers: Record<string, number> = {}
  for (const violation of violations) {
    const key = boundaryKey(violation)
    numbers[key] = (numbers[key] ?? 0) + 1
  }
  return numbers
}

export interface IdentifiedImport extends Violation {
  symbols: string[]
}

export interface BoundarySide {
  spec: ModuleGraphSpec
  violations: IdentifiedImport[]
  exportsOf?: ExportsOf
}

export type Renames = ReadonlyMap<string, string>

type NamedBinding = ts.ImportSpecifier | ts.ExportSpecifier

function bindingNames(elements: ts.NodeArray<NamedBinding>): string[] {
  return elements.map(element => (element.propertyName ?? element.name).text)
}

function namedBindingsOf(node: ts.Node): { specifier: string, names: string[] } | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const named = node.importClause?.namedBindings
    return { specifier: node.moduleSpecifier.text, names: named !== undefined && ts.isNamedImports(named) ? bindingNames(named.elements) : [] }
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const clause = node.exportClause
    return { specifier: node.moduleSpecifier.text, names: clause !== undefined && ts.isNamedExports(clause) ? bindingNames(clause.elements) : [] }
  }
  return undefined
}

function namedImportsOf(root: string, from: string, files: ReadonlySet<string>, aliases: PathAliases): Map<string, Set<string>> {
  const byTarget = new Map<string, Set<string>>()
  const visit = (node: ts.Node): void => {
    const found = namedBindingsOf(node)
    const to = found === undefined ? undefined : resolveSpecifier(from, found.specifier, files, aliases)
    if (found !== undefined && to !== undefined)
      byTarget.set(to, new Set([...byTarget.get(to) ?? [], ...found.names]))
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(from, readFileSync(path.join(root, from), 'utf8'), ts.ScriptTarget.Latest, true))
  return byTarget
}

export function identifiedViolations(root: string, spec: ModuleGraphSpec = MODULE_GRAPH, aliases: PathAliases = readAliases(root)): IdentifiedImport[] {
  const known = new Set(sourceFiles(root))
  const bySource = new Map<string, Map<string, Set<string>>>()
  const symbolsOf = (from: string): Map<string, Set<string>> => {
    const held = bySource.get(from) ?? namedImportsOf(root, from, known, aliases)
    bySource.set(from, held)
    return held
  }
  return boundaryReport(root, spec, aliases).graph.map(edge => ({ ...judged(spec, edge), symbols: [...symbolsOf(edge.from).get(edge.to) ?? []].sort(byText) }))
}

type DeclarationWithName = ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration

function isNamedDeclaration(statement: ts.Statement): statement is DeclarationWithName {
  return ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name))
    return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : boundNames(element.name))
}

function isExported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

function exportedNamesOf(statement: ts.Statement): string[] {
  if (ts.isExportDeclaration(statement))
    return statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map(element => element.name.text) : []
  if (!isExported(statement))
    return []
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name))
  return isNamedDeclaration(statement) && statement.name !== undefined ? [statement.name.text] : []
}

export type ExportsOf = (file: string) => ReadonlySet<string>

export function exportedNames(root: string): ExportsOf {
  const byFile = new Map<string, ReadonlySet<string>>()
  return (file) => {
    const known = byFile.get(file)
    if (known !== undefined)
      return known
    const where = path.join(root, file)
    const names = existsSync(where) ? new Set(ts.createSourceFile(file, readFileSync(where, 'utf8'), ts.ScriptTarget.Latest, true).statements.flatMap(exportedNamesOf)) : new Set<string>()
    byFile.set(file, names)
    return names
  }
}

function carriesMovedSymbols(now: readonly string[], was: readonly string[]): boolean {
  return now.length > 0 && now.every(symbol => was.includes(symbol))
}

function heldOnBase(violation: IdentifiedImport, base: readonly IdentifiedImport[], renames: Renames): boolean {
  const moved = (file: string): string => renames.get(file) ?? file
  return base.some(was => moved(was.from) === violation.from
    && (moved(was.to) === violation.to || carriesMovedSymbols(violation.symbols, was.symbols)))
}

export type MovedEdges = Map<string, number>

type FormerName = (file: string) => string

function changedOwner(violation: IdentifiedImport, base: BoundarySide, head: BoundarySide, formerName: FormerName): boolean {
  return [violation.from, violation.to].some(file => holderOf(base.spec, formerName(file)) !== holderOf(head.spec, file))
}

function importsBackFromFormerHome(violation: IdentifiedImport, base: BoundarySide, formerName: FormerName): boolean {
  const home = formerName(violation.from)
  const exported = base.exportsOf?.(home) ?? new Set<string>()
  const importedOnBase = new Set(base.violations.filter(was => was.from === home).flatMap(was => was.symbols))
  return violation.symbols.length > 0 && violation.symbols.every(symbol => exported.has(symbol) && !importedOnBase.has(symbol))
}

export function movedRows(base: BoundarySide, head: BoundarySide, grown: readonly string[], renames: Renames = new Map()): MovedEdges {
  const violating = head.violations.filter(isViolating)
  if (violating.length > base.violations.filter(isViolating).length)
    return new Map()
  const formerNames = new Map([...renames].map(([was, now]) => [now, was]))
  const formerName: FormerName = file => formerNames.get(file) ?? file
  const isMove = (violation: IdentifiedImport): boolean =>
    (changedOwner(violation, base, head, formerName) && heldOnBase(violation, base.violations, renames))
    || importsBackFromFormerHome(violation, base, formerName)
  const counts = grown.map(row => [row, violating.filter(violation => boundaryKey(violation) === row && isMove(violation)).length] as const)
  return new Map(counts.filter(([, moved]) => moved > 0))
}

export function violationLine({ from, to, reasons }: Violation): string {
  return `${from} -> ${to}: ${reasons.join(', ')}`
}

export function renderBoundaryReport(report: BoundaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(renderBoundaryReport(boundaryReport()))
