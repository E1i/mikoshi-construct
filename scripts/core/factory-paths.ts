import type { GeneratedFile } from './generated-files.js'
import path from 'node:path'
import { GENERATED_FILES } from './generated-files.js'

export { GENERATED_FILES, RATCHET_FILE, SEAM_SOURCES } from './generated-files.js'

export const FACTORY_ROOT = 'scripts'

export const BUS_CORE = /^scripts\/core\/(?:db|reducer|sqlite|stored|identifiers)\.ts$/
export const BUS_SERVICE = /^scripts\/(?:nodes\/[a-z]+|ladder)\/([a-z]+)-(?:worker|executor|starter)\.ts$/

function generatedPath(id: string): string {
  const row = (GENERATED_FILES as Readonly<Record<string, GeneratedFile>>)[id]
  if (row === undefined)
    throw new Error(`declarations/generated/ has no row ${id}`)
  return row.path
}

export const FACTORY_RUNTIME = {
  busRunEntry: 'scripts/supervisor/run.ts',
  busSupervisor: 'scripts/supervisor/supervisor.ts',
  busWindow: 'scripts/window/window.ts',
  knownLivenessSites: 'scripts/supervisor/liveness-sites.known.json',
  layerMap: generatedPath('layer-map'),
  mikoLoopEntry: 'scripts/window/loop.ts',
  shiftBriefFinish: 'scripts/ladder/brief-finish-cli.ts',
  shiftHeader: 'scripts/nodes/launch/header.md',
  shiftTreePr: 'scripts/nodes/launch/tree-pr-cli.ts',
} as const

export const FACTORY_WORKERS = {
  answer: 'scripts/nodes/answer/answer-worker.ts',
  close: 'scripts/nodes/close/close-worker.ts',
  launch: 'scripts/nodes/launch/launch-root.ts',
  merge: 'scripts/nodes/merge/merge-worker.ts',
  restart: 'scripts/nodes/restart/restart-worker.ts',
  review: 'scripts/nodes/review/review-worker.ts',
  update: 'scripts/nodes/update/update-worker.ts',
  witness: 'scripts/nodes/witness/witness-worker.ts',
} as const

export const FACTORY_NAMED = {
  busAdmissions: 'scripts/intake/admissions.ts',
  busCloseExecutor: 'scripts/nodes/close/close-executor.ts',
  busComposition: 'scripts/supervisor/composition.ts',
  busDatabase: 'scripts/core/db.ts',
  busErrors: 'scripts/core/errors.ts',
  busLease: 'scripts/core/lease.ts',
  busMergeExecutor: 'scripts/nodes/merge/merge-executor.ts',
  busNode: 'scripts/core/node.ts',
  busQueue: 'scripts/core/queue.ts',
  busReducer: 'scripts/core/reducer.ts',
  busRoundLimitDecision: 'scripts/policy/round-limit-decision.ts',
  busStamping: 'scripts/supervisor/stamp.ts',
  busStored: 'scripts/core/stored.ts',
  busUpdateDone: 'scripts/nodes/update/update-done.ts',
  busWatermark: 'scripts/core/watermark.ts',
  clientSealTest: 'scripts/tests/client/seal.test.ts',
  eventsTest: 'scripts/tests/core/events.test.ts',
  factoryPathsTest: 'scripts/tests/core/factory-paths.test.ts',
  factoryRegistry: generatedPath('factory-paths'),
  ghCallers: 'scripts/core/gh-callers.ts',
  ghPort: 'scripts/ports/gh.ts',
  ghostsApproval: 'scripts/ladder/approval.ts',
  ghostsApprove: 'scripts/ladder/approve.ts',
  ghostsHashing: 'scripts/ladder/hash.ts',
  ghostsLaunch: 'scripts/ladder/launch.ts',
  gitPort: 'scripts/ports/git.ts',
  journalGuardTest: 'scripts/tests/bus/journal-guard.test.ts',
  knownGhCallers: 'scripts/core/gh-callers.known.json',
  knownProjectionWrites: 'scripts/core/projection-writes.known.json',
  launchdDirectory: 'scripts/supervisor/launchd',
  layersTest: 'scripts/tests/ci/layers.test.ts',
  livenessSites: 'scripts/supervisor/liveness-sites.ts',
  noParkingReadsTest: 'scripts/tests/bus/no-parking-reads.test.ts',
  ownerMergesTest: 'scripts/tests/shredder/owner-merges.test.ts',
  sqliteTest: 'scripts/tests/bus/sqlite.test.ts',
} as const

export const FACTORY_FORMER_FOLDERS = {
  ghosts: ['scripts/ladder', 'scripts/core/entry.ts', 'scripts/core/every.ts', 'scripts/core/journal.ts', 'scripts/core/tasks.ts', 'scripts/nodes/close/task-close.ts', 'scripts/nodes/close/task-merged.ts', 'scripts/nodes/update/review-carry.ts', 'scripts/ports/task-start.ts', 'scripts/window/handoff-check.ts'],
  shift: ['scripts/core/places.ts', 'scripts/intake/parking.ts', 'scripts/ladder/brief-finish-cli.ts', 'scripts/ladder/brief-finish.ts', 'scripts/ladder/ladder.ts', 'scripts/nodes/launch/continuation.ts', 'scripts/nodes/launch/header.md', 'scripts/nodes/launch/overlap.ts', 'scripts/nodes/launch/prompt.ts', 'scripts/nodes/launch/tree-pr-cli.ts', 'scripts/nodes/launch/tree-pr.ts', 'scripts/policy/shard.ts', 'scripts/window/day-archive.ts', 'scripts/window/handoff-write.ts', 'scripts/window/operator-boundary.ts', 'scripts/window/owner-command.ts', 'scripts/window/role-bus.ts'],
} as const satisfies Record<string, readonly string[]>

export const FACTORY_FOLDERS = {
  busTests: ['scripts/tests/bus'],
  entries: ['cli', 'core', 'intake', 'ladder', 'nodes', 'owner', 'policy', 'ports', 'supervisor', 'window'],
  sharedCode: ['scripts/cli', 'scripts/core', 'scripts/intake', 'scripts/ladder', 'scripts/nodes', 'scripts/policy', 'scripts/ports', 'scripts/supervisor', 'scripts/window'],
  tests: ['scripts/tests'],
} as const satisfies Record<string, readonly string[]>

export const FACTORY_LISTS = {
  busShared: ['scripts/core/card-automaton.ts', 'scripts/core/db.ts', 'scripts/core/errors.ts', 'scripts/core/lease.ts', 'scripts/core/node.ts', 'scripts/core/queue.ts', 'scripts/core/reducer.ts', 'scripts/core/stored.ts', 'scripts/ports/git.ts', 'scripts/supervisor/composition.ts', 'scripts/supervisor/stamp.ts'],
  changesetReaders: ['tests/changesets-one-line.test.ts'],
} as const satisfies Record<string, readonly string[]>

export function scopeOf(entry: string): string {
  return path.posix.extname(entry) === '' ? `${entry}/` : entry
}

export function inScopes(file: string, entries: readonly string[]): boolean {
  return entries.map(scopeOf).some(scope => scope.endsWith('/') ? file.startsWith(scope) : file === scope)
}

export const FACTORY_PATH_ROOTS = [FACTORY_ROOT] as const

export const FACTORY_PATH_EXCLUSIONS = {
  modelEvidence: ['construct.model.json'],
  fixtures: ['tests/**', 'scripts/tests/**'],
  history: ['docs/release-notes/**', 'architecture/decisions/**'],
  productTwins: ['scripts/construct/**', 'templates/**'],
  generated: [GENERATED_FILES.surface.path, GENERATED_FILES.factory.path],
} as const satisfies Record<string, readonly string[]>
