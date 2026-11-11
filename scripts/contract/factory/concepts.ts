import type { Detector } from './detectors.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { FACTORY_NAMED, FACTORY_RUNTIME } from '../../core/factory-paths.js'
import { GENERATED_FILES, GENERATED_PATHS } from '../../core/generated-files.js'
import { BUS_TABLES } from '../../ports/bus-read.js'
import { clientAdapter } from '../../ports/client/index.js'
import {
  adjacentLiterals,
  called,
  calledOnARead,
  copiedProperty,
  declaredFunction,
  declaredIn,
  entriesOfTable,
  literal,
  outside,
  pidProbe,
  programCall,
  propertyRead,
  readOfAFileNamed,
  referenced,
  referencedRegex,
  regexLiteral,
} from './detectors.js'

export const AXES = ['autonomy', 'cost', 'self-learning', 'interface', 'architecture'] as const

export type Axis = typeof AXES[number]

interface BuiltOwner {
  ownerExists: true
  ownerExport: string
}

interface ProposedOwner {
  ownerExists: false
  ownerExport: null
}

export type Concept = {
  id: string
  title: string
  owner: string
  axis: Axis
  lore: string | null
  detectors: readonly Detector[]
} & (BuiltOwner | ProposedOwner)

function exportModifiers(statement: ts.Statement): { exported: boolean, isDefault: boolean } {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
  return {
    exported: modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    isDefault: modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  }
}

function namesExportedBy(statement: ts.Statement): string[] {
  if (ts.isExportAssignment(statement))
    return ['default']
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause
    if (clause === undefined)
      return []
    return ts.isNamedExports(clause) ? clause.elements.map(element => element.name.text) : [clause.name.text]
  }
  const { exported, isDefault } = exportModifiers(statement)
  if (!exported)
    return []
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))
    return [isDefault || statement.name === undefined ? 'default' : statement.name.text]
  return []
}

export function exportedNames(file: string): ReadonlySet<string> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  return new Set(source.statements.flatMap(namesExportedBy))
}

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile()
}

const FOLDER_ENTRY = 'index.ts'

function ownerModuleOf(owner: string): string {
  return owner.endsWith('/') ? `${owner}${FOLDER_ENTRY}` : owner
}

export function ownerExportFault(concept: Concept, root: string): string | null {
  if (!concept.ownerExists)
    return existsSync(path.join(root, concept.owner)) ? `${concept.id}: ${concept.owner} exists, so name the export it owns the concept by and set ownerExists true` : null
  const ownerModule = ownerModuleOf(concept.owner)
  const ownerPath = path.join(root, ownerModule)
  if (!isFile(ownerPath))
    return `${concept.id}: ownerExists is true but ${ownerModule} is not a file`
  return exportedNames(ownerPath).has(concept.ownerExport) ? null : `${concept.id}: ${ownerModule} does not export ${concept.ownerExport}`
}

export function assertOwnersExport(concepts: readonly Concept[], root: string): void {
  const faults = concepts.flatMap(concept => ownerExportFault(concept, root) ?? [])
  if (faults.length > 0)
    throw new Error(`a concept's owner exports the name it declares: ${faults.join('; ')}`)
}

export type LoreConflicts = Readonly<Record<string, readonly string[]>>

export function loreConflicts(concepts: readonly Pick<Concept, 'id' | 'lore'>[]): LoreConflicts {
  const holders = new Map<string, string[]>()
  for (const { id, lore } of concepts) {
    if (lore !== null)
      holders.set(lore, [...holders.get(lore) ?? [], id])
  }
  return Object.fromEntries([...holders].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => a.localeCompare(b)))
}

export function assertNoLoreConflict(concepts: readonly Pick<Concept, 'id' | 'lore'>[]): void {
  const conflicts = Object.entries(loreConflicts(concepts))
  if (conflicts.length > 0)
    throw new Error(`one lore name per concept: ${conflicts.map(([lore, ids]) => `${lore} is held by ${ids.join(', ')}`).join('; ')}`)
}

const PROCESS_TABLE_OWNER = 'scripts/ports/process-table.ts'
const LIVENESS_JUDGE = FACTORY_RUNTIME.busSupervisor
const PROCESS_TABLE_PROGRAMS = 'ps lsof top'.split(' ')
const ANSWER_EXECUTOR = 'scripts/nodes/answer/answer-executor.ts'
const ANSWERER = 'scripts/nodes/answer/answerer.ts'
const WINDOW_REQUESTS = 'scripts/window/window-requests.ts'
const LEADING_PARENTS = /^(?:\.\.\/)+/
const GENERATED_PATH_SET = new Set(GENERATED_PATHS)
const HANDOFF_STATUS_LINE = /\^STATUS:/
const PNPM_COMMAND = /\bpnpm (?!(?:at|in|is|monorepo|on)\b)(?:--[\w-]+ )*(?:run |exec )?[a-z][\w:-]*/
const COMMANDS_A_GENERATED_REPOSITORY_RUNS = new Set(['scripts/composition/check.ts', 'scripts/harness-command/render.ts', 'src/model/write.ts', 'src/presets/index.ts'])
export const GIT_BEYOND_THE_PORT_BY_REASON = {
  'src-imports-no-scripts': ['src/detect/git.ts'],
  'a-template-carrier-runs-without-the-factory': ['scripts/construct/check-acceptance.mjs'],
} as const
export const GIT_BEYOND_THE_PORT: ReadonlySet<string> = new Set(Object.values(GIT_BEYOND_THE_PORT_BY_REASON).flat())
const SURFACE_FILE = path.resolve(import.meta.dirname, '../../..', GENERATED_FILES.surface.path)
const GH_RUN_VERBS = new Set(['view', 'list', 'cancel', 'download', 'watch', 'rerun'])

const BUS_READ_PORT = 'scripts/ports/bus-read.ts'
const READ_OF_A_BUS_TABLE = new RegExp(`\\b(?:FROM|JOIN)\\s+"?(?:${BUS_TABLES.join('|')})\\b`)
const SQL_WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/

export function readsABusTable(text: string): boolean {
  return READ_OF_A_BUS_TABLE.test(text) && !SQL_WRITE.test(text)
}

const RUNNING_FUNCTION = /^(?:exec|spawn|run|shell)/
const RUNNING_METHOD = /^(?:exec|spawn|shell)/

let constructCommand: RegExp | undefined

const namesRunBySource = new WeakMap<ts.SourceFile, ReadonlySet<string>>()

function runsACommand(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee))
    return RUNNING_FUNCTION.test(callee.text)
  return ts.isPropertyAccessExpression(callee) && RUNNING_METHOD.test(callee.name.text)
}

function isWrapping(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrayLiteralExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
}

function inRunPosition(node: ts.Node): boolean {
  let child = node
  while (isWrapping(child.parent))
    child = child.parent
  const parent = child.parent
  if (ts.isYieldExpression(parent))
    return true
  return ts.isCallExpression(parent) && parent.arguments.includes(child as ts.Expression) && runsACommand(parent)
}

function namesRunIn(source: ts.SourceFile): ReadonlySet<string> {
  const known = namesRunBySource.get(source)
  if (known !== undefined)
    return known
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && inRunPosition(node))
      names.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  namesRunBySource.set(source, names)
  return names
}

function boundName(node: ts.Node): string | null {
  let value = node
  while (ts.isAsExpression(value.parent) || ts.isSatisfiesExpression(value.parent) || ts.isParenthesizedExpression(value.parent))
    value = value.parent
  const declaration = value.parent
  return ts.isVariableDeclaration(declaration) && declaration.initializer === value && ts.isIdentifier(declaration.name) ? declaration.name.text : null
}

function runByTheCode(node: ts.Node): boolean {
  if (inRunPosition(node))
    return true
  const name = boundName(node)
  return name !== null && namesRunIn(node.getSourceFile()).has(name)
}

function toldToTheOwner(detector: Detector): Detector {
  return (node, file) => {
    const form = detector(node, file)
    return form === null || runByTheCode(node) ? null : form
  }
}

function namesAConstructCommand(text: string): boolean {
  if (constructCommand === undefined) {
    const { commands } = JSON.parse(readFileSync(SURFACE_FILE, 'utf8')) as { commands: Record<string, unknown> }
    const names = [...new Set(Object.keys(commands).map(command => command.split(' ')[0]!))].sort()
    constructCommand = new RegExp(`\\bconstruct (?:${names.join('|')})\\b`)
  }
  return constructCommand.test(text)
}

export const CONCEPTS: readonly Concept[] = [
  {
    id: 'process-table',
    title: 'the process table of the OS, read with ps, lsof or top and parsed',
    owner: PROCESS_TABLE_OWNER,
    ownerExists: true,
    ownerExport: 'OsProcessTable',
    axis: 'architecture',
    lore: null,
    detectors: [programCall(PROCESS_TABLE_PROGRAMS), declaredFunction(/^parsePs$/)],
  },
  {
    id: 'pid-liveness',
    title: 'whether a pid is alive',
    owner: LIVENESS_JUDGE,
    ownerExists: true,
    ownerExport: 'LivenessJudge',
    axis: 'architecture',
    lore: null,
    detectors: [pidProbe()],
  },
  {
    id: 'live-session',
    title: 'whether a client session is alive in a tree',
    owner: LIVENESS_JUDGE,
    ownerExists: true,
    ownerExport: 'LivenessJudge',
    axis: 'architecture',
    lore: null,
    detectors: [
      declaredFunction(/^liveSession(?!s$)/),
      declaredFunction(/^(?:sessionLiveness|isSessionAlive)$/),
      referenced('claudeProcessCwds'),
      adjacentLiterals('-c', name => clientAdapter().processes.isClient(name), 'the client process name in lsof arguments'),
    ],
  },
  {
    id: 'layers',
    title: 'which layer a file belongs to',
    owner: 'scripts/core/layer-map.ts',
    ownerExists: true,
    ownerExport: 'layersOf',
    axis: 'architecture',
    lore: null,
    detectors: [declaredFunction(/^(?:(?:declared)?[lL]ayers?(?:Id)?(?:In|Of)(?:[A-Z]\w*)?|layersReachedBy\w+)$/)],
  },
  {
    id: 'owner-decisions',
    title: 'the owner decisions, read from the markdown file or the bus table',
    owner: 'scripts/policy/decisions/',
    ownerExists: true,
    ownerExport: 'inForceDecisions',
    axis: 'architecture',
    lore: null,
    detectors: [
      literal(text => text === 'owner-decisions.md', 'the file name owner-decisions.md'),
      called(['parseDecisions', 'decisionsFileOf']),
      readOfAFileNamed('readFileSync', /decisions/i),
      literal(text => /\bFROM decisions\b/.test(text), 'SQL over the decisions table'),
    ],
  },
  {
    id: 'handoff-status',
    title: 'the STATUS line of a handoff',
    owner: 'scripts/core/handoff-status.ts',
    ownerExists: true,
    ownerExport: 'statusOf',
    axis: 'architecture',
    lore: null,
    detectors: [
      regexLiteral(HANDOFF_STATUS_LINE, 'a regex over the STATUS line'),
      literal(text => text === 'STATUS', 'the label STATUS'),
      referencedRegex('STATUS_LINE', HANDOFF_STATUS_LINE),
      referenced('HANDOFF_STATUS'),
      calledOnARead('statusOf', 'readFileSync'),
    ],
  },
  {
    id: 'ci-reading',
    title: 'the state of CI on a commit or a pull request',
    owner: 'src/commands/ci/state.ts',
    ownerExists: true,
    ownerExport: 'ciOf',
    axis: 'architecture',
    lore: null,
    detectors: [
      declaredFunction(/^(?:ciOf|ciOfRuns|failedChecksOf|failedJobLog|ciLogForPrompt)$/),
      propertyRead('statusCheckRollup'),
      literal(text => /statusCheckRollup|\/check-runs|\/actions\/runs/.test(text), 'a CI request by its literal'),
      adjacentLiterals('run', verb => GH_RUN_VERBS.has(verb), 'a gh run command'),
      adjacentLiterals('pr', verb => verb === 'checks', 'a gh pr checks command'),
      copiedProperty('ci'),
    ],
  },
  {
    id: 'generated-files',
    title: 'the list of generated files',
    owner: 'scripts/core/generated-files.ts',
    ownerExists: true,
    ownerExport: 'GENERATED_FILES',
    axis: 'architecture',
    lore: null,
    detectors: [literal(text => GENERATED_PATH_SET.has(text.replace(LEADING_PARENTS, '')), 'a generated path by its literal')],
  },
  {
    id: 'owner-commands',
    title: 'the command lines the owner is told to run',
    owner: 'scripts/core/owner-commands.ts',
    ownerExists: true,
    ownerExport: 'pnpmCommand',
    axis: 'interface',
    lore: null,
    detectors: [
      outside(COMMANDS_A_GENERATED_REPOSITORY_RUNS, toldToTheOwner(literal(text => PNPM_COMMAND.test(text), 'a pnpm command in a string'))),
      outside(COMMANDS_A_GENERATED_REPOSITORY_RUNS, toldToTheOwner(literal(namesAConstructCommand, 'a construct command in a string'))),
    ],
  },
  {
    id: 'git',
    title: 'running git',
    owner: FACTORY_NAMED.gitPort,
    ownerExists: true,
    ownerExport: 'processGit',
    axis: 'architecture',
    lore: null,
    detectors: [outside(GIT_BEYOND_THE_PORT, programCall(['git']))],
  },
  {
    id: 'bus-read',
    title: 'a read of a bus table by SQL, which the bus read port answers with a slice in the event contract',
    owner: BUS_READ_PORT,
    ownerExists: true,
    ownerExport: 'BusRead',
    axis: 'architecture',
    lore: null,
    detectors: [literal(readsABusTable, 'SQL reading a bus table')],
  },
  {
    id: 'window-requests',
    title: 'one class for every kind of window request',
    owner: 'scripts/window/requests/',
    ownerExists: false,
    ownerExport: null,
    axis: 'architecture',
    lore: null,
    detectors: [entriesOfTable(WINDOW_REQUESTS, 'executors', 'a request kind inside the class:')],
  },
  {
    id: 'answer-duties',
    title: 'the duties of the answer executor and the answerer, one file each',
    owner: 'scripts/nodes/answer/duties/',
    ownerExists: true,
    ownerExport: 'AnswerOutcomes',
    axis: 'architecture',
    lore: null,
    detectors: [
      declaredIn(ANSWER_EXECUTOR, 'choosing the source', ['sourceOf', 'redWitness', 'boundDecisions', 'closedWaitLines', 'dirtyOnHead', 'conflict']),
      declaredIn(ANSWER_EXECUTOR, 'publishing', ['published', 'leftDirty', 'leftNothing']),
      declaredIn(ANSWER_EXECUTOR, 'the stale question', ['staleQuestion', 'asked', 'ownersQuestion', 'namesAnOwnerPath']),
      declaredIn(ANSWER_EXECUTOR, 'outcomes', ['stopped', 'ownersStop', 'windowWidens', 'denialEvent', 'denied', 'superseded', 'waitingForTheSupersededSession']),
      declaredIn(ANSWERER, 'the prompt', ['answerPrompt', 'mergePrompt', 'sourceLines', 'cardLines', 'decisionLines', 'diffLines', 'gateLine', 'handoffLines']),
      declaredIn(ANSWERER, 'the CI log', ['ciLogLines', 'redCiLines', 'asksAboutRedCi']),
      declaredIn(ANSWERER, 'reading the tree', ['localHead', 'remoteHead', 'git', 'diffAgainstBase', 'treeMergeOf', 'porcelainEntries', 'committedOnTheBranch', 'uncommitted', 'pendingPathsOf', 'liveSessionIn', 'treeDirtyOf']),
      declaredIn(ANSWERER, 'running the client', ['spawnClient']),
    ],
  },
]

export function isOwnedBy(concept: Pick<Concept, 'owner'>, file: string): boolean {
  return concept.owner.endsWith('/') ? file.startsWith(concept.owner) : file === concept.owner
}
