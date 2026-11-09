import type { ParsedFile } from './walk.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { eachNode } from './walk.js'

export const FILES_VERSION = 1

export type FileSource = { kind: 'owner' } | { kind: 'event' | 'table', name: string }

export interface HomeFile {
  path: string
  names: readonly string[]
  source: FileSource
  owner?: string
}

export interface FileEntry {
  owner: string
  source: string
  derived: boolean
  directory: boolean
  writers: string[]
  namedIn: string[]
}

export interface FilesSection {
  filesVersion: number
  entries: Record<string, FileEntry>
}

export interface FileSources {
  events: ReadonlySet<string>
  tables: ReadonlySet<string>
}

const HOME_ROOTS = new Set(['.construct', '.construct-owner'])
const PATH_BUILDERS = new Set(['join', 'resolve'])
const WRITE_TARGET_ARGUMENT: Readonly<Record<string, number>> = { writeFileSync: 0, appendFileSync: 0, writeFile: 0, appendFile: 0, createWriteStream: 0, mkdirSync: 0, mkdtempSync: 0, renameSync: 1, copyFileSync: 1, cpSync: 1, symlinkSync: 1 }
const HOME_DIR_CALLS: Readonly<Record<string, string>> = { busDirOf: '.construct/bus', defaultBusDir: '.construct/bus', defaultHandoffDir: '.construct/handoff', handoffDirOf: '.construct/handoff' }
const HOME_DIR_PARAMETERS: Readonly<Record<string, string>> = { busDir: '.construct/bus', busPath: '.construct/bus.db', busDb: '.construct/bus.db' }
const PARENT_DIRECTORY = 'dirname'
const TABLE_CREATED = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\b|main\b)"?(\w+)/g
const ROW_WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)/gi
const TABLE_WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+"?(\w+)/gi
const TABLE_PATH = '#'
const CONTRACT_TOOLING = 'scripts/contract/'
const HOME_PREFIX = '~/'
const EVENT_TYPE_KEY = 'type'

function tableNamed(table: string): RegExp {
  return new RegExp(`\\b(?:FROM|INTO|UPDATE|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|JOIN)\\s+"?${table}\\b`, 'i')
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('*')
  return null
}

function segmentsOf(file: string): string[] {
  return file.replace(HOME_PREFIX, '').split(TABLE_PATH)[0]!.split('/').filter(segment => segment !== '')
}

type Constants = ReadonlyMap<string, string>

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null
}

const literalsRead = new WeakMap<ts.SourceFile, string[]>()

function literalsOf(source: ts.SourceFile): string[] {
  const read = literalsRead.get(source)
  if (read !== undefined)
    return read
  const literals: string[] = []
  eachNode(source, (node) => {
    const text = literalText(node)
    if (text !== null)
      literals.push(text)
  })
  literalsRead.set(source, literals)
  return literals
}

const constantsRead = new WeakMap<ts.SourceFile, Constants>()

function constantsOf(source: ts.SourceFile): Constants {
  const read = constantsRead.get(source)
  if (read !== undefined)
    return read
  const constants = new Map<string, string>()
  constantsRead.set(source, constants)
  eachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined)
      return
    const text = literalText(node.initializer)
    if (text !== null && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0)
      constants.set(node.name.text, text)
  })
  return constants
}

function segmentText(node: ts.Expression, constants: Constants): string | null {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    if (name === PARENT_DIRECTORY && node.arguments.length === 1) {
      const child = segmentText(node.arguments[0]!, constants)
      return child === null || !child.includes('/') ? null : child.slice(0, child.lastIndexOf('/'))
    }
    return name !== null && Object.hasOwn(HOME_DIR_CALLS, name) ? HOME_DIR_CALLS[name]! : null
  }
  if (ts.isIdentifier(node))
    return constants.get(node.text) ?? (Object.hasOwn(HOME_DIR_PARAMETERS, node.text) ? HOME_DIR_PARAMETERS[node.text]! : null)
  return literalText(node)
}

function builtPath(node: ts.CallExpression, constants: Constants): string | null {
  const name = calleeName(node)
  if (name === null || !PATH_BUILDERS.has(name))
    return null
  const segments = node.arguments.map(argument => segmentText(argument, constants))
  const start = segments.findIndex(text => text !== null && HOME_ROOTS.has(text.split('/')[0]!))
  if (start === -1)
    return null
  const tail: string[] = []
  for (const text of segments.slice(start)) {
    if (text === null)
      break
    tail.push(text)
  }
  const built = tail.join('/')
  return built.split('/').length > 1 ? built : null
}

function namedPath(text: string): string | null {
  const segments = text.split('/')
  return HOME_ROOTS.has(segments[0]!) && segments.length > 1 && segments[1] !== '' && !text.includes(' ') ? text.replace(/\/+$/, '') : null
}

export function namedFiles(files: readonly ParsedFile[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const add = (name: string, file: string): void => {
    found.set(name, [...new Set([...found.get(name) ?? [], file])].sort())
  }
  for (const { file, source } of files) {
    const constants = constantsOf(source)
    eachNode(source, (node) => {
      const built = ts.isCallExpression(node) ? builtPath(node, constants) : null
      if (built !== null)
        add(built, file)
      const text = literalText(node)
      if (text === null)
        return
      const named = namedPath(text)
      if (named !== null && !(ts.isCallExpression(node.parent) && builtPath(node.parent, constants) !== null))
        add(named, file)
      for (const [, table] of text.matchAll(TABLE_CREATED))
        add(`${TABLE_PATH}${table}`, file)
    })
  }
  return found
}

function isPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length <= longer.length && shorter.every((segment, index) => segment === longer[index] || segment.includes('*') || longer[index]!.includes('*'))
}

export function covers(entry: HomeFile, named: string): boolean {
  if (named.startsWith(TABLE_PATH) || entry.path.includes(TABLE_PATH))
    return entry.path.endsWith(named) && named.startsWith(TABLE_PATH)
  const a = segmentsOf(entry.path)
  const b = segmentsOf(named)
  return isPrefix(a, b) || isPrefix(b, a)
}

function namesThePath(text: string, names: readonly string[]): boolean {
  return names.some(name => text === name || text.endsWith(`/${name}`) || text.startsWith(`${name}/`) || text.includes(`/${name}/`))
}

type Names = (node: ts.Node) => boolean

function namesIn(source: ts.SourceFile, names: readonly string[]): Names {
  const constants = constantsOf(source)
  return (node) => {
    const built = ts.isCallExpression(node) ? builtPath(node, constants) : null
    if (built !== null && namesThePath(built, names))
      return true
    const text = literalText(node)
    return text !== null && namesThePath(text, names)
  }
}

function isParentOf(node: ts.Node): boolean {
  return ts.isCallExpression(node) && calleeName(node) === PARENT_DIRECTORY
}

function containsAny(node: ts.Node, names: Names, carriers: ReadonlySet<string>): boolean {
  if (isParentOf(node))
    return false
  if (names(node) || (ts.isIdentifier(node) && carriers.has(node.text) && !isDeclarationName(node)))
    return true
  return ts.forEachChild(node, child => containsAny(child, names, carriers) || undefined) ?? false
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node
}

interface CarrierDeclaration {
  name: string
  body: readonly ts.Node[]
  exported: boolean
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

function returnedExpressions(body: ts.Node): ts.Node[] {
  if (!ts.isBlock(body))
    return [body]
  const returned: ts.Node[] = []
  eachNode(body, (node) => {
    if (ts.isReturnStatement(node) && node.expression !== undefined)
      returned.push(node.expression)
  })
  return returned
}

function carrierDeclarations(source: ts.SourceFile): CarrierDeclaration[] {
  const declarations: CarrierDeclaration[] = []
  eachNode(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const statement = node.parent.parent
      const exported = ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) && isExported(statement)
      const body = ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) ? returnedExpressions(node.initializer.body) : [node.initializer]
      declarations.push({ name: node.name.text, body, exported })
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined && ts.isSourceFile(node.parent))
      declarations.push({ name: node.name.text, body: returnedExpressions(node.body), exported: isExported(node) })
  })
  return declarations
}

function exportedCarriers(source: ts.SourceFile, names: Names): Set<string> {
  const carriers = localCarriers(source, names, new Set())
  return new Set(carrierDeclarations(source).filter(({ name, exported }) => exported && carriers.has(name)).map(({ name }) => name))
}

function importedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
    if (bindings !== undefined && ts.isNamedImports(bindings))
      bindings.elements.forEach(element => names.add(element.name.text))
  }
  return names
}

function isPathExpression(node: ts.Node, carriers: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return isPathExpression(node.expression, carriers)
  if (ts.isConditionalExpression(node))
    return isPathExpression(node.whenTrue, carriers) || isPathExpression(node.whenFalse, carriers)
  if (ts.isBinaryExpression(node))
    return isPathExpression(node.left, carriers) || isPathExpression(node.right, carriers)
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    return name !== null && (PATH_BUILDERS.has(name) || name === PARENT_DIRECTORY || carriers.has(name))
  }
  return literalText(node) !== null || ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)
}

function localCarriers(source: ts.SourceFile, names: Names, known: ReadonlySet<string>): Set<string> {
  const carriers = new Set(known)
  const declarations = carrierDeclarations(source)
  for (let grown = true; grown;) {
    grown = false
    for (const { name, body } of declarations) {
      if (!carriers.has(name) && body.some(node => isPathExpression(node, carriers) && containsAny(node, names, carriers))) {
        carriers.add(name)
        grown = true
      }
    }
  }
  return carriers
}

function writeTarget(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node) || node.arguments.length === 0)
    return null
  const name = calleeName(node)
  return name !== null && Object.hasOwn(WRITE_TARGET_ARGUMENT, name) ? node.arguments[WRITE_TARGET_ARGUMENT[name]!] ?? null : null
}

function writesTable(text: string, table: string, statements: RegExp): boolean {
  return [...text.matchAll(statements)].some(([, name]) => name === table)
}

function tableOf(entry: HomeFile): string | null {
  const at = entry.path.indexOf(TABLE_PATH)
  return at === -1 ? null : entry.path.slice(at + TABLE_PATH.length)
}

export interface FileReading {
  namedIn: string[]
  definedIn: string[]
  writers: string[]
}

function tableReading(table: string, files: readonly ParsedFile[], statements: RegExp = TABLE_WRITE): FileReading {
  const namedIn = new Set<string>()
  const writers = new Set<string>()
  const named = tableNamed(table)
  for (const { file, source } of files) {
    for (const text of literalsOf(source).filter(literal => named.test(literal))) {
      namedIn.add(file)
      if (writesTable(text, table, statements))
        writers.add(file)
    }
  }
  return { namedIn: [...namedIn].sort(), definedIn: [...namedIn].sort(), writers: [...writers].sort() }
}

const PATH_SPELLINGS = Object.entries({ ...HOME_DIR_CALLS, ...HOME_DIR_PARAMETERS })

function spellings(names: readonly string[]): string[] {
  return [...names.map(name => name.split('/').at(-1)!), ...PATH_SPELLINGS.filter(([, spelled]) => namesThePath(spelled, names)).map(([spelling]) => spelling)]
}

function spellsAPath(text: string, spelled: readonly string[]): boolean {
  return spelled.some(spelling => text.includes(spelling))
}

export function readingOf(entry: HomeFile, files: readonly ParsedFile[]): FileReading {
  const table = tableOf(entry)
  if (table !== null)
    return tableReading(table, files)
  const tooling = files.filter(({ file }) => !file.startsWith(CONTRACT_TOOLING))
  const spelledAs = spellings(entry.names)
  const spelled = tooling.filter(({ source }) => spellsAPath(source.text, spelledAs))
  const exported = new Set<string>()
  for (const { source } of spelled)
    exportedCarriers(source, namesIn(source, entry.names)).forEach(name => exported.add(name))
  const scanned = tooling.filter(({ source }) => spellsAPath(source.text, spelledAs) || [...importedNames(source)].some(name => exported.has(name)))
  const matchers = new Map(scanned.map(({ file, source }) => [file, namesIn(source, entry.names)]))
  const namedIn = new Set<string>()
  const definedIn = new Set<string>()
  const writers = new Set<string>()
  for (const { file, source } of scanned) {
    const names = matchers.get(file)!
    const visible = new Set([...importedNames(source)].filter(name => exported.has(name)))
    const carriers = localCarriers(source, names, visible)
    if (!containsAny(source, names, carriers))
      continue
    namedIn.add(file)
    if (containsAny(source, names, new Set()))
      definedIn.add(file)
    eachNode(source, (node) => {
      const target = writeTarget(node)
      if (target !== null && containsAny(target, names, carriers))
        writers.add(file)
    })
  }
  return { namedIn: [...namedIn].sort(), definedIn: [...definedIn].sort(), writers: [...writers].sort() }
}

function eventEmitters(event: string, files: readonly ParsedFile[]): string[] {
  const holders = new Set<string>()
  for (const { source } of files) {
    for (const [name, value] of constantsOf(source)) {
      if (value === event)
        holders.add(name)
    }
  }
  const emitters = new Set<string>()
  for (const { file, source } of files) {
    eachNode(source, (node) => {
      if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== EVENT_TYPE_KEY)
        return
      const value = node.initializer
      if ((ts.isIdentifier(value) && holders.has(value.text)) || literalText(value) === event)
        emitters.add(file)
    })
  }
  return [...emitters].sort()
}

function sourceWriters(source: Exclude<FileSource, { kind: 'owner' }>, files: readonly ParsedFile[]): string[] {
  return source.kind === 'event' ? eventEmitters(source.name, files) : tableReading(source.name, files, ROW_WRITE).writers
}

function sourceOf(entry: HomeFile, sources: FileSources): string {
  const { source } = entry
  if (source.kind === 'owner')
    return 'owner'
  const known = source.kind === 'event' ? sources.events : sources.tables
  if (!known.has(source.name))
    throw new Error(`${entry.path} is recorded as a view of the ${source.kind} ${source.name}, which the bus section does not hold`)
  return `${source.kind}:${source.name}`
}

export function isDirectory(entry: HomeFile): boolean {
  return !entry.path.includes(TABLE_PATH) && !segmentsOf(entry.path).at(-1)!.includes('.')
}

function singleWriter(what: string, writers: readonly string[]): string | undefined {
  if (writers.length > 1)
    throw new Error(`${what} has ${writers.length} writer modules (${writers.join(', ')}); a file has one owner, so the others write through it`)
  return writers[0]
}

function declaredOwner(entry: HomeFile, { namedIn, writers }: FileReading, directory: boolean): string {
  const owner = entry.owner!
  if (!namedIn.includes(owner))
    throw new Error(`${entry.path} is declared owned by ${owner}, which does not name it`)
  if (!directory && writers.length === 1 && writers[0] !== owner)
    throw new Error(`${entry.path} is declared owned by ${owner} and written by ${writers[0]}`)
  return owner
}

function ownerOf(entry: HomeFile, reading: FileReading, files: readonly ParsedFile[]): string {
  const { namedIn, definedIn, writers } = reading
  if (entry.source.kind !== 'owner') {
    const owner = singleWriter(`${entry.source.kind} ${entry.source.name}, the source of ${entry.path},`, sourceWriters(entry.source, files))
    if (owner === undefined)
      throw new Error(`${entry.path} is a view of the ${entry.source.kind} ${entry.source.name}, which no module writes`)
    return owner
  }
  const directory = isDirectory(entry)
  if (!directory)
    singleWriter(entry.path, writers)
  if (entry.owner !== undefined)
    return declaredOwner(entry, reading, directory)
  if (namedIn.length === 0)
    throw new Error(`${entry.path} is named in no module under ${entry.names.join(', ')}; the entry is stale`)
  const owner = (directory ? undefined : writers[0]) ?? [definedIn, namedIn].find(modules => modules.length === 1)?.[0]
  if (owner === undefined)
    throw new Error(`${entry.path} has no single writer and is named in ${definedIn.join(', ')}; declare which of them owns it`)
  return owner
}

function inTheBusSection(named: string, sources: FileSources): boolean {
  return named.startsWith(TABLE_PATH) && sources.tables.has(named.slice(TABLE_PATH.length))
}

export function unrecorded(named: Map<string, string[]>, entries: readonly HomeFile[], sources: FileSources): string[] {
  return [...named.entries()]
    .filter(([name]) => !inTheBusSection(name, sources) && !entries.some(entry => covers(entry, name)))
    .map(([name, files]) => `${name} (${files.join(', ')})`)
    .sort()
}

export function fileEntry(entry: HomeFile, files: readonly ParsedFile[], sources: FileSources): FileEntry {
  const reading = readingOf(entry, files)
  return { owner: ownerOf(entry, reading, files), source: sourceOf(entry, sources), derived: entry.source.kind !== 'owner', directory: isDirectory(entry), writers: reading.writers, namedIn: reading.namedIn }
}

const FILES_TABLE = 'files.json'
const FILES_MODULE = `scripts/contract/factory/${FILES_TABLE}`

interface TableRow {
  path: string
  names: string[]
  source?: FileSource
  owner?: string
}

function homeFile({ path: file, names, source = { kind: 'owner' }, owner }: TableRow): HomeFile {
  return owner === undefined ? { path: file, names, source } : { path: file, names, source, owner }
}

export const HOME_FILES: readonly HomeFile[] = (JSON.parse(readFileSync(path.join(import.meta.dirname, FILES_TABLE), 'utf8')) as TableRow[]).map(homeFile)

export function filesSection(files: readonly ParsedFile[], sources: FileSources, entries: readonly HomeFile[] = HOME_FILES): FilesSection {
  const missing = unrecorded(namedFiles(files), entries, sources)
  if (missing.length > 0)
    throw new Error(`a file in the home directory or under .construct has no entry in ${FILES_MODULE}: ${missing.join('; ')}`)
  return {
    filesVersion: FILES_VERSION,
    entries: Object.fromEntries(entries.map(entry => [entry.path, fileEntry(entry, files, sources)])),
  }
}
