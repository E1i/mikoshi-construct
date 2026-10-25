import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { FACTORY_FOLDERS, FACTORY_NAMED, FACTORY_ROOT } from './factory-paths.js'
import { PROJECTION_KEYS } from './reducer.js'

export const KNOWN_WRITES = FACTORY_NAMED.knownProjectionWrites
export const REDUCER_ENTRIES: readonly string[] = [`${FACTORY_NAMED.busReducer}#reduce`, `${FACTORY_NAMED.busWatermark}#reduceProjection`]

const SCANNED_ROOT = FACTORY_ROOT
const UNSCANNED = `${FACTORY_FOLDERS.tests[0]}/`
const FOLD_MAP_TYPE = 'Record<string, Fold>'
const MODULE_UNIT = '<module>'
const SQL_WRITE = /\b(INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/g

export type Operation = 'insert' | 'update' | 'delete'

export interface WriteSite {
  file: string
  unit: string
  table: string
  operation: Operation
}

interface Write {
  table: string
  operation: Operation
}

interface FoldAccess {
  map: string
  key: string | null
}

interface Unit {
  id: string
  writes: Write[]
  references: string[]
  foldAccesses: FoldAccess[]
}

interface FoldMember {
  key: string | null
  id: string
}

interface FoldMap {
  typed: boolean
  members: FoldMember[]
  spreads: string[]
}

interface Scan {
  units: Map<string, Unit>
  foldMaps: Map<string, FoldMap>
}

function operationOf(verb: string): Operation {
  if (verb.startsWith('DELETE'))
    return 'delete'
  return verb === 'UPDATE' ? 'update' : 'insert'
}

function writesIn(sql: string): Write[] {
  const tables = new Set(Object.keys(PROJECTION_KEYS))
  return [...sql.matchAll(SQL_WRITE)].filter(match => tables.has(match[2]!)).map(match => ({ table: match[2]!, operation: operationOf(match[1]!) }))
}

function relativeImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts')
}

class FileScan {
  readonly imports = new Map<string, string>()
  readonly declared = new Set<string>()
  readonly constants = new Map<string, ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression>()

  constructor(readonly file: string, readonly source: ts.SourceFile) {
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
        this.readImport(statement, statement.moduleSpecifier.text)
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
        this.declared.add(statement.name.text)
      if (ts.isClassDeclaration(statement) && statement.name !== undefined)
        this.declared.add(statement.name.text)
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            this.declared.add(declaration.name.text)
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && (ts.isStringLiteral(declaration.initializer) || ts.isNoSubstitutionTemplateLiteral(declaration.initializer) || ts.isTemplateExpression(declaration.initializer)))
            this.constants.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }

  private readImport(statement: ts.ImportDeclaration, specifier: string): void {
    const target = relativeImport(this.file, specifier)
    const bindings = statement.importClause?.namedBindings
    if (target === null || bindings === undefined || !ts.isNamedImports(bindings))
      return
    for (const element of bindings.elements)
      this.imports.set(element.name.text, `${target}#${(element.propertyName ?? element.name).text}`)
  }

  resolve(name: string): string | null {
    if (this.declared.has(name))
      return `${this.file}#${name}`
    return this.imports.get(name) ?? null
  }
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node))
    return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node)
    return false
  return !ts.isTypeReferenceNode(parent) && !ts.isImportSpecifier(parent)
}

function sqlTextOf(node: ts.Node, scan: FileScan, constants: Map<string, string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (!ts.isTemplateExpression(node))
    return null
  const value = (expression: ts.Expression): string => ts.isIdentifier(expression) ? constants.get(scan.resolve(expression.text) ?? '') ?? '' : ''
  return node.head.text + node.templateSpans.map(span => value(span.expression) + span.literal.text).join('')
}

function keyOf(scan: FileScan, constants: Map<string, string>, expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text
  if (!ts.isIdentifier(expression))
    return null
  const resolved = scan.resolve(expression.text)
  return resolved === null ? null : constants.get(resolved) ?? resolved
}

function propertyKeyOf(scan: FileScan, constants: Map<string, string>, name: ts.PropertyName): string | null {
  if (ts.isComputedPropertyName(name))
    return keyOf(scan, constants, name.expression)
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
}

function unitBody(scan: FileScan, id: string, body: ts.Node, constants: Map<string, string>, writingConstants: Map<string, Write[]>): Unit {
  const unit: Unit = { id, writes: [], references: [], foldAccesses: [] }
  const visit = (node: ts.Node): void => {
    const sql = sqlTextOf(node, scan, constants)
    if (sql !== null)
      unit.writes.push(...writesIn(sql))
    if (ts.isIdentifier(node) && isReference(node)) {
      const resolved = scan.resolve(node.text)
      if (resolved !== null) {
        unit.references.push(resolved)
        unit.writes.push(...writingConstants.get(resolved) ?? [])
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const resolved = scan.resolve(node.expression.text)
      if (resolved !== null)
        unit.foldAccesses.push({ map: resolved, key: keyOf(scan, constants, node.argumentExpression) })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return unit
}

function foldMapOf(scan: FileScan, constants: Map<string, string>, initializer: ts.ObjectLiteralExpression, typed: boolean): FoldMap {
  const map: FoldMap = { typed, members: [], spreads: [] }
  for (const property of initializer.properties) {
    const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : ts.isSpreadAssignment(property) ? property.expression : undefined
    const resolved = value !== undefined && ts.isIdentifier(value) ? scan.resolve(value.text) : null
    if (resolved === null)
      continue
    if (ts.isSpreadAssignment(property))
      map.spreads.push(resolved)
    else
      map.members.push({ key: property.name === undefined ? null : propertyKeyOf(scan, constants, property.name), id: resolved })
  }
  return map
}

function isFunctionValue(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function scanFile(scan: FileScan, constants: Map<string, string>, writingConstants: Map<string, Write[]>, into: Scan): void {
  const add = (name: string, body: ts.Node): void => {
    const id = `${scan.file}#${name}`
    const unit = unitBody(scan, id, body, constants, writingConstants)
    const known = into.units.get(id)
    into.units.set(id, known === undefined ? unit : { id, writes: [...known.writes, ...unit.writes], references: [...known.references, ...unit.references], foldAccesses: [...known.foldAccesses, ...unit.foldAccesses] })
  }
  for (const statement of scan.source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      continue
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement)
      continue
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      for (const member of statement.members)
        add(`${statement.name.text}.${member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : 'constructor'}`, member)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name))
          continue
        const name = declaration.name.text
        const initializer = declaration.initializer
        const typed = declaration.type?.getText(scan.source) === FOLD_MAP_TYPE
        if (isFunctionValue(initializer))
          add(name, initializer)
        else if (initializer !== undefined && ts.isObjectLiteralExpression(initializer) && (typed || initializer.properties.some(ts.isSpreadAssignment)))
          into.foldMaps.set(`${scan.file}#${name}`, foldMapOf(scan, constants, initializer, typed))
        else if (initializer !== undefined && !scan.constants.has(name))
          add(MODULE_UNIT, declaration)
      }
      continue
    }
    add(MODULE_UNIT, statement)
  }
}

function foldMapMembers(foldMaps: Map<string, FoldMap>, id: string, key: string | null = null, seen = new Set<string>()): string[] {
  const map = foldMaps.get(id)
  if (map === undefined || seen.has(id))
    return []
  seen.add(id)
  const members = map.members.filter(member => key === null || member.key === null || member.key === key).map(member => member.id)
  return [...members, ...map.spreads.flatMap(spread => foldMapMembers(foldMaps, spread, key, seen))]
}

function accessedFolds(foldMaps: Map<string, FoldMap>, access: FoldAccess): string[] {
  const keyed = foldMapMembers(foldMaps, access.map, access.key)
  return keyed.length > 0 ? keyed : foldMapMembers(foldMaps, access.map)
}

function realFoldMaps(candidates: Map<string, FoldMap>): Map<string, FoldMap> {
  const real = new Map([...candidates].filter(([, map]) => map.typed))
  for (let grown = true; grown;) {
    grown = false
    for (const [id, map] of candidates) {
      if (!real.has(id) && map.spreads.some(spread => real.has(spread))) {
        real.set(id, map)
        grown = true
      }
    }
  }
  return real
}

function insideUnits(scan: Scan): Set<string> {
  const inside = new Set<string>()
  const pending = [...REDUCER_ENTRIES, ...[...scan.foldMaps.keys()].flatMap(id => foldMapMembers(scan.foldMaps, id))]
  while (pending.length > 0) {
    const id = pending.pop()!
    const unit = scan.units.get(id)
    if (unit === undefined || inside.has(id))
      continue
    inside.add(id)
    pending.push(...unit.references, ...unit.foldAccesses.flatMap(access => accessedFolds(scan.foldMaps, access)))
  }
  return inside
}

function reachedWrites(scan: Scan, inside: Set<string>, ids: string[]): Write[] {
  const writes: Write[] = []
  const seen = new Set<string>()
  const pending = [...ids]
  while (pending.length > 0) {
    const id = pending.pop()!
    const unit = scan.units.get(id)
    if (unit === undefined || seen.has(id) || !inside.has(id))
      continue
    seen.add(id)
    writes.push(...unit.writes)
    pending.push(...unit.references, ...unit.foldAccesses.flatMap(access => accessedFolds(scan.foldMaps, access)))
  }
  return writes
}

function siteKey(site: WriteSite): string {
  return `${site.file} ${site.unit} ${site.table} ${site.operation}`
}

export function sortedSites(sites: WriteSite[]): WriteSite[] {
  return [...new Map(sites.map(site => [siteKey(site), site])).values()].sort((a, b) => siteKey(a).localeCompare(siteKey(b)))
}

export function projectionWriteSites(sources: ReadonlyMap<string, string>): WriteSite[] {
  const files = [...sources].map(([file, text]) => new FileScan(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)))
  const plain = new Map(files.flatMap(scan => [...scan.constants].flatMap(([name, node]) => ts.isTemplateExpression(node) ? [] : [[`${scan.file}#${name}`, node.text] as const])))
  const constants = new Map(files.flatMap(scan => [...scan.constants].map(([name, node]) => [`${scan.file}#${name}`, sqlTextOf(node, scan, plain) ?? ''] as const)))
  const writingConstants = new Map([...constants].map(([id, value]) => [id, writesIn(value)] as const).filter(([, writes]) => writes.length > 0))
  const scan: Scan = { units: new Map(), foldMaps: new Map() }
  for (const file of files)
    scanFile(file, constants, writingConstants, scan)
  scan.foldMaps = realFoldMaps(scan.foldMaps)
  const inside = insideUnits(scan)
  const sites: WriteSite[] = []
  for (const unit of scan.units.values()) {
    if (inside.has(unit.id))
      continue
    const [file, name] = unit.id.split('#') as [string, string]
    const crossings = [...unit.references.filter(id => inside.has(id) && !REDUCER_ENTRIES.includes(id)), ...unit.foldAccesses.flatMap(access => accessedFolds(scan.foldMaps, access))]
    for (const write of [...unit.writes, ...reachedWrites(scan, inside, crossings)])
      sites.push({ file, unit: name, table: write.table, operation: write.operation })
  }
  return sortedSites(sites)
}

function scriptsUnder(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
      return relative.startsWith(UNSCANNED) || `${relative}/` === UNSCANNED ? [] : scriptsUnder(root, relative)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [relative] : []
  })
}

export function repositorySources(root: string): Map<string, string> {
  return new Map(scriptsUnder(root, SCANNED_ROOT).map(file => [file, readFileSync(path.join(root, file), 'utf8')]))
}

export function knownWriteSites(root: string): WriteSite[] {
  return JSON.parse(readFileSync(path.join(root, KNOWN_WRITES), 'utf8')) as WriteSite[]
}

export function unrecordedSites(found: WriteSite[], known: WriteSite[]): WriteSite[] {
  const recorded = new Set(known.map(siteKey))
  return found.filter(site => !recorded.has(siteKey(site)))
}

export function staleSites(found: WriteSite[], known: WriteSite[]): WriteSite[] {
  return unrecordedSites(known, found)
}
