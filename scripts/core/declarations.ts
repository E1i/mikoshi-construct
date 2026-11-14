import type { GeneratedRow } from './generated-files.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DECLARATION_SUFFIX, DECLARATIONS_FOLDER, GENERATED_FILES, GENERATED_KIND, rowProblems } from './generated-files.js'

export interface ModuleDeclaration {
  module: string
  layer: string
  paths: readonly string[]
  exclude: readonly string[]
  shared: readonly string[]
}

export interface ContentionArea {
  id: string
  module?: string
  paths: readonly string[]
  why: string
  until: string
}

export interface MayUse {
  module: string
  may_use: readonly string[]
  may_use_factory: readonly string[]
  may_use_factory_within: Readonly<Record<string, readonly string[]>>
}

export interface Declarations {
  modules: readonly ModuleDeclaration[]
  contention: readonly ContentionArea[]
  generated: readonly GeneratedRow[]
  mayUse: readonly MayUse[]
  internalModules: readonly string[]
  problems: readonly string[]
}

export interface EslintEdges {
  allowedInternalImports: Record<string, string[]>
  coreFilesSrcMayImport: string[]
  allowedFactoryImports: Record<string, string[]>
}

export const MODULES_KIND = 'modules'
export const CONTENTION_KIND = 'contention'
export const MAY_USE_KIND = 'may-use'

export const KEY_FIELDS: Readonly<Record<string, string>> = { [MODULES_KIND]: 'module', [CONTENTION_KIND]: 'id', [GENERATED_KIND]: 'id', [MAY_USE_KIND]: 'module' }

export const SLICED_CHECKS: readonly string[] = ['P-restart', 'R-area-drop', 'R-graph', 'R-laws', 'V1', 'V2']

export const MODULE_FILES = GENERATED_FILES.moduleFiles.path
export const ESLINT_EDGES_ROW = 'eslint-edges'
export const ESLINT_EDGES = generatedPathOf(ESLINT_EDGES_ROW)
export const INTERNAL_MODULES_FILE = 'internal-modules.json'

const SOURCE_ROOT = 'src'
const SOURCE_SUFFIX = '.ts'
const FACTORY_CORE = 'core/'
const FACTORY_IMPORT = /^[\w-]+(?:\/[\w-]+)*(?:\.js|\/)$/

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const WILDCARD = '*'
const FOLDER_END = '/'
const EXACT = Number.POSITIVE_INFINITY

type Problem = (problem: string) => void

function generatedPathOf(id: string): string {
  const row = (Object.values(GENERATED_FILES) as GeneratedRow[]).find(entry => entry.id === id)
  if (row === undefined)
    throw new Error(`${DECLARATIONS_FOLDER}/${GENERATED_KIND}/ has no row ${id}, which scripts/core/declarations.ts names`)
  return row.path
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText)
}

export function isExact(entry: string): boolean {
  return !entry.includes(WILDCARD) && !entry.endsWith(FOLDER_END)
}

export function specificityOf(entry: string): number {
  if (isExact(entry))
    return EXACT
  const wildcard = entry.indexOf(WILDCARD)
  return wildcard === -1 ? entry.length : wildcard
}

function globSource(glob: string): string {
  let source = ''
  for (let at = 0; at < glob.length;) {
    if (glob.startsWith('**/', at)) {
      source += '(?:.*/)?'
      at += 3
    }
    else if (glob.startsWith('**', at)) {
      source += '.*'
      at += 2
    }
    else if (glob[at] === WILDCARD) {
      source += '[^/]*'
      at += 1
    }
    else {
      source += glob[at]!.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')
      at += 1
    }
  }
  return source
}

const MATCHERS = new Map<string, (file: string) => boolean>()

function matcherOf(entry: string): (file: string) => boolean {
  if (isExact(entry))
    return file => file === entry
  if (!entry.includes(WILDCARD))
    return file => file.startsWith(entry)
  const pattern = new RegExp(`^${globSource(entry)}$`)
  return file => pattern.test(file)
}

export function matches(entry: string, file: string): boolean {
  let matcher = MATCHERS.get(entry)
  if (matcher === undefined) {
    matcher = matcherOf(entry)
    MATCHERS.set(entry, matcher)
  }
  return matcher(file)
}

export interface Ownership {
  owner: string | null
  tied: readonly string[]
}

function excluded(module: ModuleDeclaration, file: string): boolean {
  return module.exclude.some(entry => matches(entry, file))
}

export function ownershipOf(modules: readonly ModuleDeclaration[], file: string): Ownership {
  let best = -1
  let holders = new Set<string>()
  for (const module of modules) {
    if (excluded(module, file))
      continue
    for (const entry of [...module.paths, ...module.shared]) {
      if (!matches(entry, file))
        continue
      const rank = specificityOf(entry)
      if (rank > best) {
        best = rank
        holders = new Set([module.module])
      }
      else if (rank === best) {
        holders.add(module.module)
      }
    }
  }
  const named = [...holders].sort()
  return named.length === 1 ? { owner: named[0]!, tied: [] } : { owner: null, tied: named }
}

function where(kind: string, key: string): string {
  return `${DECLARATIONS_FOLDER}/${kind}/${key}${DECLARATION_SUFFIX}`
}

export function declarationFileOf(module: string): string {
  return where(MODULES_KIND, module)
}

export interface CreatesOwnerRefusal {
  path: string
  owner: string | null
  modules: readonly string[]
  add: readonly string[]
}

function directoriesOf(entry: string): string[] {
  const literal = entry.includes(WILDCARD) ? entry.slice(0, entry.indexOf(WILDCARD)) : entry
  return literal.split(FOLDER_END).slice(0, -1)
}

function sharedDepth(left: readonly string[], right: readonly string[]): number {
  let depth = 0
  while (depth < left.length && depth < right.length && left[depth] === right[depth])
    depth += 1
  return depth
}

export function nearestModulesOf(modules: readonly ModuleDeclaration[], file: string): string[] {
  const folders = directoriesOf(file)
  let best = 0
  let nearest = new Set<string>()
  for (const module of modules) {
    for (const entry of module.paths) {
      const depth = sharedDepth(directoriesOf(entry), folders)
      if (depth > best) {
        best = depth
        nearest = new Set([module.module])
      }
      else if (depth === best && depth > 0) {
        nearest.add(module.module)
      }
    }
  }
  return [...nearest].sort()
}

function ownerRefusalOf(modules: readonly ModuleDeclaration[], file: string, covered: (file: string) => boolean): CreatesOwnerRefusal | null {
  const { owner, tied } = ownershipOf(modules, file)
  const named = owner !== null ? [owner] : tied.length > 0 ? tied : nearestModulesOf(modules, file)
  const widened = owner !== null || modules.some(module => covered(declarationFileOf(module.module)))
  if (widened && covered(MODULE_FILES))
    return null
  const add = [...(widened ? [] : named.map(declarationFileOf)), ...(covered(MODULE_FILES) ? [] : [MODULE_FILES])]
  return { path: file, owner, modules: named, add }
}

export function createsOwnerRefusals(modules: readonly ModuleDeclaration[], creates: readonly string[], covered: (file: string) => boolean): CreatesOwnerRefusal[] {
  return creates.flatMap(file => ownerRefusalOf(modules, file, covered) ?? [])
}

function moduleOf(key: string, value: Record<string, unknown>, problem: Problem): ModuleDeclaration | null {
  let fine = true
  const report = (text: string): void => {
    fine = false
    problem(text)
  }
  if (!isText(value.layer))
    report('layer is not a non-empty string')
  if (!isTextList(value.paths) || value.paths.length === 0)
    report('paths is not a non-empty list of non-empty strings')
  for (const field of ['exclude', 'shared'] as const) {
    if (!isTextList(value[field]))
      report(`${field} is not a list of non-empty strings`)
  }
  if (isTextList(value.shared)) {
    for (const entry of value.shared.filter(entry => !isExact(entry)))
      report(`shared names "${entry}", which is a pattern, not one file`)
  }
  return fine ? { module: key, layer: value.layer as string, paths: value.paths as string[], exclude: value.exclude as string[], shared: value.shared as string[] } : null
}

function areaOf(key: string, value: Record<string, unknown>, problem: Problem): ContentionArea | null {
  let fine = true
  const report = (text: string): void => {
    fine = false
    problem(text)
  }
  if (!isTextList(value.paths) || value.paths.length === 0)
    report('paths is not a non-empty list of non-empty strings')
  if (!isText(value.why))
    report('why is not a non-empty string')
  if (!isText(value.until))
    report('until is not a non-empty string')
  else if (!SLICED_CHECKS.includes(value.until))
    report(`until names "${value.until}", a check with no slice`)
  if (value.module !== undefined && !isText(value.module))
    report('module is not a non-empty string')
  if (!fine)
    return null
  return { id: key, ...(value.module === undefined ? {} : { module: value.module as string }), paths: value.paths as string[], why: value.why as string, until: value.until as string }
}

function isListRecord(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isTextList)
}

function mayUseOf(key: string, value: Record<string, unknown>, problem: Problem): MayUse | null {
  let fine = true
  const report = (text: string): void => {
    fine = false
    problem(text)
  }
  for (const field of ['may_use', 'may_use_factory'] as const) {
    if (!isTextList(value[field]))
      report(`${field} is not a list of non-empty strings`)
  }
  if (!isListRecord(value.may_use_factory_within))
    report('may_use_factory_within is not an object of lists of non-empty strings')
  return fine
    ? { module: key, may_use: value.may_use as string[], may_use_factory: value.may_use_factory as string[], may_use_factory_within: value.may_use_factory_within as Record<string, string[]> }
    : null
}

function internalModulesAt(root: string, problem: (text: string) => void): string[] {
  const file = path.join(root, INTERNAL_MODULES_FILE)
  if (!existsSync(file)) {
    problem(`${INTERNAL_MODULES_FILE} is missing, and ${DECLARATIONS_FOLDER}/${MAY_USE_KIND} names its modules`)
    return []
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isTextList(value)) {
    problem(`${INTERNAL_MODULES_FILE} is not a list of non-empty strings`)
    return []
  }
  return value
}

function entriesOf(folder: string, problem: (file: string, text: string) => void): { key: string, file: string, value: Record<string, unknown> }[] {
  return readdirSync(folder).sort().flatMap((name) => {
    if (!name.endsWith(DECLARATION_SUFFIX)) {
      problem(name, `is not a ${DECLARATION_SUFFIX} declaration`)
      return []
    }
    const key = name.slice(0, -DECLARATION_SUFFIX.length)
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path.join(folder, name), 'utf8'))
    }
    catch (error) {
      problem(name, `is not JSON: ${(error as Error).message}`)
      return []
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problem(name, 'is not a JSON object')
      return []
    }
    return [{ key, file: name, value: value as Record<string, unknown> }]
  })
}

export function readDeclarations(root: string = REPO_ROOT): Declarations {
  const problems: string[] = []
  const base = path.join(root, DECLARATIONS_FOLDER)
  const modules: ModuleDeclaration[] = []
  const contention: ContentionArea[] = []
  const generated: GeneratedRow[] = []
  const mayUse: MayUse[] = []
  const kinds = existsSync(base) ? readdirSync(base).sort() : []
  for (const kind of kinds) {
    if (!(kind in KEY_FIELDS) || !statSync(path.join(base, kind)).isDirectory())
      problems.push(`${DECLARATIONS_FOLDER}/${kind}: not a declaration kind this validator reads (${Object.keys(KEY_FIELDS).join(', ')})`)
  }
  for (const kind of Object.keys(KEY_FIELDS)) {
    const folder = path.join(base, kind)
    if (!existsSync(folder) || !statSync(folder).isDirectory())
      continue
    const keyField = KEY_FIELDS[kind]!
    const entries = entriesOf(folder, (file, text) => problems.push(`${DECLARATIONS_FOLDER}/${kind}/${file} ${text}`))
    for (const { key, value } of entries) {
      const problem: Problem = text => problems.push(`${where(kind, key)}: ${text}`)
      if (kind === GENERATED_KIND) {
        const found = rowProblems(key, value)
        found.forEach(problem)
        if (found.length === 0)
          generated.push(value as unknown as GeneratedRow)
        continue
      }
      if (value[keyField] !== key) {
        problem(`its key "${String(value[keyField])}" differs from its file name "${key}"`)
        continue
      }
      if (kind === MODULES_KIND) {
        const module = moduleOf(key, value, problem)
        if (module !== null)
          modules.push(module)
      }
      else if (kind === MAY_USE_KIND) {
        const edges = mayUseOf(key, value, problem)
        if (edges !== null)
          mayUse.push(edges)
      }
      else {
        const area = areaOf(key, value, problem)
        if (area !== null)
          contention.push(area)
      }
    }
  }
  const internalModules = kinds.includes(MAY_USE_KIND) ? internalModulesAt(root, text => problems.push(text)) : []
  return { modules, contention, generated, mayUse, internalModules, problems }
}

function filesUnder(entry: string, tracked: readonly string[]): string[] {
  return tracked.filter(file => matches(entry, file))
}

function moduleProblems(modules: readonly ModuleDeclaration[], tracked: readonly string[]): string[] {
  const problems: string[] = []
  for (const module of modules) {
    const at = where(MODULES_KIND, module.module)
    for (const entry of module.paths.filter(entry => filesUnder(entry, tracked).length === 0))
      problems.push(`${at}: paths entry "${entry}" matches no tracked file`)
    for (const entry of module.exclude.filter(entry => !tracked.some(file => matches(entry, file) && module.paths.some(own => matches(own, file)))))
      problems.push(`${at}: exclude entry "${entry}" removes no file its own paths match`)
    for (const entry of module.shared.filter(entry => !tracked.includes(entry)))
      problems.push(`${at}: shared path "${entry}" is not a tracked file`)
  }
  const sharedBy = new Map<string, string[]>()
  for (const module of modules) {
    for (const entry of module.shared)
      sharedBy.set(entry, [...(sharedBy.get(entry) ?? []), module.module])
  }
  for (const [file, holders] of sharedBy) {
    if (holders.length > 1)
      problems.push(`shared path "${file}" is claimed by ${holders.join(', ')}; one module owns it`)
    const naming = modules.filter(module => !holders.includes(module.module) && [...module.paths, ...module.exclude].includes(file)).map(module => module.module)
    if (naming.length > 0)
      problems.push(`shared path "${file}" of ${holders[0]!} is named by ${naming.join(', ')} as well`)
  }
  for (const file of tracked) {
    const { owner, tied } = ownershipOf(modules, file)
    if (owner !== null)
      continue
    problems.push(tied.length === 0 ? `${file}: no module owns it` : `${file}: ${tied.join(', ')} match it with equal specificity`)
  }
  return problems
}

function areaProblems(areas: readonly ContentionArea[], modules: readonly ModuleDeclaration[], tracked: readonly string[]): string[] {
  const names = new Set(modules.map(module => module.module))
  return areas.flatMap(area => [
    ...area.paths.filter(entry => filesUnder(entry, tracked).length === 0).map(entry => `${where(CONTENTION_KIND, area.id)}: paths entry "${entry}" matches no tracked file`),
    ...(area.module === undefined || names.has(area.module) ? [] : [`${where(CONTENTION_KIND, area.id)}: module "${area.module}" is not declared`]),
  ])
}

function rowProblemsOver(rows: readonly GeneratedRow[], modules: readonly ModuleDeclaration[], tracked: readonly string[]): string[] {
  const names = new Set(modules.map(module => module.module))
  return rows.flatMap((row) => {
    const at = where(GENERATED_KIND, row.id)
    if (!names.has(row.module))
      return [`${at}: module "${row.module}" is not declared`]
    const files = filesUnder(row.path, tracked)
    if (files.length === 0)
      return [`${at}: path "${row.path}" is no tracked file`]
    return files.filter(file => ownershipOf(modules, file).owner !== row.module).map(file => `${at}: ${file} is not owned by the generator's module ${row.module}`)
  })
}

function targetOf(module: string, tracked: readonly string[]): string | null {
  const file = `${SOURCE_ROOT}/${module}${SOURCE_SUFFIX}`
  if (tracked.includes(file))
    return file
  const folder = `${SOURCE_ROOT}/${module}`
  return tracked.some(entry => entry.startsWith(`${folder}/`)) ? folder : null
}

function factoryImportProblems(at: string, entries: readonly string[], tracked: readonly string[]): string[] {
  return entries.flatMap((entry) => {
    if (!FACTORY_IMPORT.test(entry))
      return [`${at}: factory import "${entry}" is neither a .js module nor a folder ending in /`]
    const source = `scripts/${entry.endsWith(FOLDER_END) ? entry : entry.replace(/\.js$/, SOURCE_SUFFIX)}`
    return tracked.some(file => matches(source, file)) ? [] : [`${at}: factory import "${entry}" names no tracked file under scripts/`]
  })
}

function mayUseProblems(mayUse: readonly MayUse[], internalModules: readonly string[], tracked: readonly string[]): string[] {
  return mayUse.flatMap((edges) => {
    const at = where(MAY_USE_KIND, edges.module)
    if (!internalModules.includes(edges.module))
      return [`${at}: module "${edges.module}" is not in ${INTERNAL_MODULES_FILE}`]
    const target = targetOf(edges.module, tracked)
    if (target === null)
      return [`${at}: neither ${SOURCE_ROOT}/${edges.module}${SOURCE_SUFFIX} nor ${SOURCE_ROOT}/${edges.module}/ is tracked`]
    return [
      ...edges.may_use.filter(name => !internalModules.includes(name)).map(name => `${at}: may_use names "${name}", which is not in ${INTERNAL_MODULES_FILE}`),
      ...edges.may_use.filter(name => name === edges.module).map(() => `${at}: may_use names the module itself`),
      ...factoryImportProblems(at, edges.may_use_factory, tracked),
      ...Object.entries(edges.may_use_factory_within).flatMap(([within, entries]) => [
        ...(tracked.some(file => file.startsWith(`${target}/${within}/`)) ? [] : [`${at}: may_use_factory_within names "${within}", and ${target}/${within}/ holds no tracked file`]),
        ...factoryImportProblems(at, entries, tracked),
      ]),
    ]
  })
}

export function validateDeclarations(declarations: Declarations, tracked: readonly string[]): string[] {
  return [
    ...declarations.problems,
    ...moduleProblems(declarations.modules, tracked),
    ...areaProblems(declarations.contention, declarations.modules, tracked),
    ...rowProblemsOver(declarations.generated, declarations.modules, tracked),
    ...mayUseProblems(declarations.mayUse, declarations.internalModules, tracked),
  ]
}

export function eslintEdgesOf(mayUse: readonly MayUse[], tracked: readonly string[]): EslintEdges {
  const allowedInternalImports: Record<string, string[]> = {}
  const allowedFactoryImports: Record<string, string[]> = {}
  for (const edges of [...mayUse].sort((left, right) => left.module.localeCompare(right.module))) {
    const target = targetOf(edges.module, tracked) ?? `${SOURCE_ROOT}/${edges.module}`
    allowedInternalImports[target] = [...edges.may_use]
    if (edges.may_use_factory.length > 0)
      allowedFactoryImports[target] = [...edges.may_use_factory]
    for (const within of Object.keys(edges.may_use_factory_within).sort())
      allowedFactoryImports[`${target}/${within}`] = [...edges.may_use_factory, ...edges.may_use_factory_within[within]!]
  }
  const core = Object.values(allowedFactoryImports).flat().filter(entry => entry.startsWith(FACTORY_CORE))
  return { allowedInternalImports, coreFilesSrcMayImport: [...new Set(core)].sort(), allowedFactoryImports }
}

export function renderEslintEdges(edges: EslintEdges): string {
  return `${JSON.stringify(edges, null, 2)}\n`
}

export function moduleFilesOf(modules: readonly ModuleDeclaration[], tracked: readonly string[]): Record<string, string[]> {
  const files: Record<string, string[]> = Object.fromEntries([...modules].map(module => module.module).sort().map(name => [name, []]))
  for (const file of [...tracked].sort()) {
    const { owner } = ownershipOf(modules, file)
    if (owner !== null)
      files[owner]!.push(file)
  }
  return files
}

export function renderModuleFiles(files: Readonly<Record<string, readonly string[]>>): string {
  return `${JSON.stringify(files, null, 2)}\n`
}

export function trackedFrom(listing: string, exists: (file: string) => boolean): string[] {
  return [...new Set(listing.split('\n').map(line => line.trim()).filter(line => line !== ''))].filter(exists).sort()
}

async function standardInput(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of process.stdin)
    chunks.push(String(chunk))
  return chunks.join('')
}

async function main(): Promise<void> {
  const tracked = [...new Set([...trackedFrom(await standardInput(), file => existsSync(path.join(REPO_ROOT, file))), MODULE_FILES, ESLINT_EDGES])].sort()
  const declarations = readDeclarations(REPO_ROOT)
  const problems = validateDeclarations(declarations, tracked)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
    return
  }
  writeFileSync(path.join(REPO_ROOT, MODULE_FILES), renderModuleFiles(moduleFilesOf(declarations.modules, tracked)))
  writeFileSync(path.join(REPO_ROOT, ESLINT_EDGES), renderEslintEdges(eslintEdgesOf(declarations.mayUse, tracked)))
}

if (realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main()
