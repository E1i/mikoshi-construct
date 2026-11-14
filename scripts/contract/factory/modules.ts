import type { Concept } from './concepts.js'
import { FACTORY_ROOT } from '../../core/factory-paths.js'
import { CONCEPTS } from './concepts.js'

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
const card = (...names: string[]): string[] => within('src/card', ...names.map(name => `${name}.ts`))
const intake = (...names: string[]): string[] => within(factory('intake'), ...names.map(name => `${name}.ts`))
const review = (...names: string[]): string[] => within(factory('nodes/review'), ...names.map(name => `${name}.ts`))
const supervisor = (...names: string[]): string[] => within(factory('supervisor'), ...names.map(name => `${name}.ts`))
const cli = (...names: string[]): string[] => within(factory('cli'), ...names)

const BUS_CONTRACT = core('db.ts', 'sqlite.ts', 'queue.ts', 'dependency-wait.ts', 'lease.ts', 'node.ts', 'stored.ts', 'errors.ts', 'bus-path.ts', 'bus-readings.ts', 'bus-version.ts', 'reducer.ts', 'every.ts', 'watermark.ts', 'entry.ts', 'observations.ts', 'task-must-wait.ts')
const BUS_IMPL = core('projection-writes.ts', 'projection-writes.known.json', 'rejection.ts')

const SESSION_FILES = [
  ...core('machine-sessions.ts', 'eddies.ts', 'journal.ts', 'tasks.ts', 'handoff-dir.ts', 'handoff-fields.ts', 'handoff-status.ts', 'card-automaton.ts', 'card-hold.ts', 'chain.ts', 'places.ts', 'report.ts', 'legacy-history.ts', 'import-closure.ts'),
  ...card('closed'),
  ...cli('slot.ts'),
  'src/commands/liveness.ts',
]
const SESSION_CONTRACT = [...SESSION_FILES, ...supervisor('bg', 'heartbeat', 'liveness-sites', 'scheduler', 'stamp', 'supervisor', 'workers')]

const CARD_MODEL = [...card('grammar', 'parking', 'task-file', 'risk', 'complexity'), ...intake('card-contract'), ...core('identifiers.ts')]
const CARD_RECORD = [...core('card-bodies.ts', 'backfill-source.ts'), ...card('text-sha', 'witness-fields'), ...intake('admissions', 'card-archive', 'witness-fields-backfill', 'slice-parent-backfill'), ...cli('card.ts')]
const PLAN = [factory('window/plan-export.ts'), ...cli('card-chain.ts'), ...card('slice-depends')]
const PORTS_ADAPTERS = within(factory('ports'), 'git.ts', 'disk.ts', 'prompt-store.ts', 'client/contract.ts', 'client/codex/adapter.ts')
const PR_RECORD = [...review('pr-close', 'pr-reopen', 'pr-rerun', 'record-verdict', 'dry-run-record'), ...core('merge-event.ts')]

export const COMPOSITION_MODULE = factory('supervisor/composition.ts')

export const COMPOSITION_ROOTS: readonly string[] = ['src/cli.ts', 'src/program.ts', factory('window/miko.ts'), factory('intake/intake.ts'), factory('supervisor/start.ts'), COMPOSITION_MODULE]

const NODE_MAY_USE = ['bus', 'session', 'card-model', 'card-record', 'pr-record', 'plan', 'command-registry', 'ports-adapters', 'events']

function node(name: string): ModuleSpec {
  const folder = factory(`nodes/${name}`)
  return { owns: [`${folder}${ANY_DEPTH}`], contract: [`${folder}/${name}-worker.ts`], may_use: NODE_MAY_USE, status: 'decided' }
}

function decided(owns: readonly string[], may_use: readonly string[]): ModuleSpec {
  return { owns, contract: owns, may_use, status: 'decided' }
}

function undecided(owns: readonly string[], may_use: readonly string[] = []): ModuleSpec {
  return { owns, contract: [], may_use, status: 'undecided' }
}

function tool(owns: readonly string[]): ModuleSpec {
  return { owns, contract: [], may_use: [], status: 'tool' }
}

export function isTool(spec: ModuleSpec | undefined): boolean {
  return spec?.status === 'tool'
}

const OWNER_COMMANDS_READER = ['command-registry']

const DRAWN: Readonly<Record<string, ModuleSpec>> = {
  'bus': { owns: [...BUS_CONTRACT, ...BUS_IMPL], contract: BUS_CONTRACT, may_use: ['events'], status: 'decided' },
  'session': { owns: [...SESSION_FILES, tree('supervisor')], contract: SESSION_CONTRACT, may_use: ['bus', 'card-model', 'card-record', 'command-registry', 'ports-adapters', 'events', 'order'], status: 'decided' },
  'card-model': decided(CARD_MODEL, []),
  'card-record': decided(CARD_RECORD, ['bus', 'card-model', 'events']),
  'plan': decided(PLAN, ['card-model', 'card-record', 'events']),
  'pr-record': decided(PR_RECORD, ['bus', 'events']),
  'command-registry': decided(core('owner-commands.ts'), []),
  'ports-adapters': decided(PORTS_ADAPTERS, []),
  'node-answer': node('answer'),
  'node-close': node('close'),
  'node-launch': node('launch'),
  'node-merge': node('merge'),
  'node-restart': node('restart'),
  'node-review': node('review'),
  'node-update': node('update'),
  'node-witness': node('witness'),
  'node-laws': undecided([factory('nodes/laws.ts')]),
  'events': decided(core('events.ts'), []),
  'order': decided([tree('core/order')], ['layout', 'bus', 'events']),
  'layout': undecided(core('factory-paths.ts', 'generated-files.ts', 'declarations.ts')),
  'decisions': undecided([...core('inbox.ts', 'card-decisions.ts'), ...within(factory('policy'), 'live-decision.ts', `decisions${ANY_DEPTH}`), tree('owner')]),
  'rules': undecided([...within(factory('policy'), 'policy.ts', `morse${ANY_DEPTH}`, 'repeat-finding.ts', 'round-limit-decision.ts', 'shard.ts', 'shards.ts', `shredder${ANY_DEPTH}`, 'widening.ts', 'touch-scope.ts'), tree('morse'), ...core('push-policy.ts')]),
  'quality': undecided([...core('layer-map.ts', 'layer-map.json', 'verification.ts'), ...cli('check-catalog.ts', 'check-matrix.ts', 'mutate.ts', 'no-layer-recount.ts'), tree('ci'), tree('quality'), tree('privacy'), `src/commands/ci${ANY_DEPTH}`, `src/commands/mutate${ANY_DEPTH}`, 'src/commands/test-runner.ts', ...card('covering-tests')]),
  'intake': undecided([tree('intake'), `src/commands/intake${ANY_DEPTH}`], OWNER_COMMANDS_READER),
  'cost': undecided([tree('ladder'), tree('done'), `src/commands/cost${ANY_DEPTH}`]),
  'ports': undecided([tree('ports'), ...core('gh-callers.ts', 'gh-callers.known.json')]),
  'window': undecided([tree('window'), tree('conveyor')], [...OWNER_COMMANDS_READER, 'order']),
  'board': undecided([...cli('board-page.ts', `board-page${ANY_DEPTH}`, 'board-warnings.ts'), `src/commands/board${ANY_DEPTH}`], OWNER_COMMANDS_READER),
  'release': undecided([tree('release'), tree('release-notes'), tree('docs'), 'src/commands/run-record.ts']),
  'factory-contract': undecided([factory('contract/contours.ts')]),
  'contract-generator': tool([tree('contract')]),
  'project': undecided([
    ...within('src/commands', `attach${ANY_DEPTH}`, `detach${ANY_DEPTH}`, `doctor${ANY_DEPTH}`, `sync${ANY_DEPTH}`, 'graph.ts', 'init.ts', 'soulkill.ts'),
    ...within('src', `detect${ANY_DEPTH}`, 'manifest.ts', `materialize${ANY_DEPTH}`, `presets${ANY_DEPTH}`, 'record-ahead.ts', `sync${ANY_DEPTH}`, 'failure.ts', 'known-flags.ts', 'version.ts'),
    tree('composition'),
    tree('harness-command'),
    tree('attach'),
  ], OWNER_COMMANDS_READER),
  'model': undecided([`src/model${ANY_DEPTH}`, tree('model')]),
  'atlas': undecided([`src/atlas${ANY_DEPTH}`, tree('atlas')], OWNER_COMMANDS_READER),
  'ui': undecided([`src/ui${ANY_DEPTH}`], OWNER_COMMANDS_READER),
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

export const MODULES: Readonly<Record<string, ModuleSpec>> = carvedOut(DRAWN)

export const EXCLUSIONS: Readonly<Record<ExclusionKind, readonly string[]>> = {
  tests: [tree('tests')],
  fixtures: [],
  templates: [tree('construct')],
  generated: [],
  tooling: [tree('scratch')],
}

const WORKER_ENTRIES = [...['answer', 'close', 'merge', 'restart', 'review', 'update', 'witness'].map(name => factory(`nodes/${name}/${name}-worker.ts`)), factory('nodes/launch/launch-root.ts')]

const PROCESS_ROOTS = [...supervisor('start', 'run', 'supervisor', 'review-bg'), ...core('report.ts', 'reducer.ts'), ...WORKER_ENTRIES, factory('window/handoff-write.ts')]

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
