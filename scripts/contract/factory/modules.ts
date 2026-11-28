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

const BUS_CONTRACT = [
  ...core('db.ts', 'sqlite.ts', 'queue.ts', 'dependency-wait.ts', 'lease.ts', 'node.ts', 'stored.ts', 'bus-readings.ts', 'bus-version.ts', 'reducer.ts', 'every.ts', 'watermark.ts', 'events-query.ts', 'tasks-query.ts', 'entry.ts', 'observations.ts', 'task-must-wait.ts', 'bus-adapter.ts', 'identifiers.ts'),
  ...within(factory('ports'), 'bus-read.ts', 'worktree-home.ts'),
]

const SESSION_CONTRACT = [
  ...core('machine-sessions.ts', 'eddies.ts', 'journal.ts', 'tasks.ts', 'handoff-dir.ts', 'handoff-fields.ts', 'handoff-status.ts', 'chain.ts', 'places.ts', 'report.ts', 'legacy-history.ts', 'import-closure.ts', 'cadence.ts'),
  factory('intake/witness-fields-backfill.ts'),
  ...within(factory('window'), 'eddies-measure.ts', 'handoff-check.ts'),
  factory('nodes/launch/continuation.ts'),
  factory('nodes/restart/chain-process.ts'),
  factory('ports/result.ts'),
  factory('quality/lock.ts'),
  factory('cli/slot.ts'),
  'src/commands/liveness.ts',
  ...supervisor('bg', 'heartbeat', 'liveness-sites', 'scheduler', 'stamp', 'workers'),
]

const INTAKE_COMMAND = 'src/commands/intake'
const CI_COMMAND = 'src/commands/ci'

const INTAKE_CONTRACT = [
  factory('intake/bus-intake.ts'),
  ...within(INTAKE_COMMAND, 'admit.ts', 'amend.ts', 'bash-syntax.ts', 'check.ts', 'confirm.ts', 'draft.ts', 'export.ts', 'facts.ts', 'index.ts', 'move.ts', 'numbers.ts', 'parking-tree.ts', 'shared-code-masks.ts', 'slice.ts'),
]

const QUALITY_CI = tree('ci')
const QUALITY_FOLDER = tree('quality')

const QUALITY_CONTRACT = [
  ...(MODULE_OWNS.quality ?? []).filter(glob => glob !== QUALITY_CI && glob !== QUALITY_FOLDER),
  ...within(factory('quality'), 'foreign-table-sql-excepted.json', 'real-time-waits-excepted.json', 'table-owners.json', 'witness-records.ts'),
  ...within(factory('ci'), 'browser-tests-ran.mjs', 'card-automaton.ts', 'card-runs.ts', 'classify.ts', 'fast-path.ts', 'file-weights-reporter.ts', 'gate-mutations.ts', 'gate-runs.ts', 'layers.ts', 'no-match-reporter.ts', 'prepush.ts', 'sandbox-failing.jsonl', 'sandbox-failing.ts', 'sandbox-liveness.ts', 'sandbox-refusals.ts', 'sandbox-trace-child.mjs', 'sandbox-trace.config.ts', 'sandbox-trace.ts', 'select.ts', 'shard.ts', 'test-command.ts', 'test-weights.json', 'test-weights.ts', 'tree-scanners.ts', 'verdict.ts', 'vitest-report.ts', 'weights-law.ts'),
]

const PORTS_CONTRACT = [
  ...within(factory('ports'), 'card-grants.ts', 'ci-reading.ts', 'client/claude/adapter.ts', 'client/index.ts', 'diff.ts', 'gh.ts', 'github-status.ts', 'github.ts', 'identifier-shapes.ts', 'isolation.ts', 'main-merge.ts', 'meter.ts', 'process-table.ts', 'review-planner.ts', 'session.ts', 'snapshot.ts', 'task-start.ts', 'tree-publish.ts', 'wide-vitest-guard.ts', 'worktree.ts'),
  ...core('bus-contract.ts', 'process-listing.ts'),
  factory('ci/required.ts'),
  'src/client-record.ts',
  `${CI_COMMAND}/state.ts`,
  `${INTAKE_COMMAND}/command-word.ts`,
]

const WINDOW_CONTRACT = [...within(factory('window'), 'board.ts', 'loop.ts', 'tab.ts', 'takeover-push-release.ts', 'watch.ts', 'window-heartbeat.ts', 'window-prs.ts', 'window-request-tools.ts', 'window-requests.ts', 'window-session-end.ts', 'window-subagents.ts'), factory('policy/decisions/window-door.ts'), factory('supervisor/window-subagent-tick.ts'), 'src/commands/board/goal.ts']

const UI_CONTRACT = within('src/ui', 'console.ts', 'expect-lore.ts', 'lore.ts', 'signal.ts', 'theme.ts')

export const COMPOSITION_MODULE = factory('supervisor/composition.ts')

export const COMPOSITION_ROOTS: readonly string[] = ['src/cli.ts', 'src/program.ts', factory('window/miko.ts'), factory('intake/intake.ts'), factory('supervisor/start.ts'), factory('supervisor/run.ts'), factory('supervisor/review-bg.ts'), factory('supervisor/supervisor.ts'), factory('supervisor/reducer-thread.ts'), factory('supervisor/launchd/install.ts'), factory('supervisor/netwatch-root.ts'), factory('ports/netwatch.ts'), factory('cli/task-start.ts'), factory('policy/decisions/add.ts'), factory('owner/answer.ts'), COMPOSITION_MODULE]

export const OWNS_ARE_THE_CONTRACT = 'owns'

export interface DrawnModule {
  contract: readonly string[] | typeof OWNS_ARE_THE_CONTRACT
  may_use: readonly string[]
  status: ModuleStatus
}

interface Layer {
  modules: readonly string[]
  ordered: boolean
}

const NODES = ['node-answer', 'node-close', 'node-launch', 'node-merge', 'node-restart', 'node-review', 'node-update', 'node-witness']

const LAYERS: readonly Layer[] = [
  { modules: ['layout', 'command-registry', 'ui', 'ports-adapters', 'ports'], ordered: true },
  { modules: ['events', 'bus'], ordered: true },
  { modules: ['card-model', 'card-record', 'project', 'plan', 'order', 'decisions', 'session', 'model', 'quality', 'intake', 'rules', 'pr-record', 'factory-contract'], ordered: true },
  { modules: NODES, ordered: false },
  { modules: ['cli', 'atlas', 'release', 'cost', 'window', 'board'], ordered: true },
]

function belowInTheLayers(id: string): string[] {
  const at = LAYERS.findIndex(layer => layer.modules.includes(id))
  if (at < 0)
    throw new Error(`${id} is in no layer of the module graph`)
  const { modules, ordered } = LAYERS[at]!
  return [...LAYERS.slice(0, at).flatMap(layer => layer.modules), ...(ordered ? modules.slice(0, modules.indexOf(id)) : [])]
}

function node(name: string, ...alsoContract: string[]): DrawnModule {
  return { contract: [factory(`nodes/${name}/${name}-worker.ts`), ...alsoContract], may_use: belowInTheLayers(`node-${name}`), status: 'decided' }
}

function decided(id: string): DrawnModule {
  return { contract: OWNS_ARE_THE_CONTRACT, may_use: belowInTheLayers(id), status: 'decided' }
}

function decidedWith(id: string, contract: readonly string[]): DrawnModule {
  return { contract, may_use: belowInTheLayers(id), status: 'decided' }
}

const TOOL: DrawnModule = { contract: [], may_use: [], status: 'tool' }

export function isTool(spec: ModuleSpec | undefined): boolean {
  return spec?.status === 'tool'
}

export const DRAWN: Readonly<Record<string, DrawnModule>> = {
  'bus': decidedWith('bus', BUS_CONTRACT),
  'session': decidedWith('session', SESSION_CONTRACT),
  'card-model': decided('card-model'),
  'card-record': decided('card-record'),
  'plan': decided('plan'),
  'pr-record': decided('pr-record'),
  'command-registry': decided('command-registry'),
  'ports-adapters': decided('ports-adapters'),
  'node-answer': node('answer', factory('ports/card-tree.ts')),
  'node-close': node('close'),
  'node-launch': node('launch'),
  'node-merge': node('merge'),
  'node-restart': node('restart'),
  'node-review': node('review'),
  'node-update': node('update'),
  'node-witness': node('witness'),
  'node-laws': TOOL,
  'events': decided('events'),
  'order': decided('order'),
  'layout': decided('layout'),
  'decisions': decided('decisions'),
  'rules': decided('rules'),
  'quality': decidedWith('quality', QUALITY_CONTRACT),
  'intake': decidedWith('intake', INTAKE_CONTRACT),
  'cost': decided('cost'),
  'ports': decidedWith('ports', PORTS_CONTRACT),
  'window': decidedWith('window', WINDOW_CONTRACT),
  'board': decided('board'),
  'release': decided('release'),
  'factory-contract': decided('factory-contract'),
  'contract-generator': TOOL,
  'project': decided('project'),
  'cli': decided('cli'),
  'model': decided('model'),
  'atlas': decided('atlas'),
  'ui': decidedWith('ui', UI_CONTRACT),
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
    if (taken.length === 0)
      return [id, spec]
    const owns = [...spec.owns, ...taken.sort()]
    return [id, { ...spec, owns, contract: spec.contract === spec.owns ? owns : spec.contract }]
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
