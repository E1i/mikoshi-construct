const BLOCK_REPLACED_WHOLE = 'block-replaced-whole-discovery-bodies-carried-over'

export const BANNER = String.raw`
  ███╗   ███╗██╗██╗  ██╗ ██████╗ ███████╗██╗  ██╗██╗
  ████╗ ████║██║██║ ██╔╝██╔═══██╗██╔════╝██║  ██║██║
  ██╔████╔██║██║█████╔╝ ██║   ██║███████╗███████║██║
  ██║╚██╔╝██║██║██╔═██╗ ██║   ██║╚════██║██╔══██║██║
  ██║ ╚═╝ ██║██║██║  ██╗╚██████╔╝███████║██║  ██║██║
  ╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝`

export interface Lore {
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
  confirm: string
  dryRun: string
  sampleOmitted: string
  unknownStructure: string
  glitch: string
  flatlined: string
  stable: string
  discoveryIncomplete: string
  provenance: string
  stillConstructAuthored: (count: number) => string
  baselineCurrent: string
  baselineMoved: (count: number) => string
  baselineGapUnknown: string
  enforcement: string
  typecheckCaveat: string
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
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => string
  ledgerMalformed: (count: number) => string
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => string
  ledgerEntryWithoutSession: string
  ledgerSessionWithoutEntry: string
  graphNothingDrawn: (reading: string) => string
  syncTitle: string
  syncClasses: string
  syncClassMeaning: Record<string, string>
  syncMergedKeys: (keys: string[]) => string
  syncMergedNotWritten: string
  syncWriteEffect: Record<string, string>
  syncVariantUnknown: (shape: string) => string
  syncApplyUnknown: string
  syncNothingToWrite: string
  syncPending: (count: number) => string
  syncApplyTitle: string
  syncApplyWritten: string
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
  graphPageWritten: (target: string) => string
  notCarried: string
  notCarriedDoesNotHold: (claimId: string, target: string) => string
  notCarriedUnevaluable: (claimId: string, target: string) => string
  notCarriedEveryFactHolds: (claimId: string) => string
  notCarriedSourcesOmitted: (claimId: string) => string
}

function policyEntries(added: { dir: string, allowed: string[] }[]): string {
  return added.map(entry => `${entry.dir} (may import ${entry.allowed.length === 0 ? 'nothing' : entry.allowed.join(', ')})`).join(', ')
}

function andMore(rest: readonly string[]): string {
  return rest.length === 0 ? '' : `, and ${rest.length} more ${rest.length === 1 ? 'fact' : 'facts'}`
}

export const LORE: Lore = {
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
  confirm: 'Inject Construct into repository?',
  dryRun: 'DRY RUN — nothing was written.',
  sampleOmitted: 'Sample sources omitted: the directory is not empty. Discovery maps what is already here.',
  unknownStructure: 'I don\'t recognize this structure. Choose a target directory with --dir.',
  glitch: 'GLITCH',
  flatlined: 'FLATLINED',
  stable: 'CONSTRUCT STABLE',
  discoveryIncomplete: 'Discovery incomplete.',
  provenance: 'AUTHORSHIP TRACE',
  stillConstructAuthored: (count: number) => `Still the construct's own words: ${count} marker${count === 1 ? '' : 's'} nobody has stood behind yet.`,
  baselineCurrent: 'The baseline reads back what today\'s templates produce.',
  baselineMoved: (count: number) => `THE BASELINE MOVED ON: ${count} recorded path${count === 1 ? '' : 's'} a sync would add or update \u2014 run \`construct sync\`.`,
  baselineGapUnknown: 'What a sync would add or update cannot be established from this manifest: run `construct sync`.',
  enforcement: 'ENFORCEMENT TRACE',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
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
    'eslint: ignore scripts/construct/*.workflow.mjs (the ladder script uses top-level return)',
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costMeasuredBy: (version: string) => `Measured by construct v${version} \u2014 quote the version with every figure taken from here.`,
  costUnsupported: (runtime: string) => `No usage feed: the ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger, kept by hand and trusted by nobody: ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the traces it claims: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  graphNothingDrawn: (reading: string) => `NO SIGNAL: ${reading}`,
  syncTitle: 'BRAINDANCE \u2014 ENGRAM REPLAY',
  syncClasses: 'PATH CLASSES',
  syncClassMeaning: {
    add: 'not in the tree; the templates produce it',
    update: 'the construct owns this and the template moved on',
    conflict: 'yours \u2014 you wrote or changed it; sync never touches these',
    unknown: 'which template variant wrote this block cannot be established; you changed nothing, and sync writes nothing here',
    removed: 'you deleted it; sync never puts it back',
    orphaned: 'the construct wrote it once and no longer produces it; it is yours now',
    keep: 'already what the templates produce',
    foreign: 'never ours',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncVariantUnknown: (shape: string) => `no record of the variant that wrote it and no rendering matches the recorded hash; the shape reads like the ${shape} variant, which is a guess and never enough to write on`,
  syncApplyUnknown: 'BEYOND THE BLACKWALL',
  syncNothingToWrite: 'NOTHING TO WRITE \u2014 the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} can be written: run \`construct sync --apply\`.`,
  syncApplyTitle: 'RELIC WRITE',
  syncApplyWritten: 'WRITTEN',
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
  graphPageWritten: (target: string) => `PICTURE COMMITTED TO GLASS: ${target} \u2014 one file, no network, open it from disk.`,
  notCarried: 'NOT CLAIMED HERE: this preset can make these and this repository does not carry them. No level, because nothing is enforced by a claim that was never made.',
  notCarriedDoesNotHold: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} does not carry what it would stand on.`,
  notCarriedUnevaluable: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} could not be read, so whether it would stand cannot be determined.`,
  notCarriedEveryFactHolds: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds; \`construct init\` would record it.`,
  notCarriedSourcesOmitted: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds, but the construct never wrote the sample sources it stands on into this repository, and it writes those only into an empty directory; no run here records it.`,
}

export const PLAIN_LORE: Lore = {
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
  confirm: 'Write these files?',
  dryRun: 'Dry run — nothing was written.',
  sampleOmitted: 'Sample sources omitted: the directory is not empty. Discovery maps what is already here.',
  unknownStructure: 'Unrecognized project structure. Choose a target directory with --dir.',
  glitch: 'WARNING',
  flatlined: 'ERROR',
  stable: 'OK',
  discoveryIncomplete: 'Discovery incomplete.',
  provenance: 'Discovery provenance',
  stillConstructAuthored: (count: number) => `Unchanged since discovery wrote them: ${count} marker${count === 1 ? '' : 's'} nobody has stood behind yet.`,
  baselineCurrent: 'The baseline reads back what today\'s templates produce.',
  baselineMoved: (count: number) => `The baseline moved on: ${count} recorded path${count === 1 ? '' : 's'} a sync would add or update \u2014 run \`construct sync\`.`,
  baselineGapUnknown: 'What a sync would add or update cannot be established from this manifest: run `construct sync`.',
  enforcement: 'Enforcement',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
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
    'eslint: ignore scripts/construct/*.workflow.mjs (the ladder script uses top-level return)',
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costMeasuredBy: (version: string) => `Measured by construct v${version} \u2014 quote the version with every figure taken from here.`,
  costUnsupported: (runtime: string) => `The ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger (a skill step writes it, nothing enforces it): ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the runtime: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  graphNothingDrawn: (reading: string) => reading,
  syncTitle: 'Sync report',
  syncClasses: 'Classes',
  syncClassMeaning: {
    add: 'not in the tree; the templates produce it',
    update: 'the construct owns this and the template moved on',
    conflict: 'yours \u2014 you wrote or changed it; sync never touches these',
    unknown: 'which template variant wrote this block cannot be established; you changed nothing, and sync writes nothing here',
    removed: 'you deleted it; sync never puts it back',
    orphaned: 'the construct wrote it once and no longer produces it; it is yours now',
    keep: 'already what the templates produce',
    foreign: 'never ours',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncVariantUnknown: (shape: string) => `no record of the variant that wrote it and no rendering matches the recorded hash; the shape reads like the ${shape} variant, which is a guess and never enough to write on`,
  syncApplyUnknown: 'Variant unknown',
  syncNothingToWrite: 'Nothing to write: the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} can be written: run \`construct sync --apply\`.`,
  syncApplyTitle: 'Sync apply',
  syncApplyWritten: 'Written',
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
  graphPageWritten: (target: string) => `Wrote ${target}: one self-contained file, no network, open it from disk.`,
  notCarried: 'Not claimed here: this preset can make these and this repository does not carry them. They have no level, because nothing is enforced by a claim that was never made.',
  notCarriedDoesNotHold: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} does not carry what it would stand on.`,
  notCarriedUnevaluable: (claimId: string, target: string) => `  ${claimId} \u2014 ${target} could not be read, so whether it would stand cannot be determined.`,
  notCarriedEveryFactHolds: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds; \`construct init\` would record it.`,
  notCarriedSourcesOmitted: (claimId: string) => `  ${claimId} \u2014 every fact it would stand on holds, but the construct never wrote the sample sources it stands on into this repository, and it writes those only into an empty directory; no run here records it.`,
}
