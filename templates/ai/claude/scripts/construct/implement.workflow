export const meta = {
  name: 'implement',
  description: 'Implement a task at low effort, verify with the harness, escalate on repeated failure or ambiguity',
  phases: [
    { title: 'Preflight', detail: 'harness against the base before any change; a base red in a way that cannot be identified stops the run' },
    { title: 'Design', detail: 'architect inside the run, for high effort before the first rung and after a blocked or failed attempt' },
    { title: 'Implement', detail: 'implementer at the current rung' },
    { title: 'Verify', detail: 'harness against the working tree, and each acceptance item witnessed red before the change and green after it' },
  ],
}

const LADDERS = {
  low: ['low', 'low', 'medium', 'high'],
  medium: ['medium', 'medium', 'high'],
  high: ['high', 'high', 'xhigh'],
}

const REPORT = {
  type: 'object',
  required: ['status', 'summary', 'files', 'harnessTail', 'question'],
  properties: {
    status: { type: 'string', enum: ['done', 'failed', 'blocked'] },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    harnessTail: { type: 'string' },
    question: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['passed', 'failureExcerpt', 'securityFinding', 'diffStat', 'testsWeakened', 'changedFiles', 'baseSha', 'baseInstall', 'argsSha256', 'witnesses'],
  properties: {
    passed: { type: 'boolean' },
    failureExcerpt: { type: 'string' },
    securityFinding: { type: 'string' },
    diffStat: { type: 'string' },
    testsWeakened: { type: 'boolean' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    baseSha: { type: 'string' },
    baseInstall: {
      type: 'object',
      required: ['command', 'exitCode'],
      properties: { command: { type: 'string' }, exitCode: { type: 'integer' } },
    },
    argsSha256: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'exitCode', 'failures'],
        properties: {
          step: { type: 'string' },
          exitCode: { type: 'integer' },
          failures: { type: ['array', 'null'], items: { type: 'string' } },
        },
      },
    },
    setSha256: { type: ['string', 'null'] },
    stagedTree: { type: 'string' },
    unstagedPaths: { type: 'array', items: { type: 'string' } },
    witnesses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'afterExitCode', 'afterExcerpt', 'baseExitCode', 'baseExcerpt', 'ranSha256'],
        properties: {
          criterion: { type: 'string' },
          afterExitCode: { type: 'integer' },
          afterExcerpt: { type: 'string' },
          baseExitCode: { type: 'integer' },
          baseExcerpt: { type: 'string' },
          ranSha256: { type: 'string' },
        },
      },
    },
    contractCheck: {
      type: 'object',
      required: ['command', 'exitCode', 'excerpt'],
      properties: {
        command: { type: 'string' },
        exitCode: { type: 'integer' },
        excerpt: { type: 'string' },
      },
    },
  },
}

const SPEC = {
  type: 'object',
  required: ['decision', 'contractChanges', 'compositionChanges', 'constraints', 'acceptance', 'files'],
  properties: {
    decision: { type: 'string' },
    contractChanges: { type: 'string' },
    compositionChanges: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
  },
}

const DESIGN_RECOVERY = 'Re-run this task one class lower with the design written into the brief. That is the measured route out: three of three such re-runs on the construct\'s own repository produced the design the architect had failed to return. The run does not retry the design step itself, because a second agent entry pays for the exploration again.'

const NO_ACCEPTANCE_QUESTION = 'Pass the acceptance from the brief in args.acceptance. The ladder reports done only when each item was witnessed red before the change and green after it, and with no item there is nothing to witness.'

const UNDIGESTED_BRIEF = 'Every acceptance item needs its witness digest fixed in the brief before the run, in args.witnessDigests as { criterion, sha256 } with the criterion copied verbatim. No digest for:'

const NO_ARGS_FILE_QUESTION = 'Pass the args file the build wrote: args.argsPath, its path, and args.argsSha256, the 64 hex characters of its sha256, as check-acceptance.mjs build --out printed them. The ladder reads the witnesses and the design from that file by its hash, never from the Workflow input.'

const SHA256_HEX = /^[0-9a-f]{64}$/

const NO_BASE_SHA = 'the harness reported no base sha, so no witness can run against the base'

const SHELL_CANNOT_RUN = [126, 127]
const SHELL_SYNTAX_ERROR_EXIT = 2
const SHELL_SYNTAX_ERROR = /syntax error/
const TEMPORARY_PATH = /(?<=^|[\s'"(])(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"]*/g
const TEMPORARY_PATH_PLACEHOLDER = '<tmp>'
const MISSING_TOOL = /command not found|Cannot find (?:module|package) '(?![./])[^']+'|ERR_MODULE_NOT_FOUND[^\n]*'(?![./])[^']+'/

const HARNESS_COMMAND_QUESTION = 'Name the harness command: pass args.harness.command, taken from construct.json (harness.command) or, in an attached repository, from .construct/attach.json. Nothing is assumed.'

const DEFAULT_RETRY_LIMIT = 0
const DESIGN_EFFORT = 'xhigh'
const EFFORT_WITHOUT_DESIGN = { high: 'medium', xhigh: 'medium' }

const task = args.task
const argsPath = args.argsPath
const argsSha256 = args.argsSha256
const agreedSha256 = args.agreedSha256
const hasDesign = args.hasDesign === true
const acceptance = args.acceptance ?? []
const invariants = args.invariants ?? []
const immutable = args.immutable ?? []
const sketch = args.sketch ?? null
const witnessDigests = (args.witnessDigests ?? []).filter(digest => acceptance.includes(digest.criterion))
for (const item of acceptance)
  log(`acceptance: ${item}`)
const harness = { extra: [], contractPaths: [], contractCheck: '', ...(args.harness ?? {}) }
const contractDeclared = harness.contractPaths.length > 0 && typeof harness.contractCheck === 'string' && harness.contractCheck !== ''
if (typeof argsPath !== 'string' || argsPath === '' || typeof argsSha256 !== 'string' || !SHA256_HEX.test(argsSha256))
  return { status: 'blocked', attempts: [], question: NO_ARGS_FILE_QUESTION, acceptance, invariants, immutable }
if (typeof harness.command !== 'string' || harness.command === '')
  return { status: 'blocked', attempts: [], question: HARNESS_COMMAND_QUESTION, acceptance, invariants, immutable }
if (acceptance.length === 0)
  return { status: 'blocked', attempts: [], question: NO_ACCEPTANCE_QUESTION, acceptance, invariants, immutable }
const withoutDigest = acceptance.filter(item => !witnessDigests.some(digest => digest.criterion === item))
if (withoutDigest.length > 0)
  return { status: 'blocked', attempts: [], question: `${UNDIGESTED_BRIEF} ${withoutDigest.join(' | ')}`, acceptance, invariants, immutable }
const rungs = LADDERS[args.effort] ?? LADDERS.low
const retryLimit = Number.isInteger(args.retryLimit) && args.retryLimit >= 0 ? args.retryLimit : DEFAULT_RETRY_LIMIT

let lastValidationError = null
let baseFailures = null

function touchesContract(changedFiles) {
  return changedFiles.some(file => harness.contractPaths.includes(file))
}

function retryPrompt(prompt, validationError) {
  return `${prompt}\n\nThe previous response did not match the shape the runtime validates. The validator reported:\n${validationError}\n\nReturn the same fields again with that corrected.`
}

async function askOnce(prompt, options) {
  try {
    const value = await agent(prompt, options)
    return value == null
      ? { value: null, validationError: 'the agent returned no object the schema could validate' }
      : { value, validationError: null }
  }
  catch (error) {
    return { value: null, validationError: String(error?.message ?? error) }
  }
}

async function ask(prompt, options) {
  let validationError = null
  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    const answer = await askOnce(validationError == null ? prompt : retryPrompt(prompt, validationError), options)
    if (answer.value != null) {
      lastValidationError = null
      return answer.value
    }
    validationError = answer.validationError
    log(`${options.label}: response rejected by the schema — ${validationError}`)
  }
  lastValidationError = validationError
  return null
}

function witnessDigestOf(witness) {
  return witnessDigests.find(digest => digest.criterion === witness.criterion)
}

function witnessScriptLines(digest, n) {
  return [
    `node scripts/construct/check-acceptance.mjs witness --args ${argsPath} --sha256 ${argsSha256} --witness-sha256 ${digest.sha256} > <dir>/witness-${n}.sh`,
    `shasum -a 256 <dir>/witness-${n}.sh`,
    `bash <dir>/witness-${n}.sh`,
  ].join('\n')
}

const ARGS_SHA_LINE = `Report the 64 hex characters that \`shasum -a 256 ${argsPath}\` prints, run in the working tree, as argsSha256.`

const DESIGN_LINE = `Design from the brief: read design in ${argsPath} (sha256 ${argsSha256}) before anything else; it is the brief's Design section verbatim, and the file is pinned by that hash.`

function argsMismatchReason(observed) {
  return `${argsPath} has sha256 ${observed}, and the run was given ${argsSha256}`
}

const WITNESS_DIR_LINE = 'Make <dir> once, before the first witness, with mktemp -d, and write the absolute path it printed wherever <dir> stands: it lies outside the repository, so it still resolves after the cd into the base worktree and adds no file to the working tree.'

const BASELINE_SCRIPT = 'node scripts/construct/check-baseline.mjs'

function baselineScriptLine() {
  if (!Array.isArray(harness.steps))
    return ''
  return `Run \`${BASELINE_SCRIPT}\` once, in the working tree, with every step of the harness, each quoted exactly as given:\n${harness.steps.map(step => `- ${step}`).join('\n')}\nReport its \`steps\` verbatim as the verdict's steps, its \`sha256\` as setSha256 (null when it printed null). Retell no failure in your own words: the caller compares the identities item by item. passed is whether every step's exitCode is 0.`
}

function harnessPrompt(baseSha) {
  return [
    `Harness command: ${harness.command}`,
    baseFailures == null ? '' : baselineScriptLine(),
    harness.extra.length > 0 ? `Extra commands for the area this task touches: ${harness.extra.join(' && ')}` : '',
    ARGS_SHA_LINE,
    `${WITNESS_DIR_LINE}\n\nWitness each acceptance criterion. The witnesses are held in ${argsPath}, whose sha256 is ${argsSha256}, one command per criterion; extract each one from that file with the first line below, in the working tree and before the base worktree is made, record its sha256, then run it exactly as extracted — never edit or substitute it. The extraction refuses a file whose sha256 is not ${argsSha256}: when it exits non-zero, report that witness with afterExitCode 2, its stderr as afterExcerpt and an empty ranSha256, and run nothing for it:\n${witnessDigests.map((digest, index) => `- ${digest.criterion}\n${witnessScriptLines(digest, index + 1)}`).join('\n')}`,
    `For each one, run \`bash <dir>/witness-N.sh\` in the working tree and report its exit code as afterExitCode and its last lines as afterExcerpt. Then run the same script against the base in a worktree of its own, outside the repository, created, installed and removed in one shell so the worktree goes even when a step fails: \`base=$(mktemp -d) && git worktree add --detach "$base" ${baseSha} && trap 'git worktree remove --force "$base"' EXIT && cd "$base" && <install> && bash <dir>/witness-N.sh\`. Install the way the repository installs from its lockfile, and report that command and its exit code as baseInstall; if the install fails or you do not run one, say so there and do not run the witnesses on the base. Report each witness's exit code there as baseExitCode and its last lines as baseExcerpt. Report the sha256 you recorded with shasum as ranSha256. The working tree has one writer: never stash, check out, move or rewrite a file in it to reach the base. Copy the criterion verbatim.`,
    contractDeclared ? `A contract check is declared for this repository: ${harness.contractCheck}. After the harness command passed, run it in the working tree and report it as contractCheck, with the command as given as command, its exit code as exitCode and its last lines as excerpt.` : '',
    sketch == null ? '' : `The base is ${baseSha}, without the sketch ${sketch.branch} @ ${sketch.sha}: the witnesses run red-before there, never on a tree that contains the sketch.`,
    `Verify the current working tree and return the verdict object, with baseSha ${baseSha}.`,
  ].filter(Boolean).join('\n\n')
}

function architectPrompt(reason) {
  return [
    `Task: ${task}`,
    acceptance.length > 0 ? `Acceptance criteria so far:\n- ${acceptance.join('\n- ')}` : '',
    hasDesign ? DESIGN_LINE : '',
    reason,
    'Return the design spec object.',
  ].filter(Boolean).join('\n\n')
}

function identitiesOf(failuresByStep) {
  return Object.entries(failuresByStep).flatMap(([step, failures]) => failures.map(failure => `${step} › ${failure}`))
}

function multisetDifference(left, right) {
  const remaining = [...right]
  return left.filter((item) => {
    const index = remaining.indexOf(item)
    if (index === -1)
      return true
    remaining.splice(index, 1)
    return false
  })
}

function verdictStep(verdict, step) {
  return Array.isArray(verdict?.steps) ? verdict.steps.find(entry => entry.step === step) : undefined
}

function stepWithinTheBase(entry, known) {
  if (entry == null)
    return false
  if (entry.exitCode === 0)
    return true
  return Array.isArray(entry.failures) && entry.failures.length > 0 && multisetDifference(entry.failures, known).length === 0
}

function withinTheBase(verdict) {
  return Object.entries(baseFailures).every(([step, known]) => stepWithinTheBase(verdictStep(verdict, step), known))
}

function newFailuresOf(verdict) {
  return Object.entries(baseFailures).flatMap(([step, known]) => {
    const entry = verdictStep(verdict, step)
    if (entry == null)
      return [`${step} › not reported by the harness`]
    if (entry.exitCode === 0)
      return []
    const added = Array.isArray(entry.failures) ? multisetDifference(entry.failures, known).map(failure => `${step} › ${failure}`) : []
    return added.length > 0 || stepWithinTheBase(entry, known) ? added : [`${step} › red with no identified failure`]
  })
}

function fixedOnTheWayOf(verdict) {
  return Object.entries(baseFailures).flatMap(([step, known]) => {
    const entry = verdictStep(verdict, step)
    if (entry == null || (entry.exitCode !== 0 && !Array.isArray(entry.failures)))
      return []
    return multisetDifference(known, entry.exitCode === 0 ? [] : entry.failures).map(failure => `${step} › ${failure}`)
  })
}

function implementerPrompt(spec, feedback) {
  return [
    `Task: ${task}`,
    `Acceptance criteria:\n- ${(spec?.acceptance?.length ? spec.acceptance : acceptance).join('\n- ')}`,
    `Harness: ${harness.command}${harness.extra.length > 0 ? ` (plus ${harness.extra.join(' && ')})` : ''}`,
    `Each acceptance criterion is judged by a witness command fixed in the brief before you started; you do not choose, change or add witnesses, and the run is reported done only when each of these fails on the base and passes after your change. The commands are in ${argsPath} (sha256 ${argsSha256}, to be checked with shasum -a 256) as witnesses[], each criterion's command being the one whose sha256 is named after it:\n${witnessDigests.map(digest => `- ${digest.criterion} (sha256 ${digest.sha256})`).join('\n')}`,
    invariants.length > 0 ? `Invariants, true before your change and still true after it (the harness holds them):\n- ${invariants.join('\n- ')}` : '',
    immutable.length > 0 ? `Immutable paths, which you must not change; a rung that changes one fails (a path ending in / covers everything under it):\n- ${immutable.join('\n- ')}` : '',
    hasDesign ? DESIGN_LINE : '',
    spec == null
      ? ''
      : `Design spec from the architect:\n${spec.decision}\n\nContract changes: ${spec.contractChanges || 'none'}\nComposition changes: ${spec.compositionChanges || 'none'}\nConstraints:\n- ${spec.constraints.join('\n- ')}\nFiles: ${spec.files.join(', ')}`,
    baseFailures == null ? '' : `These failures were on the base before any change (by step). They are known and out of this task: do not touch them. The run counts only new ones.\n${identitiesOf(baseFailures).join('\n')}`,
    feedback == null ? '' : `The previous attempt failed the harness. Fix the cause of this before anything else:\n${feedback}`,
    'Return the report object.',
  ].filter(Boolean).join('\n\n')
}

let spec = null
let feedback = null
let failingAsOnTheBase = { rung: 0, criteria: [] }
let designComplete = false
let designFailed = false
let designError = ''
const attempts = []

const NO_CHANGE = 'The previous attempt changed no file. Implement the task; a report without a change is not done.'

function observedFor(fixed, observed) {
  const digest = witnessDigestOf(fixed)
  return digest == null ? undefined : observed.find(witness => witness.criterion === fixed.criterion && witness.ranSha256 === digest.sha256)
}

function failedOnEnvironment(witness) {
  return SHELL_CANNOT_RUN.includes(witness.baseExitCode) || MISSING_TOOL.test(witness.baseExcerpt ?? '')
}

function baseEnvironmentProblem(verdict) {
  const install = verdict.baseInstall
  if (install == null || install.command === '' || install.exitCode !== 0)
    return `the base worktree was not installed (${install?.command || 'no install command ran'}, exit ${install?.exitCode ?? 'none'}), so a red witness there says nothing about behaviour`
  const environmental = witnessDigests.filter(fixed => {
    const witness = observedFor(fixed, verdict.witnesses ?? [])
    return witness != null && failedOnEnvironment(witness)
  })
  return environmental.length === 0 ? null : `a witness could not run on the base for a reason outside the change: ${environmental.map(fixed => fixed.criterion).join(' | ')}`
}

function unwitnessedItems(observed) {
  return witnessDigests
    .filter((fixed) => {
      const witness = observedFor(fixed, observed)
      return witness == null || witness.afterExitCode !== 0 || witness.baseExitCode === 0
    })
    .map(fixed => fixed.criterion)
}

function withoutTemporaryPaths(excerpt) {
  return excerpt.replace(TEMPORARY_PATH, TEMPORARY_PATH_PLACEHOLDER)
}

function failsTheSameWay(witness) {
  return witness.baseExitCode === witness.afterExitCode
    && typeof witness.baseExcerpt === 'string'
    && typeof witness.afterExcerpt === 'string'
    && withoutTemporaryPaths(witness.baseExcerpt) === withoutTemporaryPaths(witness.afterExcerpt)
}

function shellCouldNotRun(witness) {
  return SHELL_CANNOT_RUN.includes(witness.afterExitCode)
    || (witness.afterExitCode === SHELL_SYNTAX_ERROR_EXIT && SHELL_SYNTAX_ERROR.test(witness.afterExcerpt ?? ''))
}

function failingAsOnTheBaseItems(observed) {
  return witnessDigests
    .filter((fixed) => {
      const witness = observedFor(fixed, observed)
      return witness != null && witness.afterExitCode !== 0 && failsTheSameWay(witness)
    })
    .map(fixed => fixed.criterion)
}

function invalidWitnessItems(observed, failingAsOnTheBaseOnThePreviousRung) {
  return witnessDigests
    .filter((fixed) => {
      const witness = observedFor(fixed, observed)
      return witness != null && witness.afterExitCode !== 0
        && (shellCouldNotRun(witness) || (failsTheSameWay(witness) && failingAsOnTheBaseOnThePreviousRung.includes(fixed.criterion)))
    })
    .map(fixed => fixed.criterion)
}

function unrunVerbatimItems(observed) {
  return witnessDigests
    .filter(fixed => observedFor(fixed, observed) == null && observed.some(witness => witness.criterion === fixed.criterion))
    .map(fixed => fixed.criterion)
}

function isImmutable(file) {
  return immutable.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry)
}

function immutableReason(files) {
  return `Changed a path the brief made immutable: ${files.join(' | ')}. Restore it to the base and reach the acceptance without changing it.`
}

function unwitnessedReason(items) {
  return `Not witnessed red before the change and green after it: ${items.join(' | ')}`
}

function unrunVerbatimReason(items) {
  return `Witness not run verbatim: ${items.join(' | ')}`
}

function invalidWitnessReason(items) {
  return `Witness invalid: ${items.join(' | ')}`
}

const CODE_EXTENSION = '(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)'
const SOURCE_FILE = new RegExp(`(?:^|/)src/.*\\.${CODE_EXTENSION}$`)
const DECLARATION_FILE = /\.d\.ts$/
const TEST_FILE = new RegExp(`(?:^|/)tests/(?:.*/)?[^/]+\\.test\\.${CODE_EXTENSION}$`)

function isTestFile(file) {
  return TEST_FILE.test(file)
}

function isSourceFile(file) {
  return SOURCE_FILE.test(file) && !DECLARATION_FILE.test(file)
}

function untestedReason(files) {
  return `Changed source with no test: ${files.join(' | ')}`
}

function ranTheDeclaredContractCheck(check) {
  return check != null && check.command === harness.contractCheck
}

function contractCheckReason(check) {
  if (check == null)
    return 'the harness did not report the contract check'
  if (!ranTheDeclaredContractCheck(check))
    return `the harness reported ${JSON.stringify(check.command)}, not the declared contract check ${JSON.stringify(harness.contractCheck)}`
  const exited = `${harness.contractCheck} exited ${check.exitCode}`
  return check.excerpt === '' ? exited : `${exited}\n${check.excerpt}`
}

async function redesignBeforeLastRung(rung) {
  if (rung !== rungs.length - 1)
    return null
  log(`rung ${rung}/${rungs.length} failed twice: architect redesigns before the last rung`)
  return design(rung, `Two rungs have failed. Latest failure:\n${feedback}\n\nDecide whether the approach, the contract or the boundary is wrong before the last attempt.`, 'design before last rung')
}

function performedEffort(effort) {
  return designComplete ? effort : (EFFORT_WITHOUT_DESIGN[effort] ?? effort)
}

async function design(rung, reason, label) {
  phase('Design')
  const result = await ask(architectPrompt(reason), {
    agentType: 'architect',
    effort: DESIGN_EFFORT,
    phase: 'Design',
    label,
    schema: SPEC,
  })
  if (result == null) {
    designComplete = false
    designFailed = true
    designError = lastValidationError ?? ''
    attempts.push({ rung, effort: DESIGN_EFFORT, outcome: 'design schema invalid', reason: designError })
    log(`${label}: the design step did not complete. ${DESIGN_RECOVERY}`)
    return false
  }
  spec = result
  designComplete = true
  attempts.push({ rung, effort: DESIGN_EFFORT, outcome: 'designed', reason: '' })
  return true
}

function designIncomplete(effort, question) {
  return {
    status: 'design incomplete',
    effort: performedEffort(effort),
    attempts,
    validationError: designError,
    recovery: DESIGN_RECOVERY,
    question: question ?? '',
    lastFailure: feedback ?? '',
    acceptance,
    invariants,
  }
}

function sketchLine() {
  return `Sketch: ${sketch.branch} @ ${sketch.sha}`
}

function baseLine() {
  if (sketch == null)
    return 'This is the base before any change: nothing has been implemented yet, so no diff is expected, testsWeakened is false and witnesses is empty. Return the output of `git rev-parse HEAD` as baseSha.'
  return `This is the base with the sketch the brief names staged on it (${sketchLine()}): nothing has been implemented yet, so the diff is the sketch's tree ${sketch.tree} staged on HEAD and nothing else, testsWeakened is false and witnesses is empty. Before running anything, return the output of \`git write-tree\` as stagedTree, and the paths \`git status --porcelain\` lists with an unstaged or untracked change as unstagedPaths ([] when there is none). Return the output of \`git rev-parse HEAD\` as baseSha. The run, not you, compares stagedTree with the sketch's tree: report what git printed.`
}

function sketchMismatch(verdict) {
  const staged = typeof verdict.stagedTree === 'string' && verdict.stagedTree !== '' ? verdict.stagedTree : '(none reported)'
  return staged === sketch.tree ? null : `sketch tree mismatch: index ${staged} ≠ sketch ${sketch.tree} (${sketchLine()})`
}

function beyondTheSketch(verdict) {
  const paths = verdict.unstagedPaths ?? []
  return paths.length === 0 ? null : `a diff beyond the sketch (${sketchLine()}): ${paths.join(', ')}`
}

function preflightPrompt() {
  return [
    `Harness command: ${harness.command}`,
    harness.extra.length > 0 ? `Extra commands for the area this task touches: ${harness.extra.join(' && ')}` : '',
    baseLine(),
    baselineScriptLine(),
    ARGS_SHA_LINE,
    'Verify the current working tree and return the verdict object.',
  ].filter(Boolean).join('\n')
}

phase('Preflight')
log(`preflight: running ${harness.command} on the base`)
const base = await ask(preflightPrompt(), {
  agentType: 'harness',
  effort: 'low',
  phase: 'Preflight',
  label: 'preflight',
  schema: VERDICT,
})
if (base == null)
  return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'schema invalid', reason: lastValidationError }], validationError: lastValidationError, acceptance, invariants, immutable }
if (base.argsSha256 !== argsSha256) {
  const reason = argsMismatchReason(base.argsSha256)
  return { status: 'args unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'args mismatch', reason }], validationError: reason, acceptance, invariants, immutable }
}
if (typeof base.baseSha !== 'string' || base.baseSha === '')
  return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'schema invalid', reason: NO_BASE_SHA }], validationError: NO_BASE_SHA, acceptance, invariants, immutable }
const mismatch = sketch == null ? null : sketchMismatch(base)
if (mismatch != null)
  return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'sketch mismatch', reason: mismatch }], validationError: mismatch, acceptance, invariants, immutable }
const beyond = sketch == null ? null : beyondTheSketch(base)
if (beyond != null)
  return { status: 'base red', attempts: [{ rung: 0, effort: 'low', outcome: 'base red', reason: beyond }], lastFailure: beyond, acceptance, invariants, immutable }
if (base.passed !== true) {
  const redSteps = (base.steps ?? []).filter(entry => entry.exitCode !== 0)
  const identified = redSteps.length > 0 && redSteps.every(entry => Array.isArray(entry.failures) && entry.failures.length > 0)
  if (!identified)
    return { status: 'base red', attempts: [{ rung: 0, effort: 'low', outcome: 'base red', reason: base.failureExcerpt }], lastFailure: base.failureExcerpt, acceptance, invariants, immutable }
  const missingSteps = Array.isArray(harness.steps) ? harness.steps.filter(step => !base.steps.some(entry => entry.step === step)) : []
  if (missingSteps.length > 0) {
    const reason = `the base is red and its verdict leaves out a step of the harness, so its failure set is not known: ${missingSteps.join(', ')}`
    return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'base unverified', reason }], validationError: reason, acceptance, invariants, immutable }
  }
  if (typeof harness.baseFailuresSha256 !== 'string' || harness.baseFailuresSha256 !== base.setSha256) {
    const reason = `the base is red and its failure set is not the pinned one: the brief pins ${typeof harness.baseFailuresSha256 === 'string' ? harness.baseFailuresSha256 : 'no sha256 (no Base failures line)'}, the harness saw ${base.setSha256 ?? 'none'}`
    return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'base unverified', reason }], validationError: reason, acceptance, invariants, immutable }
  }
  baseFailures = Object.fromEntries(base.steps.map(entry => [entry.step, Array.isArray(entry.failures) ? entry.failures : []]))
  log(`preflight: the base is red with ${identitiesOf(baseFailures).length} known failures, pinned by ${harness.baseFailuresSha256}`)
}

for (const [index, effort] of rungs.entries()) {
  const rung = index + 1

  if (rung === 1 && args.effort === 'high') {
    const designed = await design(rung, 'The task is classified as high effort; design it before any implementation.', 'design')
    if (!designed)
      return designIncomplete(effort)
  }

  phase('Implement')
  log(`rung ${rung}/${rungs.length} @ ${effort}: implementing`)
  const report = await ask(implementerPrompt(spec, feedback), {
    agentType: 'implementer',
    effort,
    phase: 'Implement',
    label: `implement ${rung}/${rungs.length} @ ${effort}`,
    schema: REPORT,
  })
  if (report == null) {
    attempts.push({ rung, effort, outcome: 'schema invalid', reason: lastValidationError })
    continue
  }

  if (report.status === 'blocked') {
    attempts.push({ rung, effort, outcome: 'blocked', reason: report.question, question: report.question })
    if (rung === rungs.length)
      return { status: 'blocked', question: report.question, attempts, acceptance, invariants, immutable }
    const designed = await design(rung, `The implementer stopped on this question:\n${report.question}`, `design after blocked ${rung}`)
    if (!designed && args.effort === 'high')
      return designIncomplete(effort, report.question)
    feedback = null
    log(`rung ${rung}/${rungs.length} @ ${effort}: blocked, architect ${designed ? 'answered' : 'did not answer'}`)
    continue
  }

  if (report.files.length === 0) {
    feedback = NO_CHANGE
    attempts.push({ rung, effort, outcome: 'no change', reason: 'the implementer reported no changed file', securityFinding: '' })
    log(`rung ${rung} @ ${effort}: no change`)
    const designed = await redesignBeforeLastRung(rung)
    if (designed === false && args.effort === 'high')
      return designIncomplete(effort)
    continue
  }

  phase('Verify')
  log(`rung ${rung}/${rungs.length} @ ${effort}: running ${harness.command}`)
  const verdict = await ask(harnessPrompt(base.baseSha), {
    agentType: 'harness',
    effort: 'low',
    phase: 'Verify',
    label: `verify ${rung}/${rungs.length}`,
    schema: VERDICT,
  })
  if (verdict != null && verdict.argsSha256 !== argsSha256) {
    const reason = argsMismatchReason(verdict.argsSha256)
    attempts.push({ rung, effort, outcome: 'args mismatch', reason, securityFinding: verdict.securityFinding ?? '' })
    return { status: 'args unverified', attempts, validationError: reason, acceptance, invariants, immutable }
  }
  const harnessPassed = baseFailures == null
    ? verdict?.passed === true && verdict.testsWeakened === false
    : verdict != null && verdict.testsWeakened === false && withinTheBase(verdict)
  const newOnRedBase = baseFailures != null && verdict != null && !harnessPassed ? newFailuresOf(verdict).join('\n') : ''
  const unchanged = harnessPassed && verdict.changedFiles.length === 0
  const environment = harnessPassed && !unchanged ? baseEnvironmentProblem(verdict) : null
  if (environment != null) {
    attempts.push({ rung, effort, outcome: 'base environment', reason: environment, securityFinding: verdict.securityFinding ?? '' })
    return { status: 'base unverified', attempts, validationError: environment, acceptance, invariants, immutable }
  }
  const touchedImmutable = harnessPassed && !unchanged ? verdict.changedFiles.filter(isImmutable) : []
  const unrun = harnessPassed && !unchanged && touchedImmutable.length === 0 ? unrunVerbatimItems(verdict.witnesses ?? []) : []
  const witnessesReached = harnessPassed && !unchanged && touchedImmutable.length === 0 && unrun.length === 0
  const failingAsOnTheBaseOnThePreviousRung = failingAsOnTheBase.rung === rung - 1 ? failingAsOnTheBase.criteria : []
  failingAsOnTheBase = { rung, criteria: witnessesReached ? failingAsOnTheBaseItems(verdict.witnesses ?? []) : [] }
  const invalid = witnessesReached ? invalidWitnessItems(verdict.witnesses ?? [], failingAsOnTheBaseOnThePreviousRung) : []
  const unwitnessed = harnessPassed && !unchanged && touchedImmutable.length === 0 && unrun.length === 0 && invalid.length === 0 ? unwitnessedItems(verdict.witnesses ?? []) : []
  const changedSourceFiles = harnessPassed && !unchanged ? verdict.changedFiles.filter(isSourceFile) : []
  const untested = harnessPassed && !unchanged && touchedImmutable.length === 0 && unrun.length === 0 && invalid.length === 0 && unwitnessed.length === 0
    && changedSourceFiles.length > 0 && !verdict.changedFiles.some(isTestFile)
  const contractCheckFailed = harnessPassed && !unchanged && touchedImmutable.length === 0 && unrun.length === 0 && invalid.length === 0 && unwitnessed.length === 0 && !untested
    && contractDeclared && (!ranTheDeclaredContractCheck(verdict.contractCheck) || verdict.contractCheck.exitCode !== 0)
  const passed = harnessPassed && !unchanged && touchedImmutable.length === 0 && unrun.length === 0 && invalid.length === 0 && unwitnessed.length === 0 && !untested && !contractCheckFailed
  attempts.push(verdict == null
    ? { rung, effort, outcome: 'schema invalid', reason: lastValidationError, securityFinding: '' }
    : {
        rung,
        effort,
        outcome: passed ? 'passed' : !harnessPassed ? 'harness failed' : unchanged ? 'no change' : touchedImmutable.length > 0 ? 'immutable changed' : unrun.length > 0 ? 'witness not run verbatim' : invalid.length > 0 ? 'witness invalid' : unwitnessed.length > 0 ? 'acceptance not witnessed' : untested ? 'untested change' : 'contract check failed',
        reason: passed
          ? ''
          : !harnessPassed
              ? (verdict.testsWeakened ? 'a test was deleted, skipped or narrowed' : baseFailures == null ? verdict.failureExcerpt : newOnRedBase)
              : unchanged ? 'the harness saw no changed file' : touchedImmutable.length > 0 ? immutableReason(touchedImmutable) : unrun.length > 0 ? unrunVerbatimReason(unrun) : invalid.length > 0 ? invalidWitnessReason(invalid) : unwitnessed.length > 0 ? unwitnessedReason(unwitnessed) : untested ? untestedReason(changedSourceFiles) : contractCheckReason(verdict.contractCheck),
        securityFinding: verdict.securityFinding ?? '',
      })
  log(`rung ${rung} @ ${effort}: ${attempts.at(-1).outcome}`)

  if (invalid.length > 0)
    return { status: 'base unverified', attempts, validationError: invalidWitnessReason(invalid), acceptance, invariants, immutable }

  if (passed) {
    return {
      status: designFailed && !designComplete ? 'degraded' : 'done',
      effort: performedEffort(effort),
      argsSha256,
      agreedSha256,
      attempts,
      files: report.files,
      summary: report.summary,
      harnessTail: report.harnessTail,
      contractChanged: touchesContract(verdict.changedFiles),
      changedFiles: verdict.changedFiles,
      diffStat: verdict.diffStat,
      ...(baseFailures == null ? {} : { onRedBase: true, knownBaseFailures: identitiesOf(baseFailures).length, newFailures: 0, fixedOnTheWay: fixedOnTheWayOf(verdict) }),
      acceptance,
      invariants,
      immutable,
    }
  }

  feedback = verdict == null
    ? `The harness produced no verdict the schema could validate: ${lastValidationError}`
    : verdict.testsWeakened
      ? `A test was deleted, skipped or narrowed. Restore it and make the implementation pass it.${baseFailures == null ? `\n${verdict.failureExcerpt}` : ''}`
      : !harnessPassed
          ? (baseFailures == null ? verdict.failureExcerpt : `The change added failures the base did not have:\n${newOnRedBase}`)
          : unchanged
            ? NO_CHANGE
            : touchedImmutable.length > 0
              ? immutableReason(touchedImmutable)
              : unrun.length > 0
                ? `${unrunVerbatimReason(unrun)} Decode the witness exactly as given and run it unedited.`
                : unwitnessed.length > 0
                  ? `${unwitnessedReason(unwitnessed)} Each criterion needs a command that fails on the base and passes after the change.`
                  : untested
                    ? `${untestedReason(changedSourceFiles)} Ship the matching test in the same change.`
                    : contractCheckReason(verdict.contractCheck)
  if (verdict?.securityFinding)
    feedback = `Security invariant failed: ${verdict.securityFinding}\n${feedback}`

  const designed = await redesignBeforeLastRung(rung)
  if (designed === false && args.effort === 'high')
    return designIncomplete(effort)
}

return { status: 'failed', attempts, lastFailure: feedback, effort: performedEffort(rungs[rungs.length - 1]), acceptance, invariants, immutable }
