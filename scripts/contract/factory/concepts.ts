import type { Detector } from './detectors.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_RUNTIME } from '../../core/factory-paths.js'
import { GENERATED_FILES, GENERATED_PATHS } from '../../core/generated-files.js'
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

export interface Concept {
  id: string
  title: string
  owner: string
  ownerExists: boolean
  axis: Axis
  detectors: readonly Detector[]
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
const COMMANDS_A_GENERATED_REPOSITORY_RUNS = new Set(['scripts/harness-command/render.ts', 'src/model/write.ts', 'src/presets/index.ts'])
const SURFACE_FILE = path.resolve(import.meta.dirname, '../../..', GENERATED_FILES.surface.path)
const GH_RUN_VERBS = new Set(['view', 'list', 'cancel', 'download', 'watch', 'rerun'])

let constructCommand: RegExp | undefined

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
    axis: 'architecture',
    detectors: [programCall(PROCESS_TABLE_PROGRAMS), declaredFunction(/^parsePs$/)],
  },
  {
    id: 'pid-liveness',
    title: 'whether a pid is alive',
    owner: LIVENESS_JUDGE,
    ownerExists: true,
    axis: 'architecture',
    detectors: [pidProbe()],
  },
  {
    id: 'live-session',
    title: 'whether a client session is alive in a tree',
    owner: LIVENESS_JUDGE,
    ownerExists: true,
    axis: 'architecture',
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
    axis: 'architecture',
    detectors: [declaredFunction(/^(?:(?:declared)?[lL]ayers?(?:Id)?(?:In|Of)(?:[A-Z]\w*)?|layersReachedBy\w+)$/)],
  },
  {
    id: 'owner-decisions',
    title: 'the owner decisions, read from the markdown file or the bus table',
    owner: 'scripts/policy/decisions.ts',
    ownerExists: true,
    axis: 'architecture',
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
    axis: 'architecture',
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
    axis: 'architecture',
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
    axis: 'architecture',
    detectors: [literal(text => GENERATED_PATH_SET.has(text.replace(LEADING_PARENTS, '')), 'a generated path by its literal')],
  },
  {
    id: 'owner-commands',
    title: 'the command lines the owner is told to run',
    owner: 'scripts/core/owner-commands.ts',
    ownerExists: false,
    axis: 'interface',
    detectors: [
      outside(COMMANDS_A_GENERATED_REPOSITORY_RUNS, literal(text => PNPM_COMMAND.test(text), 'a pnpm command in a string')),
      outside(COMMANDS_A_GENERATED_REPOSITORY_RUNS, literal(namesAConstructCommand, 'a construct command in a string')),
    ],
  },
  {
    id: 'git',
    title: 'running git',
    owner: 'scripts/ports/git.ts',
    ownerExists: true,
    axis: 'architecture',
    detectors: [programCall(['git'])],
  },
  {
    id: 'window-requests',
    title: 'one class for every kind of window request',
    owner: 'scripts/window/requests/',
    ownerExists: false,
    axis: 'architecture',
    detectors: [entriesOfTable(WINDOW_REQUESTS, 'executors', 'a request kind inside the class:')],
  },
  {
    id: 'answer-duties',
    title: 'four duties each in the answer executor and the answerer',
    owner: 'scripts/nodes/answer/duties/',
    ownerExists: false,
    axis: 'architecture',
    detectors: [
      declaredIn(ANSWER_EXECUTOR, 'choosing the source', ['sourceOf', 'redWitness', 'boundDecisions', 'closedWaitLines', 'dirtyOnHead', 'conflict']),
      declaredIn(ANSWER_EXECUTOR, 'publishing', ['published', 'leftDirty', 'leftNothing']),
      declaredIn(ANSWER_EXECUTOR, 'the stale question', ['staleQuestion', 'asked', 'ownersQuestion', 'namesAnOwnerPath']),
      declaredIn(ANSWER_EXECUTOR, 'outcomes', ['stopped', 'ownersStop', 'windowWidens', 'denialEvent', 'denied', 'superseded', 'waitingForTheSupersededSession']),
      declaredIn(ANSWERER, 'the prompt', ['answerPrompt', 'mergePrompt', 'sourceLines', 'cardLines', 'decisionLines', 'diffLines', 'gateLine', 'handoffLines']),
      declaredIn(ANSWERER, 'the CI log', ['ciLogLines', 'redCiLines', 'asksAboutRedCi']),
      declaredIn(ANSWERER, 'reading the tree', ['localHead', 'remoteHead', 'git', 'diffAgainstBase', 'treeMergeOf', 'porcelainEntries', 'committedOnTheBranch', 'uncommitted', 'pendingPathsOf', 'clientInTree', 'treeDirtyOf']),
      declaredIn(ANSWERER, 'running the client', ['spawnClient']),
    ],
  },
]

export function isOwnedBy(concept: Pick<Concept, 'owner'>, file: string): boolean {
  return concept.owner.endsWith('/') ? file.startsWith(concept.owner) : file === concept.owner
}
