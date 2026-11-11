import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const IMPORT_KINDS = ['import', 'type', 're-export', 'dynamic'] as const

export type ImportKind = typeof IMPORT_KINDS[number]

export interface ImportEdge {
  from: string
  to: string
  kinds: ImportKind[]
}

export type PathAliases = Readonly<Record<string, readonly string[]>>

const CODE_FILE = /\.(?:ts|mts|cts|mjs|cjs|js)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const TS_TWIN: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
const BARE_SUFFIXES = ['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js']
const ALIAS_WILDCARD = '*'
const TSCONFIGS = ['tsconfig.json', 'tsconfig.base.json']

interface Specifier {
  text: string
  kind: ImportKind
}

export function isCodeFile(file: string): boolean {
  return CODE_FILE.test(file) && !DECLARATION_FILE.test(file)
}

function literalOf(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

function importKind(node: ts.ImportDeclaration): ImportKind {
  const clause = node.importClause
  if (clause === undefined)
    return 'import'
  if (clause.isTypeOnly)
    return 'type'
  const named = clause.namedBindings
  const allTypes = clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly)
  return allTypes ? 'type' : 'import'
}

function specifierOf(node: ts.Node): Specifier | undefined {
  if (ts.isImportDeclaration(node)) {
    const text = literalOf(node.moduleSpecifier)
    return text === undefined ? undefined : { text, kind: importKind(node) }
  }
  if (ts.isExportDeclaration(node)) {
    const text = literalOf(node.moduleSpecifier)
    return text === undefined ? undefined : { text, kind: 're-export' }
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const text = literalOf(node.moduleReference.expression)
    return text === undefined ? undefined : { text, kind: node.isTypeOnly ? 'type' : 'import' }
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const text = literalOf(node.arguments[0])
    return text === undefined ? undefined : { text, kind: 'dynamic' }
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    const text = literalOf(node.argument.literal)
    return text === undefined ? undefined : { text, kind: 'type' }
  }
  return undefined
}

export function specifiersIn(file: string, text: string): Specifier[] {
  const found: Specifier[] = []
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node)
    if (specifier !== undefined)
      found.push(specifier)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
  return found
}

function candidates(target: string): string[] {
  const extension = path.posix.extname(target)
  const twins = (TS_TWIN[extension] ?? []).map(twin => `${target.slice(0, -extension.length)}${twin}`)
  return [target, ...twins, ...BARE_SUFFIXES.map(suffix => `${target}${suffix}`)]
}

function aliasTargets(specifier: string, aliases: PathAliases): string[] {
  return Object.entries(aliases).flatMap(([pattern, targets]) => {
    const star = pattern.indexOf(ALIAS_WILDCARD)
    if (star < 0)
      return pattern === specifier ? [...targets] : []
    const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)]
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length)
      return []
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
    return targets.map(target => target.replace(ALIAS_WILDCARD, captured))
  })
}

export function resolveSpecifier(from: string, specifier: string, files: ReadonlySet<string>, aliases: PathAliases = {}): string | undefined {
  const bases = specifier.startsWith('.')
    ? [path.posix.join(path.posix.dirname(from), specifier)]
    : aliasTargets(specifier, aliases).map(target => path.posix.normalize(target))
  return bases.flatMap(candidates).find(candidate => files.has(candidate))
}

function aliasesOf(root: string, config: string): PathAliases {
  const file = path.join(root, config)
  if (!existsSync(file))
    return {}
  const { config: parsed } = ts.readConfigFile(file, ts.sys.readFile) as { config?: { compilerOptions?: { baseUrl?: string, paths?: Record<string, string[]> } } }
  const options = parsed?.compilerOptions
  const base = options?.baseUrl ?? '.'
  return Object.fromEntries(Object.entries(options?.paths ?? {}).map(([pattern, targets]) => [pattern, targets.map(target => path.posix.join(base, target))]))
}

export function readAliases(root: string): PathAliases {
  return Object.assign({}, ...TSCONFIGS.map(config => aliasesOf(root, config)).reverse()) as PathAliases
}

export function buildImportGraph(root: string, files: readonly string[], importers: readonly string[], aliases: PathAliases = readAliases(root)): ImportEdge[] {
  const known = new Set(files)
  const edges = new Map<string, ImportEdge>()
  for (const from of [...importers].filter(isCodeFile).sort()) {
    for (const { text, kind } of specifiersIn(from, readFileSync(path.join(root, from), 'utf8'))) {
      const to = resolveSpecifier(from, text, known, aliases)
      if (to === undefined || to === from)
        continue
      const key = `${from}\n${to}`
      const edge = edges.get(key) ?? { from, to, kinds: [] }
      if (!edge.kinds.includes(kind))
        edge.kinds.push(kind)
      edges.set(key, edge)
    }
  }
  return [...edges.values()]
    .map(edge => ({ ...edge, kinds: IMPORT_KINDS.filter(kind => edge.kinds.includes(kind)) }))
    .sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to))
}

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
