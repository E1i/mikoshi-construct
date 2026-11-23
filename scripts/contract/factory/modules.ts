import type { ModuleDeclaration } from '../../core/declarations.js'
import type { Concept } from './concepts.js'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { declarationFileOf, readDeclarations } from '../../core/declarations.js'
import { FACTORY_ROOT, FACTORY_WORKERS } from '../../core/factory-paths.js'
import { commandLine, GENERATED_FILES } from '../../core/generated-files.js'
import { CONCEPTS } from './concepts.js'
import { MODULE_OWNS } from './module-owns.js'

export const MODULE_STATUSES = ['decided', 'undecided', 'tool'] as const

export type ModuleStatus = typeof MODULE_STATUSES[number]

export interface ModuleSpec {
  owns: readonly string[]
  contract: readonly string[]
  may_use: readonly string[]
  status: ModuleStatus
}

export const EXCLUSION_KINDS = ['tests', 'fixtures', 'templates', 'generated', 'tooling'] as const

export type ExclusionKind = typeof EXCLUSION_KINDS[number]

export interface ModuleGraphSpec {
  modules: Readonly<Record<string, ModuleSpec>>
  composition_roots: readonly string[]
  composition_imports: Readonly<Record<string, readonly string[]>>
  exclusions: Readonly<Record<ExclusionKind, readonly string[]>>
}

export const SOURCE_TREES = ['src', FACTORY_ROOT] as const

export const CARVED_OUT = '!'

const ANY_DEPTH = '/**'

const factory = (entry: string): string => `${FACTORY_ROOT}/${entry}`
const tree = (entry: string): string => `${factory(entry)}${ANY_DEPTH}`

const within = (folder: string, ...names: string[]): string[] => names.map(name => `${folder}/${name}`)
const core = (...names: string[]): string[] => within(factory('core'), ...names)
const supervisor = (...names: string[]): string[] => within(factory('supervisor'), ...names.map(name => `${name}.ts`))

const BUS_CONTRACT = core('db.ts', 'sqlite.ts', 'queue.ts', 'dependency-wait.ts', 'lease.ts', 'node.ts', 'stored.ts', 'errors.ts', 'bus-path.ts', 'bus-readings.ts', 'bus-version.ts', 'reducer.ts', 'every.ts', 'watermark.ts', 'events-query.ts', 'tasks-query.ts', 'entry.ts', 'observations.ts', 'task-must-wait.ts', 'bus-adapter.ts')

const SESSION_CONTRACT = [
  ...core('machine-sessions.ts', 'eddies.ts', 'journal.ts', 'tasks.ts', 'handoff-dir.ts', 'handoff-fields.ts', 'handoff-status.ts', 'chain.ts', 'places.ts', 'report.ts', 'legacy-history.ts', 'import-closure.ts', 'cadence.ts'),
  'src/card/closed.ts',
  factory('cli/slot.ts'),
  'src/commands/liveness.ts',
  ...supervisor('bg', 'heartbeat', 'liveness-sites', 'scheduler', 'stamp', 'supervisor', 'workers'),
]

export const COMPOSITION_MODULE = factory('supervisor/composition.ts')

export const COMPOSITION_ROOTS: readonly string[] = ['src/cli.ts', 'src/program.ts', factory('window/miko.ts'), factory('intake/intake.ts'), factory('supervisor/start.ts'), factory('supervisor/netwatch-root.ts'), COMPOSITION_MODULE]

export const OWNS_ARE_THE_CONTRACT = 'owns'

export interface DrawnModule {
  contract: readonly string[] | typeof OWNS_ARE_THE_CONTRACT
  may_use: readonly string[]
  status: ModuleStatus
}

const NODE_MAY_USE = ['bus', 'session', 'card-model', 'card-record', 'pr-record', 'plan', 'command-registry', 'ports-adapters', 'events']

function node(name: string, alsoUses: readonly string[] = []): DrawnModule {
  return { contract: [factory(`nodes/${name}/${name}-worker.ts`)], may_use: [...NODE_MAY_USE, ...alsoUses], status: 'decided' }
}

function decided(may_use: readonly string[]): DrawnModule {
  return { contract: OWNS_ARE_THE_CONTRACT, may_use, status: 'decided' }
}

function undecided(may_use: readonly string[] = []): DrawnModule {
  return { contract: [], may_use, status: 'undecided' }
}

const TOOL: DrawnModule = { contract: [], may_use: [], status: 'tool' }

export function isTool(spec: ModuleSpec | undefined): boolean {
  return spec?.status === 'tool'
}

const OWNER_COMMANDS_READER = ['command-registry']

export const DRAWN: Readonly<Record<string, DrawnModule>> = {
  'bus': { contract: BUS_CONTRACT, may_use: ['events'], status: 'decided' },
  'session': { contract: SESSION_CONTRACT, may_use: ['bus', 'card-model', 'card-record', 'command-registry', 'ports-adapters', 'events', 'order'], status: 'decided' },
  'card-model': decided([]),
  'card-record': decided(['bus', 'card-model', 'command-registry', 'events', 'ports']),
  'plan': decided(['card-model', 'card-record', 'events']),
  'pr-record': decided(['bus', 'events']),
  'command-registry': decided([]),
  'ports-adapters': decided([]),
  'node-answer': node('answer'),
  'node-close': node('close'),
  'node-launch': node('launch', ['order']),
  'node-merge': node('merge'),
  'node-restart': node('restart'),
  'node-review': node('review'),
  'node-update': node('update'),
  'node-witness': node('witness'),
  'node-laws': undecided(),
  'events': decided([]),
  'order': decided(['layout', 'bus', 'events']),
  'layout': undecided(),
  'decisions': undecided(),
  'rules': undecided(),
  'quality': undecided(),
  'intake': undecided(OWNER_COMMANDS_READER),
  'cost': undecided(),
  'ports': undecided(),
  'window': undecided([...OWNER_COMMANDS_READER, 'order']),
  'board': undecided(OWNER_COMMANDS_READER),
  'release': undecided(),
  'factory-contract': undecided(),
  'contract-generator': TOOL,
  'project': undecided(OWNER_COMMANDS_READER),
  'model': undecided(),
  'atlas': undecided(OWNER_COMMANDS_READER),
  'ui': undecided(OWNER_COMMANDS_READER),
}

export function drawnWithOwns(owns: Readonly<Record<string, readonly string[]>>, drawn: Readonly<Record<string, DrawnModule>> = DRAWN): Record<string, ModuleSpec> {
  return Object.fromEntries(Object.entries(drawn).map(([id, { contract, may_use, status }]) => {
    const held = owns[id] ?? []
    return [id, { owns: held, contract: contract === OWNS_ARE_THE_CONTRACT ? held : contract, may_use, status }]
  }))
}

function isFolderGlob(glob: string): boolean {
  return glob.endsWith(ANY_DEPTH)
}

function insideFolder(glob: string, file: string): boolean {
  return file.startsWith(glob.slice(0, -ANY_DEPTH.length + 1))
}

export function matchesGlob(glob: string, file: string): boolean {
  return isFolderGlob(glob) ? insideFolder(glob, file) : file === glob
}

export function heldBy(globs: readonly string[], file: string): boolean {
  const carved = globs.filter(glob => glob.startsWith(CARVED_OUT)).map(glob => glob.slice(CARVED_OUT.length))
  return !carved.includes(file) && globs.some(glob => !glob.startsWith(CARVED_OUT) && matchesGlob(glob, file))
}

function namedFiles(modules: Readonly<Record<string, ModuleSpec>>): Map<string, string> {
  const named = new Map<string, string>(COMPOSITION_ROOTS.map(file => [file, '']))
  for (const [id, { owns }] of Object.entries(modules)) {
    for (const glob of owns.filter(glob => !isFolderGlob(glob)))
      named.set(glob, id)
  }
  return named
}

export function carvedOut(modules: Readonly<Record<string, ModuleSpec>>): Record<string, ModuleSpec> {
  const named = [...namedFiles(modules)]
  return Object.fromEntries(Object.entries(modules).map(([id, spec]) => {
    const taken = spec.owns.filter(isFolderGlob).flatMap(folder => named.filter(([file, holder]) => holder !== id && insideFolder(folder, file)).map(([file]) => `${CARVED_OUT}${file}`))
    return [id, taken.length === 0 ? spec : { ...spec, owns: [...spec.owns, ...taken.sort()] }]
  }))
}

export const EXCLUSIONS: Readonly<Record<ExclusionKind, readonly string[]>> = {
  tests: [tree('tests')],
  fixtures: [],
  templates: [tree('construct')],
  generated: [],
  tooling: [tree('scratch')],
}

const DECLARED_FOLDER = '/'
const DECLARED_PATTERN = '*'

function inSourceTree(entry: string): boolean {
  return SOURCE_TREES.some(root => entry.startsWith(`${root}${DECLARED_FOLDER}`))
}

function graphGlobOf(entry: string): string {
  return entry.endsWith(DECLARED_FOLDER) ? `${entry.slice(0, -DECLARED_FOLDER.length)}${ANY_DEPTH}` : entry
}

function heldByAnExclusion(glob: string): boolean {
  return Object.values(EXCLUSIONS).flat().some(exclusion => exclusion === glob || (isFolderGlob(exclusion) && insideFolder(exclusion, glob)))
}

export interface DerivedOwns {
  owns: Record<string, string[]>
  problems: string[]
}

export function moduleOwnsOf(declarations: readonly ModuleDeclaration[]): DerivedOwns {
  const owns: Record<string, string[]> = {}
  const problems: string[] = []
  for (const declared of [...declarations].sort((left, right) => left.module.localeCompare(right.module))) {
    const at = declarationFileOf(declared.module)
    for (const entry of declared.exclude.filter(inSourceTree))
      problems.push(`${at}: exclude entry "${entry}" lies in a source tree, and the module graph carves out only files another module names`)
    for (const entry of [...declared.paths, ...declared.shared].filter(inSourceTree).filter(entry => entry.includes(DECLARED_PATTERN)))
      problems.push(`${at}: "${entry}" is a pattern, and the module graph holds only files and whole folders`)
    const held = [...declared.paths, ...declared.shared]
      .filter(entry => inSourceTree(entry) && !entry.includes(DECLARED_PATTERN) && !COMPOSITION_ROOTS.includes(entry))
      .map(graphGlobOf)
      .filter(glob => !heldByAnExclusion(glob))
    if (held.length > 0)
      owns[declared.module] = held
  }
  return { owns, problems }
}

const GRAPH_SOURCE = 'the hand-drawn part of the module graph'

export function moduleOwnershipProblems(generated: Readonly<Record<string, readonly string[]>>, declarations: readonly ModuleDeclaration[], drawn: Readonly<Record<string, DrawnModule>> = DRAWN): string[] {
  const { owns, problems } = moduleOwnsOf(declarations)
  const rebuild = commandLine(GENERATED_FILES.moduleOwns.rebuild)
  const ids = [...new Set([...Object.keys(owns), ...Object.keys(generated)])].sort()
  const stale = ids
    .filter(id => JSON.stringify(owns[id] ?? []) !== JSON.stringify(generated[id] ?? []))
    .map(id => `${GENERATED_FILES.moduleOwns.path}: the owns of ${id} differ from ${declarationFileOf(id)}; run ${rebuild}`)
  const undrawn = Object.keys(owns).filter(id => !(id in drawn)).map(id => `${declarationFileOf(id)} gives ${id} source files, and ${GRAPH_SOURCE} draws no ${id}`)
  const undeclared = Object.keys(drawn).filter(id => !(id in owns)).map(id => `${GRAPH_SOURCE} draws ${id}, and no declaration gives it a source file`)
  return [...problems, ...stale, ...undrawn, ...undeclared]
}

const QUOTE = '\''

export function renderModuleOwns(owns: Readonly<Record<string, readonly string[]>>): string {
  const quoted = (text: string): string => `${QUOTE}${text}${QUOTE}`
  const underFactory = `${FACTORY_ROOT}/`
  const entry = (glob: string): string => glob.startsWith(underFactory) ? `\`\${FACTORY_ROOT}/${glob.slice(underFactory.length)}\`` : quoted(glob)
  const rows = Object.keys(owns).sort().map(id => [`  ${quoted(id)}: [`, ...owns[id]!.map(glob => `    ${entry(glob)},`), '  ],'].join('\n'))
  return `import { FACTORY_ROOT } from '../../core/factory-paths.js'\n\nexport const MODULE_OWNS: Readonly<Record<string, readonly string[]>> = {\n${rows.join('\n')}\n}\n`
}

export const MODULES: Readonly<Record<string, ModuleSpec>> = carvedOut(drawnWithOwns(MODULE_OWNS))

const WORKER_FILE = /-worker\.ts$/
const WORKER_ENTRIES = [...Object.values(FACTORY_WORKERS).filter(file => WORKER_FILE.test(file)), ...Object.values(FACTORY_WORKERS).filter(file => !WORKER_FILE.test(file))]

const PROCESS_ROOTS = [...supervisor('start', 'run', 'supervisor', 'review-bg', 'netwatch-root'), ...core('report.ts', 'reducer.ts'), ...WORKER_ENTRIES, factory('window/handoff-write.ts'), factory('owner/inbox.ts')]

export const COMPOSITION_IMPORTS: Readonly<Record<string, readonly string[]>> = { [COMPOSITION_MODULE]: PROCESS_ROOTS }

export const MODULE_GRAPH: ModuleGraphSpec = { modules: MODULES, composition_roots: COMPOSITION_ROOTS, composition_imports: COMPOSITION_IMPORTS, exclusions: EXCLUSIONS }

export interface FactoryModule extends ModuleSpec {
  concepts: string[]
}

export interface ModulesSection extends Omit<ModuleGraphSpec, 'modules'> {
  modules: Record<string, FactoryModule>
}

export const FACTORY_CONTRACT = 'contract/factory.json'

const FOLDER_ENTRY = 'index.ts'

function ownerFile(owner: string): string {
  return owner.endsWith('/') ? `${owner}${FOLDER_ENTRY}` : owner
}

export function graphOfSection({ modules, composition_roots, composition_imports, exclusions }: ModulesSection): ModuleGraphSpec {
  return {
    modules: Object.fromEntries(Object.entries(modules).map(([id, { concepts: _heldInTheSection, ...spec }]) => [id, spec])),
    composition_roots,
    composition_imports,
    exclusions,
  }
}

export function modulesSection(graph: ModuleGraphSpec = MODULE_GRAPH, concepts: readonly Pick<Concept, 'id' | 'owner'>[] = CONCEPTS): ModulesSection {
  return {
    ...graph,
    modules: Object.fromEntries(Object.entries(graph.modules).map(([id, spec]) => [
      id,
      { ...spec, concepts: concepts.filter(concept => heldBy(spec.owns, ownerFile(concept.owner))).map(concept => concept.id).sort() },
    ])),
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

export function writeModuleOwns(root: string = REPO_ROOT): string[] {
  const declarations = readDeclarations(root)
  const { owns, problems } = moduleOwnsOf(declarations.modules)
  const found = [...declarations.problems, ...problems]
  if (found.length === 0)
    writeFileSync(path.join(root, GENERATED_FILES.moduleOwns.path), renderModuleOwns(owns))
  return found
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refused = writeModuleOwns(process.argv[2] ?? REPO_ROOT)
  if (refused.length > 0) {
    console.error(refused.join('\n'))
    process.exitCode = 1
  }
}
