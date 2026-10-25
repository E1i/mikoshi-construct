import path from 'node:path'

export const FACTORY_ROOT = 'scripts'

export const FACTORY_RUNTIME = {
  busRunEntry: 'scripts/supervisor/run.ts',
  busSupervisor: 'scripts/supervisor/supervisor.ts',
  busWindow: 'scripts/window/window.ts',
  shiftTreePr: 'scripts/nodes/launch/tree-pr-cli.ts',
  shiftBriefFinish: 'scripts/ladder/brief-finish-cli.ts',
  shiftHeader: 'scripts/nodes/launch/header.md',
  mikoLoopEntry: 'scripts/window/loop.ts',
  knownLivenessSites: 'scripts/supervisor/liveness-sites.known.json',
  layerMap: 'scripts/core/layer-map.json',
} as const

export const FACTORY_WORKERS = {
  review: 'scripts/nodes/review/review-worker.ts',
  merge: 'scripts/nodes/merge/merge-worker.ts',
  update: 'scripts/nodes/update/update-worker.ts',
  launch: 'scripts/nodes/launch/launch-worker.ts',
  restart: 'scripts/nodes/restart/restart-worker.ts',
  answer: 'scripts/nodes/answer/answer-worker.ts',
  close: 'scripts/nodes/close/close-worker.ts',
  witness: 'scripts/nodes/witness/witness-worker.ts',
} as const

export const FACTORY_NAMED = {
  launchdDirectory: 'scripts/supervisor/launchd',
  busDatabase: 'scripts/core/db.ts',
  busErrors: 'scripts/core/errors.ts',
  busLease: 'scripts/core/lease.ts',
  busNode: 'scripts/core/node.ts',
  busQueue: 'scripts/core/queue.ts',
  busReducer: 'scripts/core/reducer.ts',
  busStamping: 'scripts/supervisor/stamp.ts',
  busStored: 'scripts/core/stored.ts',
  busWatermark: 'scripts/core/watermark.ts',
  busAdmissions: 'scripts/intake/admissions.ts',
  busCloseExecutor: 'scripts/nodes/close/close-executor.ts',
  busMergeExecutor: 'scripts/nodes/merge/merge-executor.ts',
  busRoundLimitDecision: 'scripts/policy/round-limit-decision.ts',
  busUpdateDone: 'scripts/nodes/update/update-done.ts',
  livenessSites: 'scripts/supervisor/liveness-sites.ts',
  knownProjectionWrites: 'scripts/core/projection-writes.known.json',
  factoryRegistry: 'scripts/core/factory-paths.ts',
  ghPort: 'scripts/ports/gh.ts',
  ghCallers: 'scripts/core/gh-callers.ts',
  knownGhCallers: 'scripts/core/gh-callers.known.json',
  ghostsApproval: 'scripts/ladder/approval.ts',
  ghostsHashing: 'scripts/ladder/hash.ts',
  ghostsLaunch: 'scripts/ladder/launch.ts',
  ghostsApprove: 'scripts/ladder/approve.ts',
  factoryPathsTest: 'scripts/tests/core/factory-paths.test.ts',
  eventsTest: 'scripts/tests/core/events.test.ts',
  noParkingReadsTest: 'scripts/tests/bus/no-parking-reads.test.ts',
  journalGuardTest: 'scripts/tests/bus/journal-guard.test.ts',
  sqliteTest: 'scripts/tests/bus/sqlite.test.ts',
  layersTest: 'scripts/tests/ci/layers.test.ts',
  ownerMergesTest: 'scripts/tests/shredder/owner-merges.test.ts',
} as const

export const FACTORY_FORMER_FOLDERS = {
  ghosts: [
    'scripts/ladder',
    'scripts/core/entry.ts',
    'scripts/core/every.ts',
    'scripts/core/journal.ts',
    'scripts/core/tasks.ts',
    'scripts/nodes/close/task-close.ts',
    'scripts/nodes/close/task-merged.ts',
    'scripts/nodes/update/review-carry.ts',
    'scripts/ports/task-start.ts',
    'scripts/window/handoff-check.ts',
  ],
  shift: [
    'scripts/core/places.ts',
    'scripts/intake/parking.ts',
    'scripts/ladder/brief-finish-cli.ts',
    'scripts/ladder/brief-finish.ts',
    'scripts/ladder/ladder.ts',
    'scripts/nodes/launch/continuation.ts',
    'scripts/nodes/launch/header.md',
    'scripts/nodes/launch/overlap.ts',
    'scripts/nodes/launch/prompt.ts',
    'scripts/nodes/launch/tree-pr-cli.ts',
    'scripts/nodes/launch/tree-pr.ts',
    'scripts/policy/shard.ts',
    'scripts/window/day-archive.ts',
    'scripts/window/handoff-write.ts',
    'scripts/window/operator-boundary.ts',
    'scripts/window/owner-command.ts',
    'scripts/window/role-bus.ts',
  ],
} as const satisfies Record<string, readonly string[]>

export const FACTORY_FOLDERS = {
  entries: ['cli', 'core', 'intake', 'ladder', 'nodes', 'owner', 'policy', 'ports', 'supervisor', 'window'],
  busTests: ['scripts/tests/bus'],
  tests: ['scripts/tests'],
  sharedCode: ['scripts/cli', 'scripts/core', 'scripts/intake', 'scripts/ladder', 'scripts/nodes', 'scripts/policy', 'scripts/ports', 'scripts/supervisor', 'scripts/window'],
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
  generated: ['contract/surface.json'],
} as const satisfies Record<string, readonly string[]>
