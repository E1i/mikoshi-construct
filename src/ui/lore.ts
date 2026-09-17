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
  enforcement: string
  typecheckCaveat: string
  weakestLink: (id: string, level: string) => string
  levelLift: Record<string, string>
  weakestLinkNone: string
  wireHarness: string
  wireHarnessSteps: string[]
  costUnsupported: (runtime: string) => string
  costEmpty: string
  costKeyMismatch: (key: string) => string
  costKeyUnknown: (key: string) => string
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => string
  ledgerMalformed: (count: number) => string
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => string
  ledgerEntryWithoutSession: string
  ledgerSessionWithoutEntry: string
  syncTitle: string
  syncClasses: string
  syncClassMeaning: Record<string, string>
  syncMergedKeys: (keys: string[]) => string
  syncMergedNotWritten: string
  syncWriteEffect: Record<string, string>
  syncNothingToWrite: string
  syncPending: (count: number) => string
  syncVersionGap: (from: string, to: string) => string
  syncNoManifest: string
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
  enforcement: 'ENFORCEMENT TRACE',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
  weakestLink: (id: string, level: string) => `WEAKEST LINK: ${id} at ${level}`,
  levelLift: {
    L0: 'wire it to a hook or a workflow step and it climbs',
    L1: 'only a reviewer stands behind it; a hook or a workflow step raises it',
    L2: 'a hook is bypassable with --no-verify; running it in CI too raises it',
    L3: 'L3 is the ceiling doctor can read: branch protection is what makes it blocking, and that lives in the API',
    L4: 'nothing above this',
  },
  weakestLinkNone: 'WEAKEST LINK: nothing is claimed',
  wireHarness: 'Existing configs were kept, so the harness is not wired in yet. /construct-discover does this first; by hand:',
  wireHarnessSteps: [
    'eslint: ignore scripts/construct/*.workflow.mjs (the ladder script uses top-level return)',
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costUnsupported: (runtime: string) => `No usage feed: the ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger, kept by hand and trusted by nobody: ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the traces it claims: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  syncTitle: 'REPLAY TRACE',
  syncClasses: 'PATH CLASSES',
  syncClassMeaning: {
    add: 'not in the tree; the templates produce it',
    update: 'the construct owns this and the template moved on',
    conflict: 'yours \u2014 you wrote or changed it; sync never touches these',
    removed: 'you deleted it; sync never puts it back',
    orphaned: 'the construct wrote it once and no longer produces it; it is yours now',
    keep: 'already what the templates produce',
    foreign: 'never ours',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'Merged targets are reported, never rewritten: this version writes no merge-json file.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncNothingToWrite: 'NOTHING TO WRITE \u2014 the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} would be written. This version reports; it writes nothing.`,
  syncVersionGap: (from: string, to: string) => `MATERIALIZED BY CONSTRUCT v${from} // READ BY v${to}`,
  syncNoManifest: 'No construct.json here. Run `construct init` first.',
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
  enforcement: 'Enforcement',
  typecheckCaveat: 'Typecheck cannot carry this stack alone.',
  weakestLink: (id: string, level: string) => `Weakest link: ${id} at ${level}`,
  levelLift: {
    L0: 'wire it to a hook or a workflow step and it climbs',
    L1: 'only a reviewer stands behind it; a hook or a workflow step raises it',
    L2: 'a hook is bypassable with --no-verify; running it in CI too raises it',
    L3: 'L3 is the ceiling doctor can read: branch protection is what makes it blocking, and that lives in the API',
    L4: 'nothing above this',
  },
  weakestLinkNone: 'Weakest link: nothing is claimed',
  wireHarness: 'Existing configs were kept, so the harness is not wired in yet. /construct-discover does this first; by hand:',
  wireHarnessSteps: [
    'eslint: ignore scripts/construct/*.workflow.mjs (the ladder script uses top-level return)',
    'tsconfig: include scripts/**/*.ts; vitest: include scripts/tests/**/*.test.ts',
    'package.json: make the quality script run composition:check (and contracts:check when there is a contract)',
  ],
  costUnsupported: (runtime: string) => `The ${runtime} runtime does not expose per-run token usage.`,
  costEmpty: 'No /implement runs recorded here yet.',
  costKeyMismatch: (key: string) => `Runs for this repository were recorded under another path. Looked up: ${key}`,
  costKeyUnknown: (key: string) => `Runs may be recorded under another path — the evidence is not conclusive. Looked up: ${key}`,
  ledgerCounts: (runs: number, agents: number, failures: number, tokens: string) => `Ledger (a skill step writes it, nothing enforces it): ${runs} runs, ${agents} agents, ${failures} unfinished, ${tokens} tokens.`,
  ledgerMalformed: (count: number) => `${count} ledger line${count === 1 ? '' : 's'} could not be read as a run record.`,
  ledgerDrift: (entriesWithoutSession: number, sessionsWithoutEntry: number, unjoinable: number) => `Ledger against the runtime: ${entriesWithoutSession} entries with no session, ${sessionsWithoutEntry} sessions with no entry, ${unjoinable} entries with no run id.`,
  ledgerEntryWithoutSession: 'logged as a run, no session behind it',
  ledgerSessionWithoutEntry: 'ran, never logged',
  syncTitle: 'Sync report',
  syncClasses: 'Classes',
  syncClassMeaning: {
    add: 'not in the tree; the templates produce it',
    update: 'the construct owns this and the template moved on',
    conflict: 'yours \u2014 you wrote or changed it; sync never touches these',
    removed: 'you deleted it; sync never puts it back',
    orphaned: 'the construct wrote it once and no longer produces it; it is yours now',
    keep: 'already what the templates produce',
    foreign: 'never ours',
  },
  syncMergedKeys: (keys: string[]) => `keys: ${keys.join(', ')}`,
  syncMergedNotWritten: 'Merged targets are reported, never rewritten: this version writes no merge-json file.',
  syncWriteEffect: {
    [BLOCK_REPLACED_WHOLE]: 'the construct block is replaced whole \u2014 edits between the delimiters do not survive; the discovery marker bodies are carried over',
  },
  syncNothingToWrite: 'Nothing to write: the replay reads back what the tree already carries.',
  syncPending: (count: number) => `${count} path${count === 1 ? '' : 's'} would be written. This version reports; it writes nothing.`,
  syncVersionGap: (from: string, to: string) => `Materialized by construct ${from}, read by ${to}.`,
  syncNoManifest: 'No construct.json here. Run `construct init` first.',
}
