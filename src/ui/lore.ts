import type { ExpectLore } from './expect-lore.js'
import { EXPECT_LORE } from './expect-lore.js'

const BLOCK_REPLACED_WHOLE = 'block-replaced-whole-discovery-bodies-carried-over'

export const BANNER = String.raw`
  ███╗   ███╗██╗██╗  ██╗ ██████╗ ███████╗██╗  ██╗██╗
  ████╗ ████║██║██║ ██╔╝██╔═══██╗██╔════╝██║  ██║██║
  ██╔████╔██║██║█████╔╝ ██║   ██║███████╗███████║██║
  ██║╚██╔╝██║██║██╔═██╗ ██║   ██║╚════██║██╔══██║██║
  ██║ ╚═╝ ██║██║██║  ██╗╚██████╔╝███████║██║  ██║██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝`

export interface Notice {
  what: string
  why: string
  next: string
}

export interface Lore extends Omit<ExpectLore, 'expectRoleForecast'> {
  expectNoneRaisedBy: (short: number, label: string) => string
  expectRoleForecast: (role: string, tokens: string, minutes: string, band: string, n: number) => string
  expectRoleMinutes: (minutes: string) => string
  expectRoleMinutesNotRecorded: (undated: number, runs: number, source: string) => string
  subtitle: (version: string) => string
  johnnyWakeUp: string
  soulkiller: string
  soulkillerDetail: string
  phaseScan: string
  phaseConfigure: string
  phaseMaterialize: string
  phaseOnline: string
  materializeAi: string
  materializeContracts: string
  materializePolicies: string
  askPreset: string
  askAi: string
  askName: string
  askReview: string
  presetUnavailable: string
  nameInvalid: string
  cancelled: string
  needsTerminal: string
  unknownFlag: (flags: string[]) => string
  initRefusedForeignStack: (preset: string, stack: string, manifests: string[]) => string
  initRefusedAttached: string
  confirm: string
  dryRun: string
  sampleOmitted: string
  unknownStructure: string
  glitch: string
  flatlined: string
  stable: string
  doctorAttached: string
  doctorAttachedHarness: (command: string, state: string) => string
  discoveryIncomplete: string
  provenance: string
  stillConstructAuthored: (count: number) => string
  ownerAuthored: (count: number) => string
  noProvenanceRecorded: (count: number) => string
  provenanceUnreadable: (count: number) => string
  baselineCurrent: string
  baselineMoved: (count: number) => string
  baselineGapUnknown: string
  enforcement: string
  typecheckCaveat: string
  harnessCoverageUnknown: (command: string) => string
  harnessDoesNotCover: (command: string) => string
  uncollectedTests: string
  unreadableFiles: string
  executesNothing: string
  verdictHeld: (mechanism: string) => string
  verdictUnsupported: (mechanism: string, doesNotHold: readonly [string, ...string[]]) => string
  verdictUnevaluable: (mechanism: string, unevaluable: readonly [string, ...string[]]) => string
  verdictNothingNamed: (mechanism: string) => string
  enforcementNoModel: string
  enforcementNoClaim: string
  hypotheses: string
  hypothesisHeld: (statement: string) => string
  hypothesisUnsupported: (statement: string, doesNotHold: readonly [string, ...string[]]) => string
  hypothesisUnevaluable: (statement: string, unevaluable: readonly [string, ...string[]]) => string
  hypothesisNothingNamed: (statement: string) => string
  hypothesisUncommittedEvidence: string
  hypothesesNoModel: string
  hypothesesNoneNamed: string
  youAreHereUnsupported: (claimId: string, stage: string, doesNotHold: readonly [string, ...string[]]) => string
  youAreHereUnevaluable: (claimId: string, stage: string, unevaluable: readonly [string, ...string[]]) => string
  youAreHereNothingNamed: (claimId: string, stage: string) => string
  youAreHereNone: string
  youAreHereNoClaim: string
  youAreHereNoModel: string
  wireHarness: string
  wireHarnessSteps: string[]
  costMeasuredBy: (version: string) => string
  costUnsupported: (runtime: string) => string
  costEmpty: string
  costKeyMismatch: (key: string) => string
  costKeyUnknown: (key: string) => string
  turnsNotRecorded: (file: string) => string
  turnsCounts: (turns: number, sessions: number, main: string, subagents: string, unmeasured: number, unread: number, gaps: number) => string
  costRunTotal: (tokens: string, calls: number, inputEquivalent: string) => string
  costRunsTotal: (runs: number, tokens: string, calls: number, inputEquivalent: string, cacheWrite: number, cacheRead: number, output: number) => string
  turnsMalformed: (count: number) => string
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => string
  ledgerMalformed: (count: number) => string
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => string
  ledgerEntryWithoutSession: string
  ledgerSessionWithoutEntry: string
  costCheapTitle: (taskClass: string) => string
  costCheapContract: (taskClass: string, shiftRoot: string, windowJournal: string) => string
  costCheapForecast: (tokens: string, minutes: number, taskClass: string, n: number) => string
  costCheapNone: (taskClass: string, n: number, minimum: number) => string
  costCheapAction: (tasks: number, counted: number, projectsDir: string, notes: string[]) => string
  costCheapResultForecast: string
  costCheapResultNone: string
  costCheapNoTasksTitle: string
  costCheapNoTasksContract: (shiftRoot: string, windowJournal: string) => string
  costCheapNoTasksExpect: (shiftRoot: string, windowJournal: string) => string
  costCheapNoTasksAction: (shiftRoot: string, windowJournal: string) => string
  graphNothingDrawn: (reading: string) => string
  syncTitle: string
  syncClasses: string
  syncClassMeaning: Record<string, string>
  syncMergedKeys: (keys: string[]) => string
  syncMergedNotWritten: string
  syncWriteEffect: Record<string, string>
  syncVariantUnknown: (shape: string) => string
  syncRecordPredatesBlockFields: string
  syncApplyUnknown: string
  syncNothingToWrite: string
  syncPending: (count: number) => string
  syncApplyTitle: string
  syncApplyWritten: string
  syncApplyRetired: string
  baselineMovedToSuccessor: (files: string[]) => string
  syncApplyRefused: string
  syncApplyWrote: (count: number) => string
  syncApplyNothingWritten: string
  syncApplyLeftToYou: (count: number) => string
  syncVersionGap: (from: string, to: string) => string
  syncNoManifest: string
  written: (applied: number, changed: number) => string
  recordAnswered: (names: string[]) => string
  recordCarriedOver: (carried: number, added: number) => string
  recordVarsChanged: (changed: { name: string, from: string, to: string }[]) => string
  policyGainedKeys: (added: { dir: string, allowed: string[] }[]) => string
  recordFactsRetained: (facts: string[], entries: string[]) => string
  recordClaimNotBorn: (claimId: string, doesNotHold: readonly [string, ...string[]]) => string
  recordAhead: (record: string, field: string, found: number, understood: number) => string
  modelIsWrittenByInit: string
  atlasPageWritten: (target: string) => string
  intakeRefusedAdmitWithDraft: string
  intakeRefusedNoDraft: string
  intakeRefusedNoTaken: string
  intakeRefusedBothFromStdin: string
  intakeRefusedUnreadable: (why: string) => string
  intakeRefusedInvalid: string
  intakeRefusedInvalidTestPattern: string
  intakeWritten: (file: string, card: string) => string
  intakeUnclear: (count: number, who: string) => string
  intakeCorrected: (text: string) => string
  intakeCorrections: (count: number) => string
  intakeConfirmed: (count: number, autoConfirm: boolean) => string
  intakeAwaitingCard: (card: string) => string
  intakeAwaiting: (parking: string, token: string) => string
  intakeConfirmStale: string
  intakeDryRun: (parking: string) => string
  intakeAdmitted: (file: string, card: string) => string
  intakeAlreadyAdmitted: (file: string, card: string) => string
  intakeMoved: (from: string, to: string) => string
  intakeMoveNotFound: (id: number) => string
  intakeMoveAmbiguous: (id: number, paths: string) => string
  intakeMoveTargetHasNumber: (id: number, target: string) => string
  intakeMoveNeedsBoth: string
  intakeMoveTargetOutside: (to: string) => string
  intakeAmended: (file: string, card: string) => string
  intakeAdmitUnclear: (count: number) => string
  intakeAdmitAwaiting: (file: string, token: string) => string
  intakeAdmitDryRun: (file: string) => string
  notCarried: string
  notCarriedDoesNotHold: (claimId: string, target: string) => string
  notCarriedUnevaluable: (claimId: string, target: string) => string
  notCarriedEveryFactHolds: (claimId: string) => string
  notCarriedSourcesOmitted: (claimId: string) => string
  askHarness: string
  harnessEmpty: string
  attachNeedsTerminal: string
  attachConfirm: string
  attachRefusedNoGit: string
  attachRefusedLinkedGit: string
  attachRefusedConstructed: string
  attachRefusedAttached: string
  attachRefusedNothingToAttach: string
  attachRefusedCollision: (paths: string[]) => string
  attachRefusedNoHarness: string
  attachNoHarnessExplained: { why: string, next: string }
  attachCollisionExplained: (recognised: number, total: number, remove: string | null, rerun: string) => { why: string, next: string }
  attachCollisionEarlier: (date: string) => string
  attachCollisionForeign: string
  attachRefusedCursor: string
  attachRefusedNotACommand: (word: string, suggestions: string[]) => Notice
  attachHarnessEditsFiles: (marks: string[]) => Notice
  attachRefusedSettingsIndex: Notice
  attachRefusedSettingsTracked: Notice
  attachRefusedSettingsUnreadable: Notice
  attachRefusedSettingsGuarded: Notice
  attachRefusedSettingsOriginal: Notice
  attachRefusedOriginalPending: Notice
  attachSettingsPlan: (created: boolean) => string
  attachRolledBack: (count: number) => string
  attachBlockKept: string
  attached: string
  attachTrailer: (version: string) => string
  attachPullRequest: (version: string) => string
  attachThen: string
  attachDetach: string
  attachGuard: string
  attachLedgerExcluded: string
  detachNothingAttached: string
  detachRefusedOrphanBlock: string
  detachRefusedRecordVersion: string
  detachRefusedSeparator: string
  detachRefusedSeparatorMismatch: string
  detachRefusedChanged: (count: number) => string
  detachRefusedHookRecord: string
  detachRefusedSettingsUnreadable: string
  detachRefusedOriginalCopy: string
  detachSettingsEntry: string
  detachEntryRemoved: (file: string) => string
  detachOriginalRestored: (file: string) => string
  detachRefusedIndexV4: string
  detachRefusedSplitIndex: string
  detachRefusedSparseIndex: string
  detachRefusedObjectFormat: string
  detachPresentOnDisk: string
  detachAbsentOnDisk: string
  detachAdopted: (target: string) => string
  detachAlreadyAbsent: (target: string) => string
  detachLeftBehind: (target: string) => string
  detachBookkeeping: string
  detached: (count: number) => string
  mutateApplied: (id: string, file: string) => string
  mutateApplyNext: (id: string) => string
  mutateRefusedNoBaseline: string
  mutateRefusedUnsafeId: (id: string) => string
  mutateRefusedFromUnreadable: (from: string) => string
  mutateRefusedUnknownId: (id: string) => string
  mutateRefusedDuplicateId: (count: string) => string
  mutateRefusedMalformedLine: (why: string) => string
  mutateRefusedEditLine: string
  mutateRefusedRecordExists: (id: string) => string
  mutateRefusedOutsideDir: (file: string) => string
  mutateRefusedFileMissing: (file: string) => string
  mutateRefusedChangedAfterBaseline: (file: string) => string
  mutateRefusedFindCount: (count: string) => string
  mutateBaselineRecorded: (tests: number) => string
  mutateRefusedNoMode: string
  mutateRefusedReportUnreadable: (why: string) => string
  mutateRefusedReportRed: (count: string) => string
  mutateRefusedReportEmpty: string
  mutateRefusedReportNoTest: string
  mutateRefusedNoRecord: (id: string) => string
  mutateRefusedNamedTestMissing: string
  mutateRefusedNamedTestAmbiguous: (count: string) => string
  mutateRefusedNamedTestSkipped: string
  mutateHardFileChanged: (file: string) => string
  mutateHardCopyUnreadable: (file: string) => string
  mutateHardRestoreFailed: (file: string) => string
  mutateCopyKept: (copy: string) => string
  mutateRestored: (file: string) => string
  mutateNoWitness: (why: string) => string
  mutateNamedRed: string
  mutateOtherRed: string
  mutateNothingRed: string
  mutateGreenHeld: string
  mutateMatched: string
  mutateUnmatched: string
  mutateFileFailedToRun: string
  mutateRestsOn: (report: string, startedAt: string) => string
  mutateRefusedBadCard: (card: string) => string
  mutateRefusedNoJournal: string
  mutateRefusedCardRequired: (card: string) => string
  mutateJournaled: (journal: string) => string
  boardColumns: string[]
  boardExpectNotRecorded: string
  boardActual: (tokens: number | 'unknown', seconds: number) => string
  boardSummary: (open: number, running: number, waiting: number, blocked: number, stale: number, hours: number, merged: number) => string
  boardLedgerRead: (file: string, runs: number) => string
  boardLedgerAbsent: (file: string) => string
  boardLedgerMalformed: (lines: number[]) => string
  boardPrsRead: (file: string, count: number) => string
  boardPrsNotRead: string
  boardPrsUnreadable: (file: string, reason: string) => string
  boardStale: (age: string) => string
  boardClockSkew: (age: string) => string
  boardMerged: (tasks: string[], older: boolean) => string
  boardNothing: (ledger: string | undefined, prs: string, prsStatus: 'read' | 'not read' | 'unreadable') => string
  boardNoLadderRuns: (file: string) => string
  boardNoRecentLadderRuns: (file: string, hours: number) => string
  boardNoOpenPrs: string
  boardPrsClauseNotRead: (command: string) => string
  boardPrsClauseUnreadable: (reason: string) => string
  boardStart: string
  boardNoImplement: string
  boardEveryInvalid: string
  boardEveryWithJson: string
  boardEveryWithStdin: string
  boardStaleInvalid: string
}

function policyEntries(added: { dir: string, allowed: string[] }[]): string {
  return added.map(entry => `${entry.dir} (may import ${entry.allowed.length === 0 ? 'nothing' : entry.allowed.join(', ')})`).join(', ')
}

function expectNoneRaisedBy(short: number, label: string): string {
  return `; ${short} more done run${short === 1 ? '' : 's'} at ${label} raise${short === 1 ? 's' : ''} it`
}

function expectRoleForecast(role: string, tokens: string, minutes: string, band: string, n: number): string {
  return `${role} tokens \u2248 ${tokens}, ${minutes}, ${band} \u2014 n=${n}`
}

function expectRoleMinutes(minutes: string): string {
  return `minutes \u2248 ${minutes}`
}

function expectRoleMinutesNotRecorded(undated: number, runs: number, source: string): string {
  return `minutes not recorded (no startedAt on ${undated} of ${runs} run${runs === 1 ? '' : 's'} in ${source})`
}

function andMore(rest: readonly string[]): string {
  return rest.length === 0 ? '' : `, and ${rest.length} more ${rest.length === 1 ? 'fact' : 'facts'}`
}

export const LORE: Lore = {
  ...EXPECT_LORE,
  expectNoneRaisedBy,
  expectRoleForecast,
  expectRoleMinutes,
  expectRoleMinutesNotRecorded,
  subtitle: (version: string) => `--- CONSTRUCT ENGINE v${version} // ARASAKA SUB-NET ---`,
  johnnyWakeUp: 'Wake up, Netrunner. We have a repository to build.',
  soulkiller: 'RUNNING SOULKILLER PROTOCOL...',
  soulkillerDetail: 'Extracting codebase consciousness...',
  phaseScan: 'REPOSITORY SCAN COMPLETE',
  phaseConfigure: 'CONSTRUCT CONFIGURATION',
  phaseMaterialize: 'MATERIALIZING CONSTRUCT',
  phaseOnline: 'CONSTRUCT ONLINE',
  materializeAi: 'Injecting instruction sets for AI Netrunners...',
  materializeContracts: 'Generating architecture contracts...',
  materializePolicies: 'Locking ESLint & Security policies...',
  askPreset: 'Which construct are we building?',
  askAi: 'Which Netrunners will jack in?',
  askName: 'Project name',
  askReview: 'Add the Claude code-review workflow on pull requests? (label-triggered, needs a CODE_REVIEW_API_KEY secret)',
  presetUnavailable: 'not materialized yet in this version',
  nameInvalid: 'lowercase letters, digits, "-", "." and "_" only',
  cancelled: 'Netrunner jacked out. Nothing was written.',
  needsTerminal: 'No terminal for the interactive flow; pass --yes (and --preset) to run non-interactively.',
  unknownFlag: (flags: string[]) => `BREACH FAILED // UNKNOWN ICE: ${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} not wired into this command; nothing was written`,
  initRefusedForeignStack: (preset: string, stack: string, manifests: string[]) => `BREACH FAILED // WRONG CHROME: --preset ${preset} is a ${stack} preset, and this directory has ${manifests.join(', ')} and no package.json; nothing was written`,
  initRefusedAttached: 'BREACH FAILED // ALREADY ATTACHED: .construct/attach.json is here; run construct detach first',
  confirm: 'Inject Construct into repository?',
  dryRun: 'DRY RUN — nothing was written.',
  sampleOmitted: 'Sample sources omitted: the directory is not empty. Discovery maps what is already here.',
  unknownStructure: 'I don\'t recognize this structure. Choose a target directory with --dir.',
  glitch: 'GLITCH',
  flatlined: 'FLATLINED',
  stable: 'CONSTRUCT STABLE',
  doctorAttached: 'ATTACHED // NO CONSTRUCT, NETRUN ONLY',
  doctorAttachedHarness: (command: string, state: string) => `Harness \`${command}\` reads ${state}.`,
  discoveryIncomplete: 'Discovery incomplete.',
  provenance: 'AUTHORSHIP TRACE',
  stillConstructAuthored: (count: number) => `Still the construct's own words: ${count} marker${count === 1 ? '' : 's'} nobody has stood behind yet.`,
  ownerAuthored: (count: number) => `Rewritten in your own hand: ${count} marker${count === 1 ? '' : 's'} no longer matching the trace on file.`,
  noProvenanceRecorded: (count: number) => `No trace on file: ${count} marker${count === 1 ? '' : 's'} with nothing recorded to compare a body against.`,
  provenanceUnreadable: (count: number) => `Trace on file, body gone: ${count} marker${count === 1 ? '' : 's'} recorded but unreadable here.`,
  baselineCurrent: 'The baseline reads back what today\'s templates produce.',
  baselineMoved: (count: number) => `THE BASELINE MOVED ON: ${count} recorded path${count === 1 ? '' : 's'} a sync would add or update \u2014 run \`construct sync\`.`,
  baselineGapUnknown: 'What a sync would add or update cannot be established from this manifest: run `construct sync`.',
  enforcement: 'ENFORCEMENT TRACE',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
  harnessCoverageUnknown: (command: string) => `HARNESS UNKNOWN: nothing observed \`${command}\` running this repository's own verification surface. It needs a harness-covers-target claim and a report newer than the surface.`,
  harnessDoesNotCover: (command: string) => `HARNESS MISSES THE TARGET: the report shows \`${command}\` ran none of this repository's own verification surface. A green run here verified something else.`,
  uncollectedTests: 'TESTS THE RECORD CARRIES AND THE RUNNER NEVER COLLECTS.',
  unreadableFiles: 'FILES THE RECORD NAMES AND THIS PROBE COULD NOT OPEN: they are neither missing nor modified, and nothing is said about them.',
  executesNothing: 'NOTHING HERE IS EXECUTED: doctor reads files and runs nothing from the repository it inspects, so it does not speak about whether the harness passes.',
  verdictHeld: (mechanism: string) => mechanism,
  verdictUnsupported: (mechanism: string, doesNotHold: readonly [string, ...string[]]) => `EXPECTS ${mechanism} \u2014 no longer matching: ${doesNotHold.join(', ')}`,
  verdictUnevaluable: (mechanism: string, unevaluable: readonly [string, ...string[]]) => `EXPECTS ${mechanism} \u2014 could not be read here, so nothing is said about it: ${unevaluable.join(', ')}`,
  verdictNothingNamed: (mechanism: string) => `EXPECTS ${mechanism} \u2014 no fact is named under it, so nothing was read`,
  enforcementNoModel: 'THERE IS NO construct.model.json HERE: nothing was read, so nothing is known about what this repository claims \u2014 which is not a reading that nothing is enforced.',
  enforcementNoClaim: 'construct.model.json NAMES NO CLAIM: it was read and it asserts nothing about this repository \u2014 which is not a reading that nothing is enforced.',
  hypotheses: 'STANDING HYPOTHESES',
  hypothesisHeld: (statement: string) => statement,
  hypothesisUnsupported: (statement: string, doesNotHold: readonly [string, ...string[]]) => `READS ${statement} \u2014 no longer matching: ${doesNotHold.join(', ')}`,
  hypothesisUnevaluable: (statement: string, unevaluable: readonly [string, ...string[]]) => `READS ${statement} \u2014 could not be read here, so nothing is said about it: ${unevaluable.join(', ')}`,
  hypothesisNothingNamed: (statement: string) => `READS ${statement} \u2014 no fact is named under it, so nothing was read`,
  hypothesisUncommittedEvidence: '\u2014 the evidence under it carried uncommitted changes when it was read, so no commit holds the bytes it stands on',
  hypothesesNoModel: 'THERE IS NO construct.model.json HERE: nothing was read, so nothing is known about what this repository was taken to be.',
  hypothesesNoneNamed: 'construct.model.json NAMES NO HYPOTHESIS: it was read and it holds nothing open about this repository \u2014 which is not a reading that everything is settled.',
  youAreHereUnsupported: (claimId: string, stage: string, [first, ...rest]: readonly [string, ...string[]]) => `YOU ARE HERE: ${claimId} \u2014 ${stage} unsupported: ${first} no longer matches${andMore(rest)}`,
  youAreHereUnevaluable: (claimId: string, stage: string, [first, ...rest]: readonly [string, ...string[]]) => `YOU ARE HERE: ${claimId} \u2014 ${stage} unknown: ${first} could not be read${andMore(rest)}, so nothing is said about it`,
  youAreHereNothingNamed: (claimId: string, stage: string) => `YOU ARE HERE: ${claimId} \u2014 ${stage} unknown: no fact is named under it, so nothing was read`,
  youAreHereNone: 'YOU ARE HERE: no claim stops before the end of its chain',
  youAreHereNoClaim: 'YOU ARE HERE: construct.model.json carries no claim, so there is none to place',
  youAreHereNoModel: 'YOU ARE HERE: nowhere to place you \u2014 there is no construct.model.json, so nothing is known about claims',
  wireHarness: 'Existing configs were kept, so the harness is not wired in yet. /construct-discover does this first; by hand:',
  wireHarnessSteps: [
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costMeasuredBy: (version: string) => `Measured by construct v${version} \u2014 quote the version with every figure taken from here.`,
  costUnsupported: (runtime: string) => `No usage feed: the ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  turnsNotRecorded: (file: string) => `Turn journal: not recorded \u2014 ${file} is absent, so no turn of any session was measured here.`,
  turnsCounts: (turns: number, sessions: number, main: string, subagents: string, unmeasured: number, unread: number, gaps: number) => `Turn journal, written by hooks: ${turns} turns, ${sessions} sessions, ${main} main-thread and ${subagents} subagent tokens without cache reads, ${unmeasured} unmeasured, ${unread} unread, ${gaps} gaps.`,
  costRunTotal: (tokens: string, calls: number, inputEquivalent: string) => `total ${tokens} tokens without cache reads (input, cache writes and output) in ${calls} calls \u2248 ${inputEquivalent} input-equivalent`,
  costRunsTotal: (runs: number, tokens: string, calls: number, inputEquivalent: string, cacheWrite: number, cacheRead: number, output: number) => `${runs} runs: ${tokens} tokens without cache reads (input, cache writes and output) in ${calls} calls \u2248 ${inputEquivalent} input-equivalent (cache-write \u00D7${cacheWrite}, cache-read \u00D7${cacheRead}, output \u00D7${output})`,
  turnsMalformed: (count: number) => `${count} turn journal line${count === 1 ? '' : 's'} could not be read.`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger, kept by hand and trusted by nobody: ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the traces it claims: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  costCheapTitle: (taskClass: string) => `cost \u00B7 cheap ${taskClass}`,
  costCheapContract: (taskClass: string, shiftRoot: string, windowJournal: string) => `finished cheap tasks of class ${taskClass} in the shift journals under ${shiftRoot} and the window journal ${windowJournal}`,
  costCheapForecast: (tokens: string, minutes: number, taskClass: string, n: number) => `tokens \u2248 ${tokens} from Claude Code shift and window sessions (input, cache writes and output; cache reads left out), minutes \u2248 ${minutes} \u2014 class ${taskClass}, n=${n}, median`,
  costCheapNone: (taskClass: string, n: number, minimum: number) => `none: ${n} finished cheap task${n === 1 ? '' : 's'} of ${taskClass} from Claude Code shift and window sessions with every session readable, fewer than ${minimum}, so no forecast`,
  costCheapAction: (tasks: number, counted: number, projectsDir: string, notes: string[]) => `read ${tasks} finished task${tasks === 1 ? '' : 's'} of the class; ${counted} with every session in ${projectsDir}${notes.length === 0 ? '' : `; ${notes.join('; ')}`}`,
  costCheapResultForecast: 'forecast for the next task of this class',
  costCheapResultNone: 'no forecast for this class',
  costCheapNoTasksTitle: 'cost \u00B7 cheap',
  costCheapNoTasksContract: (shiftRoot: string, windowJournal: string) => `finished cheap tasks in the shift journals under ${shiftRoot} and the window journal ${windowJournal}`,
  costCheapNoTasksExpect: (shiftRoot: string, windowJournal: string) => `none: finished cheap tasks not recorded in ${shiftRoot} or ${windowJournal}`,
  costCheapNoTasksAction: (shiftRoot: string, windowJournal: string) => `read ${shiftRoot}/*/shift.jsonl and ${windowJournal}`,
  graphNothingDrawn: (reading: string) => `NO SIGNAL: ${reading}`,
  syncTitle: 'BRAINDANCE \u2014 ENGRAM REPLAY',
  syncClasses: 'PATH CLASSES',
  syncClassMeaning: {
    'add': 'not in the tree; the templates produce it',
    'update': 'the construct owns this and the template moved on',
    'conflict': 'yours \u2014 you wrote or changed it; sync never touches these',
    'unknown': 'which template variant wrote this block cannot be established; you changed nothing, and sync writes nothing here',
    'removed': 'you deleted it; sync never puts it back',
    'orphaned': 'the construct wrote it once and no longer produces it; it is yours now',
    'moved': 'the construct wrote it, it is unchanged since, and today it is written under a new path; --apply removes it and writes the new one',
    'keep': 'already what the templates produce',
    'foreign': 'never ours',
    'block-edited': 'the construct block differs from the block the last write recorded \u2014 someone edited it; sync never touches it',
    'record-vars-edited': 'the block is what the last write recorded, but the vars in construct.json differ from the vars it was written with \u2014 the record was edited; sync never touches it',
    'template-moved-on': 'the block and the vars are what the last write recorded, and today\'s template renders differently from them',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncVariantUnknown: (shape: string) => `no record of the variant that wrote it and no rendering matches the recorded hash; the shape reads like the ${shape} variant, which is a guess and never enough to write on`,
  syncRecordPredatesBlockFields: 'construct.json predates the fields that would answer (the recorded block sha and vars snapshot of manifest version 6); run the construct again to record them',
  syncApplyUnknown: 'BEYOND THE BLACKWALL',
  syncNothingToWrite: 'NOTHING TO WRITE \u2014 the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} can be written: run \`construct sync --apply\`.`,
  syncApplyTitle: 'RELIC WRITE',
  syncApplyWritten: 'WRITTEN',
  syncApplyRetired: 'RETIRED \u2014 removed, the new path written in their place',
  baselineMovedToSuccessor: (files: string[]) => `${files.length === 1 ? 'A recorded baseline file is' : `${files.length} recorded baseline files are`} gone from the old path and present at the new one (${files.join(', ')}); not missing: sync --apply records the new path, or the old record stays until then`,
  syncApplyRefused: 'LEFT TO YOU',
  syncApplyWrote: (count: number) => `${count} path${count === 1 ? '' : 's'} written. The manifest records the owned view of each of them.`,
  syncApplyNothingWritten: 'NOTHING WRITTEN \u2014 the tree already carries what the construct owns.',
  syncApplyLeftToYou: (count: number) => `${count} path${count === 1 ? '' : 's'} the record cannot prove the construct owns. Yours to carry across.`,
  syncVersionGap: (from: string, to: string) => `ENGRAM CUT BY v${from} // REPLAYED BY v${to}`,
  syncNoManifest: 'No construct.json here. Run `construct init` first.',
  written: (applied: number, changed: number) => `${applied} file${applied === 1 ? '' : 's'}, ${changed} changed`,
  recordAnswered: (names: string[]) => `ENGRAM READ: ${names.join(', ')} came from the construct.json already here, so ${names.length === 1 ? 'it was' : 'they were'} not asked again. A flag overrides ${names.length === 1 ? 'it' : 'them'}.`,
  recordCarriedOver: (carried: number, added: number) => `ENGRAM EXTENDED: ${carried} record${carried === 1 ? '' : 's'} carried over from the construct.json already here, ${added} added.`,
  policyGainedKeys: (added: { dir: string, allowed: string[] }[]) => `ENGRAM WIDENED: allowedWorkspaceImports gained ${policyEntries(added)}. eslint.config.mjs is not rewritten by this run, so it still carries the policy recorded before it; \`construct sync --apply\` would write the new one into that file.`,
  recordVarsChanged: (changed: { name: string, from: string, to: string }[]) => `ENGRAM REWRITTEN: this run changed ${changed.map(entry => `${entry.name} (${entry.from} \u2192 ${entry.to})`).join(', ')} in the record; the recorded hashes were taken with the old value${changed.length === 1 ? '' : 's'}.`,
  recordFactsRetained: (facts: string[], entries: string[]) => `ENGRAM HELD: ${facts.length} construct-authored fact${facts.length === 1 ? '' : 's'} this preset no longer makes ${facts.length === 1 ? 'was' : 'were'} kept, because ${entries.join(', ')} still ${entries.length === 1 ? 'stands' : 'stand'} on ${facts.length === 1 ? 'it' : 'them'}.`,
  recordClaimNotBorn: (claimId: string, [first, ...rest]: readonly [string, ...string[]]) => `ENGRAM WITHHELD: ${claimId} was not recorded \u2014 ${first} does not carry what this preset expects${andMore(rest)}, so nothing is claimed about it here.`,
  recordAhead: (record: string, field: string, found: number, understood: number) => `RELIC FROM A LATER BUILD: ${record} declares ${field} ${found}, and this binary reads ${understood}. Nothing was read and nothing was written \u2014 upgrade the CLI (npx mikoshi-construct@latest) and run this again.`,
  modelIsWrittenByInit: 'ENGRAM UNWRITTEN: one is written by `construct init`, which is additive and overwrites nothing it does not own. Nothing forces you to have one.',
  atlasPageWritten: (target: string) => `PICTURE COMMITTED TO GLASS: ${target} \u2014 one file, no network, open it from disk.`,
  intakeRefusedAdmitWithDraft: 'INTAKE REFUSED // ONE DOOR: --admit takes a card already parked; --draft and --taken slice new ones, never in the same run',
  intakeRefusedNoDraft: 'INTAKE REFUSED // NO DRAFT: --draft names the sliced cards as JSON, a file or - for stdin',
  intakeRefusedNoTaken: 'INTAKE REFUSED // NO TAKEN NUMBERS: --taken names the pull request and issue numbers, a file or - for stdin; a card number shared with one of them is worse than no card',
  intakeRefusedBothFromStdin: 'INTAKE REFUSED // ONE STDIN: --draft and --taken cannot both read -',
  intakeRefusedUnreadable: (why: string) => `INTAKE REFUSED // NO SIGNAL: ${why}`,
  intakeRefusedInvalidTestPattern: 'INTAKE REFUSED // a witness passes vitest a -t that is not a regular expression and can never exit 0; nothing parked',
  intakeRefusedInvalid: 'INTAKE REFUSED // the draft does not slice into valid cards; nothing parked',
  intakeWritten: (file: string, card: string) => `CARD PARKED // ${file}: ${card}`,
  intakeUnclear: (count: number, who: string) => `${count} UNCLEAR // marked in the card, held for who: ${who} until a person settles them`,
  intakeCorrected: (text: string) => `CORRECTED // ${text}`,
  intakeCorrections: (count: number) => `${count} CORRECTED // written in the card; parked only once a person confirms them`,
  intakeConfirmed: (count: number, autoConfirm: boolean) => `${count} CORRECTED // ${autoConfirm ? 'accepted in advance by --auto-confirm' : 'confirmed by a person'}, recorded in the journal`,
  intakeAwaitingCard: (card: string) => `CARD HELD // ${card}`,
  intakeAwaiting: (parking: string, token: string) => `AWAITING CONFIRMATION // nothing parked in ${parking}; confirm the corrections above with --confirm ${token}, or accept them in advance with --auto-confirm`,
  intakeConfirmStale: 'CONFIRMATION STALE // --confirm names a different list of corrections than this run holds; nothing parked',
  intakeDryRun: (parking: string) => `DRY RUN // nothing parked in ${parking}`,
  intakeAdmitted: (file: string, card: string) => `CARD ADMITTED // ${file}: ${card}; its intake line is in the journal`,
  intakeAlreadyAdmitted: (file: string, card: string) => `ALREADY ADMITTED // ${file}: ${card}; the journal holds its intake line, nothing written`,
  intakeMoved: (from: string, to: string) => `MOVED // ${from} -> ${to}; the journal holds the move, the card is unchanged`,
  intakeMoveNotFound: (id: number) => `INTAKE REFUSED // NO CARD: #${id} is in no parking directory under the root`,
  intakeMoveAmbiguous: (id: number, paths: string) => `INTAKE REFUSED // AMBIGUOUS: #${id} is parked in more than one place: ${paths}`,
  intakeMoveTargetHasNumber: (id: number, target: string) => `INTAKE REFUSED // NUMBER TAKEN: ${target} already holds #${id}; nothing moved`,
  intakeMoveNeedsBoth: 'INTAKE REFUSED // --move and --to go together, with no --draft, --taken or --admit',
  intakeMoveTargetOutside: (to: string) => `INTAKE REFUSED // OUTSIDE: --to ${to} is not the parking root (.) or one directory directly under it; nothing moved`,
  intakeAmended: (file: string, card: string) => `CARD AMENDED // ${file}: ${card}; its text differs from the admitted one, a new intake line is in the journal`,
  intakeAdmitUnclear: (count: number) => `${count} UNCLEAR // marked in the card; who is left as the card states it`,
  intakeAdmitAwaiting: (file: string, token: string) => `AWAITING CONFIRMATION // ${file} unchanged, no intake line; confirm the corrections above with --confirm ${token}, or accept them in advance with --auto-confirm`,
  intakeAdmitDryRun: (file: string) => `DRY RUN // ${file} unchanged, no intake line`,
  notCarried: 'NOT CLAIMED HERE: this preset can make these and this repository does not carry them. No level, because nothing is enforced by a claim that was never made.',
  notCarriedDoesNotHold: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} does not carry what it would stand on.`,
  notCarriedUnevaluable: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} could not be read, so whether it would stand cannot be determined.`,
  notCarriedEveryFactHolds: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds; \`construct init\` would record it.`,
  notCarriedSourcesOmitted: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds, but the construct never wrote the sample sources it stands on into this repository, and it writes those only into an empty directory; no run here records it.`,
  askHarness: 'Harness command \u2014 the gate every change must pass (nothing is assumed)?',
  harnessEmpty: 'Name a command; nothing is assumed.',
  attachNeedsTerminal: 'No terminal for the interactive flow; pass --yes --harness <command> to run non-interactively.',
  attachConfirm: 'Jack in?',
  attachRefusedNoGit: 'BREACH FAILED // NO NET: not a git repository',
  attachRefusedLinkedGit: 'BREACH FAILED // LINKED NET: .git is a file',
  attachRefusedConstructed: 'BREACH FAILED // ALREADY CONSTRUCTED: construct.json is here',
  attachRefusedAttached: 'BREACH FAILED // ALREADY ATTACHED: .construct/attach.json is here; run construct detach first',
  attachRefusedNothingToAttach: 'BREACH FAILED // NO TARGET: nothing here to jack into',
  attachRefusedCollision: (paths: string[]) => `BREACH FAILED // COLLISION: ${paths.length} path${paths.length === 1 ? '' : 's'} already exist${paths.length === 1 ? 's' : ''}`,
  attachRefusedNoHarness: 'BREACH FAILED // NO HARNESS NAMED: pass --harness',
  attachNoHarnessExplained: {
    why: 'The net never guesses the command the ladder verifies with; which command mirrors what this repository\'s CI runs is a reading of the repository, and that reading is the agent\'s.',
    next: 'npx mikoshi-construct attach --entry prints the entry protocol: the agent reads CI, scripts, test configs and hooks, proposes one command, and you answer yes or no.',
  },
  attachCollisionExplained: (recognised: number, total: number, remove: string | null, rerun: string) => ({
    why: recognised === 0
      ? 'None of them is byte for byte a construct template of any version, so they are yours; the net writes over nothing.'
      : `${recognised} of ${total} are construct's own, byte for byte a carrier template of an earlier construct run; the net writes over nothing, not even its own.`,
    next: recognised === 0
      ? `Move or remove them yourself, then run: ${rerun}`
      : recognised === total
        ? `${remove} && ${rerun}`
        : `${remove} removes construct's own; move the paths marked not recognised yourself, then run: ${rerun}`,
  }),
  attachCollisionEarlier: (date: string) => `construct's own: byte for byte the template of ${date}`,
  attachCollisionForeign: 'not recognised: the net never writes over it',
  attachRefusedCursor: 'BREACH FAILED // CURSOR OUT OF SCOPE: alwaysApply rules govern the whole tree',
  attachRefusedNotACommand: (word: string, suggestions: string[]) => ({
    what: `BREACH FAILED // DEAD COMMAND: "${word}" is nowhere on PATH`,
    why: 'The ladder runs the harness as written in a plain shell; a package script name or a node_modules/.bin binary never resolves there, so every rung would flatline before it measured anything.',
    next: suggestions.map(suggestion => `--harness ${suggestion}`).join('  or  '),
  }),
  attachHarnessEditsFiles: (marks: string[]) => ({
    what: `The harness rewrites the tree: ${marks.join(', ')}`,
    why: 'It runs on the base and after every change; a gate that fixes what it checks turns a red change green and slips its own edits into the diff under review.',
    next: 'construct detach, then jack in again with the form that only checks (eslint . rather than eslint . --fix).',
  }),
  attachRefusedSettingsIndex: {
    what: 'BREACH FAILED // INDEX UNREADABLE: .claude/settings.local.json exists and .git/index cannot be read here, so whether git tracks it cannot be told',
    why: 'The guard entry goes into that file only while git does not track it; an edit to a tracked file would sit in the owner\'s diff.',
    next: 'Rewrite the index in a form this CLI reads (git update-index --index-version 3, no split or sparse index) or move .claude/settings.local.json aside, then jack in again. Nothing was written.',
  },
  attachRefusedSettingsTracked: {
    what: 'BREACH FAILED // SETTINGS TRACKED: .claude/settings.local.json is tracked by git',
    why: 'The guard entry would be written into a tracked file and sit in the owner\'s diff; an exclude line does nothing for a tracked path.',
    next: 'Stop tracking it (git rm --cached .claude/settings.local.json) or move it aside, then jack in again. Nothing was written.',
  },
  attachRefusedSettingsUnreadable: {
    what: 'BREACH FAILED // SETTINGS UNREADABLE: .claude/settings.local.json is not a settings file the net can edit',
    why: 'It does not parse as a JSON object, its hooks or hooks.PreToolUse has the wrong shape, or it is not a regular file; editing it blind could wipe what is in it.',
    next: 'Fix or move .claude/settings.local.json, then jack in again. Nothing was written.',
  },
  attachRefusedSettingsGuarded: {
    what: 'BREACH FAILED // GUARD ALREADY THERE: .claude/settings.local.json already carries an entry that runs .construct/commit-guard.mjs',
    why: 'The net writes one guard entry and removes exactly that one; a second beside it would outlive the detach that removes the first.',
    next: 'Keep the file, it holds your own settings too. If this repository is still attached, jack out first; if not, delete only that entry from hooks.PreToolUse, then jack in again. Nothing was written.',
  },
  attachRefusedSettingsOriginal: {
    what: 'BREACH FAILED // NO PRE-IMAGE: the copy of .claude/settings.local.json the net keeps outside the repository could not be written',
    why: 'Detach puts that file back byte for byte from the copy; without it the file could not be returned to what it was.',
    next: 'Make the directory the path below names writable, then jack in again. This run was rolled back and the settings file is as it was found.',
  },
  attachRefusedOriginalPending: {
    what: 'BREACH FAILED // EARLIER NETRUN UNFINISHED: a copy of .claude/settings.local.json from an earlier attach is still there',
    why: 'The earlier detach did not finish, and a second copy would overwrite the only record of what that file held.',
    next: 'No .construct/attach.json is at this path, so construct detach here cannot finish it. If the repository attached from this path was moved, run construct detach where it is now. Otherwise the file below is .claude/settings.local.json as it was before that attach: compare it with the current file, keep what is needed, delete the copy, then attach again. Nothing was written.',
  },
  attachSettingsPlan: (created: boolean) => created ? '.claude/settings.local.json is created holding the commit guard entry.' : '.claude/settings.local.json gets the commit guard entry appended; nothing else in it changes.',
  attachRolledBack: (count: number) => `Netrun aborted: ${count} file${count === 1 ? '' : 's'} this run wrote wiped, exclude restored to the byte.`,
  attachBlockKept: 'Block left in .git/info/exclude: the bytes before it are no longer what this run wrote, so it was not cut out. construct detach will name it.',
  attached: 'JACKED IN // NETRUN STARTED',
  attachTrailer: (version: string) => `Attached-Construct: mikoshi-construct@${version}`,
  attachPullRequest: (version: string) => `This work was done under mikoshi-construct attach v${version}: the agent commands were attached temporarily and left no tracked change.`,
  attachThen: 'claude \u2192 /plan <feature>',
  attachDetach: 'construct detach',
  attachGuard: 'the agent is refused git commit, push, merge, rebase and tag here; construct detach removes the guard',
  attachLedgerExcluded: '.construct/ is excluded through .git/info/exclude and will hold the ledger /implement writes.',
  detachNothingAttached: 'NO NETRUN OPEN: nothing is attached here.',
  detachRefusedRecordVersion: 'BREACH FAILED // RECORD UNDATED: recordVersion in .construct/attach.json is missing or not a known integer, so which build wrote it cannot be told',
  detachRefusedSeparator: 'BREACH FAILED // RECORD UNREADABLE: excludeSeparator in .construct/attach.json is not 0, 1 or 2, so the block cannot be cut out to the byte',
  detachRefusedSeparatorMismatch: 'BREACH FAILED // BLOCK MOVED: the bytes before the construct block in .git/info/exclude are not the separator attach wrote, so cutting it out would take yours',
  detachRefusedOrphanBlock: 'BREACH FAILED // ORPHAN BLOCK: .git/info/exclude carries a construct block and no .construct/attach.json names what it hides',
  detachRefusedChanged: (count: number) => `BREACH FAILED // CARRIER REWRITTEN: ${count} attached file${count === 1 ? '' : 's'} no longer match${count === 1 ? 'es' : ''} the record`,
  detachRefusedHookRecord: 'BREACH FAILED // HOOK RECORD UNREADABLE: settingsHook in .construct/attach.json is missing or does not name .claude/settings.local.json, so what attach put there cannot be told; nothing was removed',
  detachRefusedSettingsUnreadable: 'BREACH FAILED // SETTINGS UNREADABLE: .claude/settings.local.json no longer parses as a settings file, so the guard entry cannot be taken out of it; nothing was removed',
  detachRefusedOriginalCopy: 'BREACH FAILED // PRE-IMAGE LOST: the copy of .claude/settings.local.json that attach kept is missing, is not the file attach read, or is not where attach keeps it; nothing was changed, the copy stays as the witness',
  detachSettingsEntry: '.claude/settings.local.json commit guard entry',
  detachEntryRemoved: (file: string) => `guard entry cut out of ${file}; the file stays`,
  detachOriginalRestored: (file: string) => `${file} put back as attach found it: the original bytes came back`,
  detachRefusedIndexV4: 'BREACH FAILED // INDEX V4: .git/index is version 4 (prefix-compressed names) and cannot be read here',
  detachRefusedSplitIndex: 'BREACH FAILED // SPLIT INDEX: .git/index carries a link extension and cannot be read here',
  detachRefusedSparseIndex: 'BREACH FAILED // SPARSE INDEX: .git/index carries an sdir extension and cannot be read here',
  detachRefusedObjectFormat: 'BREACH FAILED // UNKNOWN OBJECT FORMAT: extensions.objectFormat in .git/config is neither sha1 nor sha256',
  detachPresentOnDisk: 'on disk',
  detachAbsentOnDisk: 'not on disk',
  detachAdopted: (target: string) => `adopted by the net: ${target} is tracked now; left as yours`,
  detachAlreadyAbsent: (target: string) => `already gone: ${target}`,
  detachLeftBehind: (target: string) => `left behind: ${target} was not written by attach`,
  detachBookkeeping: 'Not counted: the record .construct/attach.json, .construct/ once empty if attach created it, and the exclude block in .git/info/exclude.',
  detached: (count: number) => `JACKED OUT // NETRUN CLOSED. ${count} paths wiped.`,
  mutateApplied: (id: string, file: string) => `ICE CRACKED // ${id} jacked into ${file}.`,
  mutateApplyNext: (id: string) => `Run the suite and hand its report to: construct mutate judge --id ${id} --report <file> --format vitest-json (Vitest's --reporter=json --outputFile=<file>) or --format junit-xml`,
  mutateRefusedNoBaseline: 'BREACH FAILED // NO GREEN BASELINE: run the suite green with the JSON reporter and record it with construct mutate judge --baseline --report <file>',
  mutateRefusedUnsafeId: (id: string) => `BREACH FAILED // BAD ID: ${id} cannot name a record under .construct/mutations/`,
  mutateRefusedFromUnreadable: (from: string) => `BREACH FAILED // NO BRIEF: ${from} cannot be read`,
  mutateRefusedUnknownId: (id: string) => `BREACH FAILED // UNKNOWN MUTATION: no line of --from starts with ${id}`,
  mutateRefusedDuplicateId: (count: string) => `BREACH FAILED // ID CLASH: ${count} lines of --from carry this id`,
  mutateRefusedMalformedLine: (why: string) => `BREACH FAILED // LINE UNREADABLE: ${why}`,
  mutateRefusedEditLine: 'BREACH FAILED // PROSE, NOT CODE: the line says edit:, written before the code existed; rewrite it as find: `old` → `new`',
  mutateRefusedRecordExists: (id: string) => `BREACH FAILED // ALREADY JACKED IN: .construct/mutations/ still holds ${id}; judge it, or restore it by hand from its .orig copy`,
  mutateRefusedOutsideDir: (file: string) => `BREACH FAILED // OUTSIDE THE NET: ${file} is not a file under --dir`,
  mutateRefusedFileMissing: (file: string) => `BREACH FAILED // NO TARGET: ${file} does not exist`,
  mutateRefusedChangedAfterBaseline: (file: string) => `BREACH FAILED // STALE BASELINE: ${file} changed after the green run; run the suite again and record a new baseline`,
  mutateRefusedFindCount: (count: string) => `BREACH FAILED // FIND NOT UNIQUE: the find text occurs ${count} times, not once`,
  mutateBaselineRecorded: (tests: number) => `BASELINE LOCKED // ${tests} tests green.`,
  mutateRefusedNoMode: 'NO SIGNAL: judge takes --report and exactly one of --id <id> or --baseline',
  mutateRefusedReportUnreadable: (why: string) => `NO SIGNAL: ${why}`,
  mutateRefusedReportRed: (count: string) => `NO BASELINE // ${count} failures in the report: the baseline has to be green`,
  mutateRefusedReportEmpty: 'NO BASELINE // the report holds no test',
  mutateRefusedReportNoTest: 'NO VERDICT // no test ran in the report (the file is restored)',
  mutateRefusedNoRecord: (id: string) => `NO SIGNAL: .construct/mutations/ holds no record of ${id}`,
  mutateRefusedNamedTestMissing: 'NO VERDICT // the named test is not in the report (the file is restored)',
  mutateRefusedNamedTestAmbiguous: (count: string) => `NO VERDICT // ${count} tests in the report carry the named file, describe path and title (the file is restored)`,
  mutateRefusedNamedTestSkipped: 'NO VERDICT // the named test was skipped in the report: a witness that cannot fail proves nothing (the file is restored)',
  mutateHardFileChanged: (file: string) => `FLATLINE // ${file} is not what mutate wrote: someone else edited it, so it was not touched`,
  mutateHardCopyUnreadable: (file: string) => `FLATLINE // the copy of ${file} is missing or not the original, so it was not restored`,
  mutateHardRestoreFailed: (file: string) => `FLATLINE // ${file} could not be restored byte for byte`,
  mutateCopyKept: (copy: string) => `The original stays at ${copy}, with its record; a second apply of this id refuses until you restore it by hand.`,
  mutateRestored: (file: string) => `${file} restored byte for byte from the copy.`,
  mutateNoWitness: (why: string) => `NO WITNESS // ${why}`,
  mutateNamedRed: 'The named test turned red.',
  mutateOtherRed: 'A test other than the named one turned red:',
  mutateNothingRed: 'Nothing turned red: the criterion does not tell the implementation apart.',
  mutateGreenHeld: 'Nothing turned red, as predicted.',
  mutateMatched: 'PREDICTION HELD.',
  mutateUnmatched: 'PREDICTION MISSED.',
  mutateFileFailedToRun: '(the file failed to run)',
  mutateRestsOn: (report: string, startedAt: string) => `The verdict rests on ${report}, a report that started at ${startedAt}; construct did not see the run.`,
  mutateRefusedBadCard: (card: string) => `NO SIGNAL: --card ${card} is not a card number (#<n> or <n>); the file was not touched`,
  mutateRefusedNoJournal: 'NO SIGNAL: --journal names no file; the file was not touched',
  mutateRefusedCardRequired: (card: string) => `NO SIGNAL: this shift runs card #${card}; pass --card ${card} so the verdict is journaled. The file was not touched`,
  mutateJournaled: (journal: string) => `Verdict journaled to ${journal}.`,
  boardColumns: ['TASK', 'PATH', 'STAGE', 'AGE', 'NEXT', 'EXPECT', 'ACTUAL'],
  boardExpectNotRecorded: 'expect not recorded in .construct/runs.jsonl',
  boardActual: (tokens: number | 'unknown', seconds: number) => `tokens ${tokens}, seconds ${seconds}`,
  boardSummary: (open: number, running: number, waiting: number, blocked: number, stale: number, hours: number, merged: number) => `open ${open}: running ${running}, waiting ${waiting}, blocked ${blocked}, stale ${stale} \u00B7 merged ${hours}h: ${merged}`,
  boardLedgerRead: (file: string, runs: number) => `ledger ${file}: ${runs} runs`,
  boardLedgerAbsent: (file: string) => `ledger ${file}: absent`,
  boardLedgerMalformed: (lines: number[]) => `malformed lines ${lines.join(', ')}`,
  boardPrsRead: (file: string, count: number) => `prs ${file}: ${count} pull requests`,
  boardPrsNotRead: 'prs: not read; pass --prs <file>, or - for stdin',
  boardPrsUnreadable: (file: string, reason: string) => `prs ${file}: unreadable (${reason})`,
  boardStale: (age: string) => `stale ${age} \u00B7 `,
  boardClockSkew: (age: string) => `clock skew (${age} ahead)`,
  boardMerged: (tasks: string[], older: boolean) => `merged: ${tasks.length === 0 ? '\u2014' : tasks.join(' \u00B7 ')}${older ? '   (older: --all)' : ''}`,
  boardNothing: (ledger: string | undefined, prs: string, prsStatus: 'read' | 'not read' | 'unreadable') => `nothing open \u2014 ${ledger === undefined ? '' : `${ledger}${prsStatus === 'read' ? ' and ' : '; '}`}${prs}${prsStatus === 'not read' ? '' : '.'}`,
  boardNoLadderRuns: (file: string) => `no ladder runs in ${file}`,
  boardNoRecentLadderRuns: (file: string, hours: number) => `no ladder runs from the last ${hours} hours in ${file}`,
  boardNoOpenPrs: 'no open pull requests',
  boardPrsClauseNotRead: (command: string) => `pull requests not read: ${command} | construct board --prs -`,
  boardPrsClauseUnreadable: (reason: string) => `pull requests unreadable (${reason})`,
  boardStart: 'Start one in Claude Code: /plan <feature>, then /implement <task>.',
  boardNoImplement: 'This repository has no /implement, so the board lists pull requests only.',
  boardEveryInvalid: '--every takes a whole number of seconds, at least 1',
  boardEveryWithJson: '--every redraws the text board and cannot be combined with --json',
  boardEveryWithStdin: '--every re-reads --prs each frame, and stdin can be read once: pass --prs a file',
  boardStaleInvalid: '--stale takes a number of hours greater than 0',
}

export const PLAIN_LORE: Lore = {
  ...EXPECT_LORE,
  expectNoneRaisedBy,
  expectRoleForecast,
  expectRoleMinutes,
  expectRoleMinutesNotRecorded,
  subtitle: (version: string) => `mikoshi-construct v${version}`,
  johnnyWakeUp: 'Wake up, Netrunner. We have a repository to build.',
  soulkiller: 'Inspecting repository...',
  soulkillerDetail: 'Detecting stack and layout...',
  phaseScan: 'Repository scan complete',
  phaseConfigure: 'Configuration',
  phaseMaterialize: 'Writing baseline',
  phaseOnline: 'Done',
  materializeAi: 'Writing AI agent instructions...',
  materializeContracts: 'Writing architecture and contracts...',
  materializePolicies: 'Writing lint and security policies...',
  askPreset: 'Preset',
  askAi: 'AI agents',
  askName: 'Project name',
  askReview: 'Add the Claude code-review workflow on pull requests? (label-triggered, needs a CODE_REVIEW_API_KEY secret)',
  presetUnavailable: 'not available yet in this version',
  nameInvalid: 'lowercase letters, digits, "-", "." and "_" only',
  cancelled: 'Cancelled. Nothing was written.',
  needsTerminal: 'No terminal for the interactive flow; pass --yes (and --preset) to run non-interactively.',
  unknownFlag: (flags: string[]) => `Unknown ${flags.length === 1 ? 'flag' : 'flags'}: ${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} not part of this command; nothing was written.`,
  initRefusedForeignStack: (preset: string, stack: string, manifests: string[]) => `Refused: --preset ${preset} is a ${stack} preset, and this directory has ${manifests.join(', ')} and no package.json; nothing was written.`,
  initRefusedAttached: 'Refused: this repository is attached (.construct/attach.json is here); run `construct detach` first.',
  confirm: 'Write these files?',
  dryRun: 'Dry run — nothing was written.',
  sampleOmitted: 'Sample sources omitted: the directory is not empty. Discovery maps what is already here.',
  unknownStructure: 'Unrecognized project structure. Choose a target directory with --dir.',
  glitch: 'WARNING',
  flatlined: 'ERROR',
  stable: 'OK',
  doctorAttached: 'Attached (no construct.json).',
  doctorAttachedHarness: (command: string, state: string) => `Harness \`${command}\` reads ${state}.`,
  discoveryIncomplete: 'Discovery incomplete.',
  provenance: 'Discovery provenance',
  stillConstructAuthored: (count: number) => `Unchanged since discovery wrote them: ${count} marker${count === 1 ? '' : 's'} nobody has stood behind yet.`,
  ownerAuthored: (count: number) => `Edited since the sha was recorded: ${count} marker${count === 1 ? '' : 's'} now reading as yours rather than the construct's.`,
  noProvenanceRecorded: (count: number) => `No provenance recorded: ${count} marker${count === 1 ? '' : 's'} with nothing recorded to compare a body against.`,
  provenanceUnreadable: (count: number) => `Recorded but unreadable: ${count} marker${count === 1 ? '' : 's'} whose body could not be read here.`,
  baselineCurrent: 'The baseline reads back what today\'s templates produce.',
  baselineMoved: (count: number) => `The baseline moved on: ${count} recorded path${count === 1 ? '' : 's'} a sync would add or update \u2014 run \`construct sync\`.`,
  baselineGapUnknown: 'What a sync would add or update cannot be established from this manifest: run `construct sync`.',
  enforcement: 'Enforcement',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
  harnessCoverageUnknown: (command: string) => `Harness coverage unknown: nothing observed \`${command}\` running this repository's own verification surface. It needs a harness-covers-target claim and a report newer than the surface.`,
  harnessDoesNotCover: (command: string) => `Harness does not cover this repository: the report shows \`${command}\` ran none of its own verification surface. A green run here verified something else.`,
  uncollectedTests: 'Tests the record carries and the runner does not collect.',
  unreadableFiles: 'Files the record names that could not be read: they are neither missing nor modified, and nothing is said about them.',
  executesNothing: 'doctor executes nothing from the repository it inspects, so it does not speak about whether the harness passes.',
  verdictHeld: (mechanism: string) => mechanism,
  verdictUnsupported: (mechanism: string, doesNotHold: readonly [string, ...string[]]) => `expects ${mechanism} \u2014 no longer matching: ${doesNotHold.join(', ')}`,
  verdictUnevaluable: (mechanism: string, unevaluable: readonly [string, ...string[]]) => `expects ${mechanism} \u2014 could not be read here, so nothing is said about it: ${unevaluable.join(', ')}`,
  verdictNothingNamed: (mechanism: string) => `expects ${mechanism} \u2014 no fact is named under it, so nothing was read`,
  enforcementNoModel: 'There is no construct.model.json here: nothing was read, so nothing is known about what this repository claims \u2014 which is not a reading that nothing is enforced.',
  enforcementNoClaim: 'construct.model.json names no claim: it was read and it asserts nothing about this repository \u2014 which is not a reading that nothing is enforced.',
  hypotheses: 'Hypotheses',
  hypothesisHeld: (statement: string) => statement,
  hypothesisUnsupported: (statement: string, doesNotHold: readonly [string, ...string[]]) => `reads ${statement} \u2014 no longer matching: ${doesNotHold.join(', ')}`,
  hypothesisUnevaluable: (statement: string, unevaluable: readonly [string, ...string[]]) => `reads ${statement} \u2014 could not be read here, so nothing is said about it: ${unevaluable.join(', ')}`,
  hypothesisNothingNamed: (statement: string) => `reads ${statement} \u2014 no fact is named under it, so nothing was read`,
  hypothesisUncommittedEvidence: '\u2014 the evidence under it carried uncommitted changes when it was read, so no commit holds the bytes it stands on',
  hypothesesNoModel: 'There is no construct.model.json here: nothing was read, so nothing is known about what this repository was taken to be.',
  hypothesesNoneNamed: 'construct.model.json names no hypothesis: it was read and it holds nothing open about this repository \u2014 which is not a reading that everything is settled.',
  youAreHereUnsupported: (claimId: string, stage: string, [first, ...rest]: readonly [string, ...string[]]) => `You are here: ${claimId} \u2014 ${stage} unsupported: ${first} no longer matches${andMore(rest)}`,
  youAreHereUnevaluable: (claimId: string, stage: string, [first, ...rest]: readonly [string, ...string[]]) => `You are here: ${claimId} \u2014 ${stage} unknown: ${first} could not be read${andMore(rest)}, so nothing is said about it`,
  youAreHereNothingNamed: (claimId: string, stage: string) => `You are here: ${claimId} \u2014 ${stage} unknown: no fact is named under it, so nothing was read`,
  youAreHereNone: 'You are here: no claim stops before the end of its chain',
  youAreHereNoClaim: 'You are here: construct.model.json carries no claim, so there is none to place',
  youAreHereNoModel: 'You are here: nowhere to place you \u2014 there is no construct.model.json, so nothing is known about claims',
  wireHarness: 'Existing configs were kept, so the harness is not wired in yet. /construct-discover does this first; by hand:',
  wireHarnessSteps: [
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costMeasuredBy: (version: string) => `Measured by construct v${version} \u2014 quote the version with every figure taken from here.`,
  costUnsupported: (runtime: string) => `The ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  turnsNotRecorded: (file: string) => `Turn journal: not recorded \u2014 ${file} is absent, so no turn of any session was measured here.`,
  turnsCounts: (turns: number, sessions: number, main: string, subagents: string, unmeasured: number, unread: number, gaps: number) => `Turn journal, written by hooks: ${turns} turns, ${sessions} sessions, ${main} main-thread and ${subagents} subagent tokens without cache reads, ${unmeasured} unmeasured, ${unread} unread, ${gaps} gaps.`,
  costRunTotal: (tokens: string, calls: number, inputEquivalent: string) => `total ${tokens} tokens without cache reads (input, cache writes and output) in ${calls} calls \u2248 ${inputEquivalent} input-equivalent`,
  costRunsTotal: (runs: number, tokens: string, calls: number, inputEquivalent: string, cacheWrite: number, cacheRead: number, output: number) => `${runs} runs: ${tokens} tokens without cache reads (input, cache writes and output) in ${calls} calls \u2248 ${inputEquivalent} input-equivalent (cache-write \u00D7${cacheWrite}, cache-read \u00D7${cacheRead}, output \u00D7${output})`,
  turnsMalformed: (count: number) => `${count} turn journal line${count === 1 ? '' : 's'} could not be read.`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger (a skill step writes it, nothing enforces it): ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the runtime: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  costCheapTitle: (taskClass: string) => `cost \u00B7 cheap ${taskClass}`,
  costCheapContract: (taskClass: string, shiftRoot: string, windowJournal: string) => `finished cheap tasks of class ${taskClass} in the shift journals under ${shiftRoot} and the window journal ${windowJournal}`,
  costCheapForecast: (tokens: string, minutes: number, taskClass: string, n: number) => `tokens \u2248 ${tokens} from Claude Code shift and window sessions (input, cache writes and output; cache reads left out), minutes \u2248 ${minutes} \u2014 class ${taskClass}, n=${n}, median`,
  costCheapNone: (taskClass: string, n: number, minimum: number) => `none: ${n} finished cheap task${n === 1 ? '' : 's'} of ${taskClass} from Claude Code shift and window sessions with every session readable, fewer than ${minimum}, so no forecast`,
  costCheapAction: (tasks: number, counted: number, projectsDir: string, notes: string[]) => `read ${tasks} finished task${tasks === 1 ? '' : 's'} of the class; ${counted} with every session in ${projectsDir}${notes.length === 0 ? '' : `; ${notes.join('; ')}`}`,
  costCheapResultForecast: 'forecast for the next task of this class',
  costCheapResultNone: 'no forecast for this class',
  costCheapNoTasksTitle: 'cost \u00B7 cheap',
  costCheapNoTasksContract: (shiftRoot: string, windowJournal: string) => `finished cheap tasks in the shift journals under ${shiftRoot} and the window journal ${windowJournal}`,
  costCheapNoTasksExpect: (shiftRoot: string, windowJournal: string) => `none: finished cheap tasks not recorded in ${shiftRoot} or ${windowJournal}`,
  costCheapNoTasksAction: (shiftRoot: string, windowJournal: string) => `read ${shiftRoot}/*/shift.jsonl and ${windowJournal}`,
  graphNothingDrawn: (reading: string) => reading,
  syncTitle: 'Sync report',
  syncClasses: 'Classes',
  syncClassMeaning: {
    'add': 'not in the tree; the templates produce it',
    'update': 'the construct owns this and the template moved on',
    'conflict': 'yours \u2014 you wrote or changed it; sync never touches these',
    'unknown': 'which template variant wrote this block cannot be established; you changed nothing, and sync writes nothing here',
    'removed': 'you deleted it; sync never puts it back',
    'orphaned': 'the construct wrote it once and no longer produces it; it is yours now',
    'moved': 'the construct wrote it, it is unchanged since, and today it is written under a new path; --apply removes it and writes the new one',
    'keep': 'already what the templates produce',
    'foreign': 'never ours',
    'block-edited': 'the construct block differs from the block the last write recorded \u2014 someone edited it; sync never touches it',
    'record-vars-edited': 'the block is what the last write recorded, but the vars in construct.json differ from the vars it was written with \u2014 the record was edited; sync never touches it',
    'template-moved-on': 'the block and the vars are what the last write recorded, and today\'s template renders differently from them',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncVariantUnknown: (shape: string) => `no record of the variant that wrote it and no rendering matches the recorded hash; the shape reads like the ${shape} variant, which is a guess and never enough to write on`,
  syncRecordPredatesBlockFields: 'construct.json predates the fields that would answer (the recorded block sha and vars snapshot of manifest version 6); run the construct again to record them',
  syncApplyUnknown: 'Variant unknown',
  syncNothingToWrite: 'Nothing to write: the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} can be written: run \`construct sync --apply\`.`,
  syncApplyTitle: 'Sync apply',
  syncApplyWritten: 'Written',
  syncApplyRetired: 'Removed, the new path written in their place',
  baselineMovedToSuccessor: (files: string[]) => `${files.length === 1 ? 'A recorded baseline file is' : `${files.length} recorded baseline files are`} gone from the old path and present at the new one (${files.join(', ')}); not missing: sync --apply records the new path, or the old record stays until then`,
  syncApplyRefused: 'Left to you',
  syncApplyWrote: (count: number) => `${count} path${count === 1 ? '' : 's'} written. The manifest records the owned view of each of them.`,
  syncApplyNothingWritten: 'Nothing written: the tree already carries what the construct owns.',
  syncApplyLeftToYou: (count: number) => `${count} path${count === 1 ? '' : 's'} the record cannot prove the construct owns. Yours to carry across.`,
  syncVersionGap: (from: string, to: string) => `Materialized by construct ${from}, read by ${to}.`,
  syncNoManifest: 'No construct.json here. Run `construct init` first.',
  written: (applied: number, changed: number) => `${applied} file${applied === 1 ? '' : 's'}, ${changed} changed`,
  recordAnswered: (names: string[]) => `${names.join(', ')} came from the construct.json already here, so ${names.length === 1 ? 'it was' : 'they were'} not asked again. A flag overrides ${names.length === 1 ? 'it' : 'them'}.`,
  recordCarriedOver: (carried: number, added: number) => `Carried over ${carried} record${carried === 1 ? '' : 's'} from the construct.json already here; added ${added}.`,
  policyGainedKeys: (added: { dir: string, allowed: string[] }[]) => `allowedWorkspaceImports gained ${policyEntries(added)}. eslint.config.mjs is not rewritten by this run, so it still carries the policy recorded before it; \`construct sync --apply\` would write the new one into that file.`,
  recordVarsChanged: (changed: { name: string, from: string, to: string }[]) => `This run changed ${changed.map(entry => `${entry.name} (${entry.from} -> ${entry.to})`).join(', ')} in the record; the recorded hashes were taken with the old value${changed.length === 1 ? '' : 's'}.`,
  recordFactsRetained: (facts: string[], entries: string[]) => `Kept ${facts.length} construct-authored fact${facts.length === 1 ? '' : 's'} this preset no longer makes, because ${entries.join(', ')} still ${entries.length === 1 ? 'stands' : 'stand'} on ${facts.length === 1 ? 'it' : 'them'}.`,
  recordClaimNotBorn: (claimId: string, [first, ...rest]: readonly [string, ...string[]]) => `Did not record the claim ${claimId}: ${first} does not carry what this preset expects${andMore(rest)}, so nothing is claimed about it here.`,
  recordAhead: (record: string, field: string, found: number, understood: number) => `${record} declares ${field} ${found}, and this binary understands ${understood}. Nothing was read and nothing was written: upgrade the CLI (npx mikoshi-construct@latest) and run this again.`,
  modelIsWrittenByInit: 'One is written by `construct init`, which is additive and overwrites nothing it does not own. Nothing forces you to have one.',
  atlasPageWritten: (target: string) => `Wrote ${target}: one self-contained file, no network, open it from disk.`,
  intakeRefusedAdmitWithDraft: 'Refused: --admit takes a card already parked, and --draft with --taken slices new ones; run them separately. Nothing was written.',
  intakeRefusedNoDraft: 'Refused: --draft names the sliced cards as JSON, a file or - for stdin. Nothing was written.',
  intakeRefusedNoTaken: 'Refused: --taken names the pull request and issue numbers, a file or - for stdin, because card numbers are shared with them. Nothing was written.',
  intakeRefusedBothFromStdin: 'Refused: --draft and --taken cannot both read stdin. Nothing was written.',
  intakeRefusedUnreadable: (why: string) => `Refused: ${why}. Nothing was written.`,
  intakeRefusedInvalidTestPattern: 'Refused: a witness passes vitest a -t that does not compile as a regular expression, so it can never exit 0. Nothing was written:',
  intakeRefusedInvalid: 'Refused: the draft does not slice into valid cards. Nothing was written:',
  intakeWritten: (file: string, card: string) => `Wrote ${file}: ${card}`,
  intakeUnclear: (count: number, who: string) => `${count} unclear field${count === 1 ? '' : 's'} marked in the card; it stays with who: ${who} until a person settles them.`,
  intakeCorrected: (text: string) => `corrected: ${text}`,
  intakeCorrections: (count: number) => `${count} field${count === 1 ? '' : 's'} corrected against the repository and the grammar; the card is parked only once a person confirms them.`,
  intakeConfirmed: (count: number, autoConfirm: boolean) => `${count} field${count === 1 ? '' : 's'} corrected against the repository and the grammar; ${autoConfirm ? 'accepted in advance by --auto-confirm' : 'confirmed by a person'}, and recorded in the journal.`,
  intakeAwaitingCard: (card: string) => `Held: ${card}`,
  intakeAwaiting: (parking: string, token: string) => `Nothing was written to ${parking}: the corrections above wait for a person. Run again with --confirm ${token} to park the cards as shown, or with --auto-confirm to accept corrections in advance.`,
  intakeConfirmStale: 'Not confirmed: --confirm names a different list of corrections than this run holds. Nothing was written; confirm the list below.',
  intakeDryRun: (parking: string) => `Dry run: nothing was written to ${parking}.`,
  intakeAdmitted: (file: string, card: string) => `Admitted ${file}: ${card}. Its intake line is in the journal, so task:start and the shift take it.`,
  intakeAlreadyAdmitted: (file: string, card: string) => `Already admitted ${file}: ${card}. The journal holds its intake line; nothing was written.`,
  intakeMoved: (from: string, to: string) => `Moved ${from} to ${to}. The journal holds the move; the card is unchanged.`,
  intakeMoveNotFound: (id: number) => `Refused: #${id} is in no parking directory under the root. Nothing was written.`,
  intakeMoveAmbiguous: (id: number, paths: string) => `Refused: #${id} is parked in more than one place: ${paths}. Nothing was written.`,
  intakeMoveTargetHasNumber: (id: number, target: string) => `Refused: ${target} already holds #${id}. Nothing was moved.`,
  intakeMoveNeedsBoth: 'Refused: --move and --to go together, with no --draft, --taken or --admit. Nothing was written.',
  intakeMoveTargetOutside: (to: string) => `Refused: --to ${to} is not the parking root (.) or one directory directly under it. Nothing was moved.`,
  intakeAmended: (file: string, card: string) => `Amended ${file}: ${card}. Its card, task text or witnesses differ from what the journal admitted, so a new intake line with source amend is in the journal.`,
  intakeAdmitUnclear: (count: number) => `${count} unclear field${count === 1 ? '' : 's'} marked in the card; who is left as the card states it.`,
  intakeAdmitAwaiting: (file: string, token: string) => `${file} is unchanged and has no intake line: the corrections above wait for a person. Run again with --confirm ${token} to admit the card as shown, or with --auto-confirm to accept corrections in advance.`,
  intakeAdmitDryRun: (file: string) => `Dry run: ${file} is unchanged and no intake line was written.`,
  notCarried: 'Not claimed here: this preset can make these and this repository does not carry them. They have no level, because nothing is enforced by a claim that was never made.',
  notCarriedDoesNotHold: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} does not carry what it would stand on.`,
  notCarriedUnevaluable: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} could not be read, so whether it would stand cannot be determined.`,
  notCarriedEveryFactHolds: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds; \`construct init\` would record it.`,
  notCarriedSourcesOmitted: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds, but the construct never wrote the sample sources it stands on into this repository, and it writes those only into an empty directory; no run here records it.`,
  askHarness: 'Harness command \u2014 the gate every change must pass (nothing is assumed)?',
  harnessEmpty: 'Name a command; nothing is assumed.',
  attachNeedsTerminal: 'No terminal for the interactive flow; pass --yes --harness <command> to run non-interactively.',
  attachConfirm: 'Attach these files?',
  attachRefusedNoGit: 'Refused: not a git repository.',
  attachRefusedLinkedGit: 'Refused: .git is a file (worktree or submodule); attach needs the .git directory.',
  attachRefusedConstructed: 'Refused: this repository already carries a construct; use init or sync.',
  attachRefusedAttached: 'Refused: this repository is already attached (.construct/attach.json is here); run `construct detach` first.',
  attachRefusedNothingToAttach: 'Refused: this repository holds nothing to attach to.',
  attachRefusedCollision: (paths: string[]) => `Refused: ${paths.length} path${paths.length === 1 ? '' : 's'} attach would create already exist${paths.length === 1 ? 's' : ''}:`,
  attachRefusedNoHarness: 'Refused: --yes needs --harness <command>; nothing is assumed.',
  attachNoHarnessExplained: {
    why: 'attach never guesses the command the ladder verifies with; which command mirrors what this repository\'s CI runs is a reading of the repository, and that reading is the agent\'s.',
    next: 'npx mikoshi-construct attach --entry prints the entry protocol: the agent reads CI, scripts, test configs and hooks, proposes one command, and you answer yes or no.',
  },
  attachCollisionExplained: (recognised: number, total: number, remove: string | null, rerun: string) => ({
    why: recognised === 0
      ? 'None of them is byte for byte a construct template of any version, so they are yours; attach writes over nothing.'
      : `${recognised} of ${total} are construct's own, byte for byte a carrier template of an earlier construct run; attach writes over nothing, not even its own.`,
    next: recognised === 0
      ? `Move or remove them yourself, then run: ${rerun}`
      : recognised === total
        ? `${remove} && ${rerun}`
        : `${remove} removes construct's own; move the paths marked not recognised yourself, then run: ${rerun}`,
  }),
  attachCollisionEarlier: (date: string) => `construct's own: byte for byte the template of ${date}`,
  attachCollisionForeign: 'not recognised: attach never writes over it',
  attachRefusedCursor: 'Refused: --ai cursor is not supported by attach yet; its rules would apply to the whole tree.',
  attachRefusedNotACommand: (word: string, suggestions: string[]) => ({
    what: `Refused: "${word}" is not a command found on PATH.`,
    why: 'The ladder runs the harness as written, in a plain shell; a package.json script name or a binary under node_modules/.bin is not on PATH there, so every rung would fail before it measured anything.',
    next: suggestions.map(suggestion => `--harness ${suggestion}`).join('  or  '),
  }),
  attachHarnessEditsFiles: (marks: string[]) => ({
    what: `The harness command edits files: ${marks.join(', ')}.`,
    why: 'The ladder runs it on the base and after every change; a gate that fixes what it checks can turn a red change green, and its edits land in the diff under review.',
    next: 'construct detach, then attach again with the form that only checks (eslint . rather than eslint . --fix).',
  }),
  attachRefusedSettingsIndex: {
    what: 'Refused: .claude/settings.local.json exists and .git/index cannot be read here, so whether git tracks it cannot be told.',
    why: 'The guard entry goes into that file only while git does not track it; an edit to a tracked file would sit in the owner\'s diff.',
    next: 'Rewrite the index in a form this CLI reads (git update-index --index-version 3, no split or sparse index) or move .claude/settings.local.json aside, then attach again. Nothing was written.',
  },
  attachRefusedSettingsTracked: {
    what: 'Refused: .claude/settings.local.json is tracked by git.',
    why: 'The guard entry would be written into a tracked file and sit in the owner\'s diff; an exclude line does nothing for a tracked path.',
    next: 'Stop tracking it (git rm --cached .claude/settings.local.json) or move it aside, then attach again. Nothing was written.',
  },
  attachRefusedSettingsUnreadable: {
    what: 'Refused: .claude/settings.local.json is not a settings file attach can edit.',
    why: 'It does not parse as a JSON object, its hooks or hooks.PreToolUse has the wrong shape, or it is not a regular file; editing it blind could wipe what is in it.',
    next: 'Fix or move .claude/settings.local.json, then attach again. Nothing was written.',
  },
  attachRefusedSettingsGuarded: {
    what: 'Refused: .claude/settings.local.json already carries an entry that runs .construct/commit-guard.mjs.',
    why: 'attach writes one guard entry and detach removes exactly that one; a second beside it would outlive the detach that removes the first.',
    next: 'Keep the file, it holds your own settings too. If this repository is still attached, run construct detach first; if not, delete only that entry from hooks.PreToolUse, then attach again. Nothing was written.',
  },
  attachRefusedSettingsOriginal: {
    what: 'Refused: the copy of .claude/settings.local.json that attach keeps outside the repository could not be written.',
    why: 'detach puts that file back byte for byte from the copy; without it the file could not be returned to what it was.',
    next: 'Make the directory of the path below writable, then attach again. This run was rolled back and the settings file is as it was found.',
  },
  attachRefusedOriginalPending: {
    what: 'Refused: a copy of .claude/settings.local.json from an earlier attach is still there.',
    why: 'The earlier detach did not finish, and a second copy would overwrite the only record of what that file held.',
    next: 'No .construct/attach.json is at this path, so construct detach here cannot finish it. If the repository attached from this path was moved, run construct detach where it is now. Otherwise the file below is .claude/settings.local.json as it was before that attach: compare it with the current file, keep what is needed, delete the copy, then attach again. Nothing was written.',
  },
  attachSettingsPlan: (created: boolean) => created ? '.claude/settings.local.json is created holding the commit guard entry.' : '.claude/settings.local.json gets the commit guard entry appended; nothing else in it changes.',
  attachRolledBack: (count: number) => `Rolled back: removed ${count} file${count === 1 ? '' : 's'} this run wrote and restored .git/info/exclude byte for byte.`,
  attachBlockKept: 'The block this run added to .git/info/exclude was left in place: the bytes before it are no longer what this run wrote, so cutting it out would take yours. construct detach will name it.',
  attached: 'Attached to repository.',
  attachTrailer: (version: string) => `Attached-Construct: mikoshi-construct@${version}`,
  attachPullRequest: (version: string) => `This work was done under mikoshi-construct attach v${version}: the agent commands were attached temporarily and left no tracked change.`,
  attachThen: 'claude \u2192 /plan <feature>',
  attachDetach: 'construct detach',
  attachGuard: 'the agent is refused git commit, push, merge, rebase and tag here; construct detach removes the guard.',
  attachLedgerExcluded: '.construct/ is excluded through .git/info/exclude and will hold the ledger /implement writes.',
  detachNothingAttached: 'Nothing is attached here.',
  detachRefusedRecordVersion: 'Refused: recordVersion in .construct/attach.json is missing or not a positive integer, so which build wrote the record cannot be told; nothing was removed. Found:',
  detachRefusedSeparator: 'Refused: excludeSeparator in .construct/attach.json is not 0, 1 or 2, so .git/info/exclude cannot be restored byte for byte; nothing was removed. Found:',
  detachRefusedSeparatorMismatch: 'Refused: the bytes before the construct block in .git/info/exclude are not the separator attach wrote (excludeSeparator), so the block cannot be cut out without taking yours; nothing was removed.',
  detachRefusedOrphanBlock: 'Refused: .git/info/exclude carries a construct block but .construct/attach.json is missing, so what it hides cannot be told from yours:',
  detachRefusedChanged: (count: number) => `Refused: ${count} attached file${count === 1 ? '' : 's'} no longer match${count === 1 ? 'es' : ''} the record; nothing was removed:`,
  detachRefusedHookRecord: 'Refused: settingsHook in .construct/attach.json is missing or does not name .claude/settings.local.json, so what attach put there cannot be told; nothing was removed.',
  detachRefusedSettingsUnreadable: 'Refused: .claude/settings.local.json no longer parses as a settings file, so the guard entry cannot be taken out of it; nothing was removed.',
  detachRefusedOriginalCopy: 'Refused: the copy of .claude/settings.local.json that attach kept is missing, is not the file attach read, or is not where attach keeps copies, so the original bytes cannot be restored; nothing was changed and the copy stays as it is:',
  detachSettingsEntry: '.claude/settings.local.json commit guard entry',
  detachEntryRemoved: (file: string) => `removed the commit guard entry from ${file}; the file stays.`,
  detachOriginalRestored: (file: string) => `restored ${file}: the original bytes came back, byte for byte.`,
  detachRefusedIndexV4: 'Refused: .git/index is version 4 (prefix-compressed names), which detach cannot read; nothing was removed.',
  detachRefusedSplitIndex: 'Refused: .git/index is a split index (link extension), which detach cannot read; nothing was removed.',
  detachRefusedSparseIndex: 'Refused: .git/index is a sparse index (sdir extension), which detach cannot read; nothing was removed.',
  detachRefusedObjectFormat: 'Refused: extensions.objectFormat in .git/config is neither sha1 nor sha256, so .git/index cannot be read; nothing was removed.',
  detachPresentOnDisk: 'on disk',
  detachAbsentOnDisk: 'not on disk',
  detachAdopted: (target: string) => `adopted: ${target} is tracked by git now and stays.`,
  detachAlreadyAbsent: (target: string) => `already absent: ${target}`,
  detachLeftBehind: (target: string) => `left behind: ${target} was not written by attach and stays.`,
  detachBookkeeping: 'Not counted: the record .construct/attach.json, .construct/ once empty if attach created it, and the exclude block in .git/info/exclude.',
  detached: (count: number) => `Detached. Removed ${count} paths.`,
  mutateApplied: (id: string, file: string) => `Applied ${id} to ${file}.`,
  mutateApplyNext: (id: string) => `Run the suite and hand its report to: construct mutate judge --id ${id} --report <file> --format vitest-json (Vitest's --reporter=json --outputFile=<file>) or --format junit-xml`,
  mutateRefusedNoBaseline: 'Refused: no green baseline is recorded. Run the suite with the JSON reporter and record it with construct mutate judge --baseline --report <file>. The file is unchanged.',
  mutateRefusedUnsafeId: (id: string) => `Refused: ${id} cannot name a record under .construct/mutations/. The file is unchanged.`,
  mutateRefusedFromUnreadable: (from: string) => `Refused: ${from} cannot be read. The file is unchanged.`,
  mutateRefusedUnknownId: (id: string) => `Refused: no line of --from starts with ${id}. The file is unchanged.`,
  mutateRefusedDuplicateId: (count: string) => `Refused: ${count} lines of --from carry this id. The file is unchanged.`,
  mutateRefusedMalformedLine: (why: string) => `Refused: the line cannot be read: ${why}. The file is unchanged.`,
  mutateRefusedEditLine: 'Refused: the line says edit:, a brief written before the code existed; rewrite it as find: `old` → `new`. The file is unchanged.',
  mutateRefusedRecordExists: (id: string) => `Refused: .construct/mutations/ still holds ${id}; judge it, or restore the file by hand from its .orig copy. The file is unchanged.`,
  mutateRefusedOutsideDir: (file: string) => `Refused: ${file} is not a file under --dir. Nothing was changed.`,
  mutateRefusedFileMissing: (file: string) => `Refused: ${file} does not exist. Nothing was changed.`,
  mutateRefusedChangedAfterBaseline: (file: string) => `Refused: ${file} changed after the green baseline run started; run the suite again and record a new baseline. The file is unchanged.`,
  mutateRefusedFindCount: (count: string) => `Refused: the find text occurs ${count} times, not exactly once. The file is unchanged.`,
  mutateBaselineRecorded: (tests: number) => `Baseline recorded: ${tests} tests, none failed.`,
  mutateRefusedNoMode: 'Refused: judge takes --report and exactly one of --id <id> or --baseline.',
  mutateRefusedReportUnreadable: (why: string) => `Refused: ${why}. No baseline was recorded.`,
  mutateRefusedReportRed: (count: string) => `Refused: the report has ${count} failures; a baseline has to be green. No baseline was recorded.`,
  mutateRefusedReportEmpty: 'Refused: the report holds no test. No baseline was recorded.',
  mutateRefusedReportNoTest: 'Refused: no test ran in the report, so there is no verdict and nothing was journaled. The file is restored.',
  mutateRefusedNoRecord: (id: string) => `Refused: .construct/mutations/ holds no record of ${id}. Nothing was changed.`,
  mutateRefusedNamedTestMissing: 'Refused: the named test is not in the report, so there is no verdict. The file is restored.',
  mutateRefusedNamedTestAmbiguous: (count: string) => `Refused: ${count} tests in the report carry the named file, describe path and title, so there is no verdict. The file is restored.`,
  mutateRefusedNamedTestSkipped: 'Refused: the named test was skipped in the report, so it could not have failed and there is no verdict. Nothing was journaled. The file is restored.',
  mutateHardFileChanged: (file: string) => `Hard failure: ${file} is not the content mutate wrote. It is someone else's edit and was not touched.`,
  mutateHardCopyUnreadable: (file: string) => `Hard failure: the copy of ${file} is missing or not the original, so the file was not restored.`,
  mutateHardRestoreFailed: (file: string) => `Hard failure: ${file} could not be restored byte for byte from the copy.`,
  mutateCopyKept: (copy: string) => `The original stays at ${copy}, with its record; a second apply of this id refuses until you restore it by hand.`,
  mutateRestored: (file: string) => `${file} restored byte for byte from the copy.`,
  mutateNoWitness: (why: string) => `No witness: ${why}.`,
  mutateNamedRed: 'The named test turned red.',
  mutateOtherRed: 'A test other than the named one turned red:',
  mutateNothingRed: 'Nothing turned red: the criterion does not tell the implementation apart.',
  mutateGreenHeld: 'Nothing turned red, as predicted.',
  mutateMatched: 'The outcome matches the prediction.',
  mutateUnmatched: 'The outcome does not match the prediction.',
  mutateFileFailedToRun: '(the file failed to run)',
  mutateRestsOn: (report: string, startedAt: string) => `The verdict rests on ${report}, a report that started at ${startedAt}; construct did not see the run.`,
  mutateRefusedBadCard: (card: string) => `Refused: --card ${card} is not a card number (#<n> or <n>). Nothing was changed.`,
  mutateRefusedNoJournal: 'Refused: --journal names no file. Nothing was changed.',
  mutateRefusedCardRequired: (card: string) => `Refused: this shift runs card #${card}; pass --card ${card} so the verdict is journaled. Nothing was changed.`,
  mutateJournaled: (journal: string) => `The verdict is journaled to ${journal}.`,
  boardColumns: ['TASK', 'PATH', 'STAGE', 'AGE', 'NEXT', 'EXPECT', 'ACTUAL'],
  boardExpectNotRecorded: 'expect not recorded in .construct/runs.jsonl',
  boardActual: (tokens: number | 'unknown', seconds: number) => `tokens ${tokens}, seconds ${seconds}`,
  boardSummary: (open: number, running: number, waiting: number, blocked: number, stale: number, hours: number, merged: number) => `open ${open}: running ${running}, waiting ${waiting}, blocked ${blocked}, stale ${stale} \u00B7 merged ${hours}h: ${merged}`,
  boardLedgerRead: (file: string, runs: number) => `ledger ${file}: ${runs} runs`,
  boardLedgerAbsent: (file: string) => `ledger ${file}: absent`,
  boardLedgerMalformed: (lines: number[]) => `malformed lines ${lines.join(', ')}`,
  boardPrsRead: (file: string, count: number) => `prs ${file}: ${count} pull requests`,
  boardPrsNotRead: 'prs: not read; pass --prs <file>, or - for stdin',
  boardPrsUnreadable: (file: string, reason: string) => `prs ${file}: unreadable (${reason})`,
  boardStale: (age: string) => `stale ${age} \u00B7 `,
  boardClockSkew: (age: string) => `clock skew (${age} ahead)`,
  boardMerged: (tasks: string[], older: boolean) => `merged: ${tasks.length === 0 ? '\u2014' : tasks.join(' \u00B7 ')}${older ? '   (older: --all)' : ''}`,
  boardNothing: (ledger: string | undefined, prs: string, prsStatus: 'read' | 'not read' | 'unreadable') => `nothing open \u2014 ${ledger === undefined ? '' : `${ledger}${prsStatus === 'read' ? ' and ' : '; '}`}${prs}${prsStatus === 'not read' ? '' : '.'}`,
  boardNoLadderRuns: (file: string) => `no ladder runs in ${file}`,
  boardNoRecentLadderRuns: (file: string, hours: number) => `no ladder runs from the last ${hours} hours in ${file}`,
  boardNoOpenPrs: 'no open pull requests',
  boardPrsClauseNotRead: (command: string) => `pull requests not read: ${command} | construct board --prs -`,
  boardPrsClauseUnreadable: (reason: string) => `pull requests unreadable (${reason})`,
  boardStart: 'Start one in Claude Code: /plan <feature>, then /implement <task>.',
  boardNoImplement: 'This repository has no /implement, so the board lists pull requests only.',
  boardEveryInvalid: '--every takes a whole number of seconds, at least 1',
  boardEveryWithJson: '--every redraws the text board and cannot be combined with --json',
  boardEveryWithStdin: '--every re-reads --prs each frame, and stdin can be read once: pass --prs a file',
  boardStaleInvalid: '--stale takes a number of hours greater than 0',
}
