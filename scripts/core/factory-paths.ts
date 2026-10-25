export const FACTORY_ROOT = 'scripts'

export const FACTORY_RUNTIME = {
  busRunEntry: 'scripts/bus/run.ts',
  busSupervisor: 'scripts/bus/supervisor.ts',
  busWindow: 'scripts/bus/window.ts',
  shiftTreePr: 'scripts/shift/tree-pr-cli.ts',
  shiftBriefFinish: 'scripts/shift/brief-finish-cli.ts',
  shiftHeader: 'scripts/shift/header.md',
  mikoLoopEntry: 'scripts/miko/loop.ts',
  knownLivenessSites: 'scripts/bus/liveness-sites.known.json',
  layerMap: 'scripts/core/layer-map.json',
} as const

export const FACTORY_WORKERS = {
  review: 'scripts/bus/review-worker.ts',
  merge: 'scripts/bus/merge-worker.ts',
  update: 'scripts/bus/update-worker.ts',
  launch: 'scripts/bus/launch-worker.ts',
  restart: 'scripts/bus/restart-worker.ts',
  answer: 'scripts/bus/answer-worker.ts',
  close: 'scripts/bus/close-worker.ts',
  witness: 'scripts/bus/witness-worker.ts',
} as const

export const FACTORY_NAMED = {
  launchdDirectory: 'scripts/bus/launchd',
  busDatabase: 'scripts/bus/db.ts',
  busErrors: 'scripts/bus/errors.ts',
  busLease: 'scripts/bus/lease.ts',
  busNode: 'scripts/bus/node.ts',
  busQueue: 'scripts/bus/queue.ts',
  busReducer: 'scripts/bus/reducer.ts',
  busStamping: 'scripts/bus/stamp.ts',
  busStored: 'scripts/bus/stored.ts',
  busWatermark: 'scripts/bus/watermark.ts',
  busAdmissions: 'scripts/bus/admissions.ts',
  busCloseExecutor: 'scripts/bus/close-executor.ts',
  busMergeExecutor: 'scripts/bus/merge-executor.ts',
  busRoundLimitDecision: 'scripts/bus/round-limit-decision.ts',
  busUpdateDone: 'scripts/bus/update-done.ts',
  livenessSites: 'scripts/bus/liveness-sites.ts',
  knownProjectionWrites: 'scripts/bus/projection-writes.known.json',
  factoryRegistry: 'scripts/core/factory-paths.ts',
  ghPort: 'scripts/core/gh.ts',
  ghCallers: 'scripts/core/gh-callers.ts',
  knownGhCallers: 'scripts/core/gh-callers.known.json',
  ghostsApproval: 'scripts/ghosts/approval.ts',
  ghostsHashing: 'scripts/ghosts/hash.ts',
  ghostsLaunch: 'scripts/ghosts/launch.ts',
  ghostsApprove: 'scripts/ghosts/approve.ts',
  factoryPathsTest: 'scripts/tests/core/factory-paths.test.ts',
  eventsTest: 'scripts/tests/core/events.test.ts',
  noParkingReadsTest: 'scripts/tests/bus/no-parking-reads.test.ts',
  journalGuardTest: 'scripts/tests/bus/journal-guard.test.ts',
  sqliteTest: 'scripts/tests/bus/sqlite.test.ts',
  layersTest: 'scripts/tests/ci/layers.test.ts',
  ownerMergesTest: 'scripts/tests/shredder/owner-merges.test.ts',
} as const

export const FACTORY_FOLDERS = {
  entries: ['bus', 'decisions', 'ghosts', 'miko', 'owner', 'shift'],
  bus: ['scripts/bus'],
  ghosts: ['scripts/ghosts'],
  shift: ['scripts/shift'],
  busTests: ['scripts/tests/bus'],
  tests: ['scripts/tests'],
  sharedCode: ['scripts/bus', 'scripts/core', 'scripts/ports', 'scripts/ghosts', 'scripts/shift', 'scripts/decisions'],
} as const satisfies Record<string, readonly string[]>

export const FACTORY_PATH_ROOTS = [FACTORY_ROOT] as const

export const FACTORY_PATH_EXCLUSIONS = {
  modelEvidence: ['construct.model.json'],
  fixtures: ['tests/**', 'scripts/tests/**'],
  history: ['docs/release-notes/**', 'architecture/decisions/**'],
  productTwins: ['scripts/construct/**', 'templates/**'],
  generated: ['contract/surface.json'],
} as const satisfies Record<string, readonly string[]>
