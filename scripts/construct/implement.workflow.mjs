export const meta = {
  name: 'implement',
  description: 'Implement a task at low effort, verify with the harness, escalate on repeated failure or ambiguity',
  phases: [
    { title: 'Preflight', detail: 'harness against the base before any change; a red base stops the run' },
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
  required: ['passed', 'failureExcerpt', 'securityFinding', 'diffStat', 'testsWeakened', 'changedFiles', 'baseSha', 'witnesses'],
  properties: {
    passed: { type: 'boolean' },
    failureExcerpt: { type: 'string' },
    securityFinding: { type: 'string' },
    diffStat: { type: 'string' },
    testsWeakened: { type: 'boolean' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    baseSha: { type: 'string' },
    witnesses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'command', 'redBefore', 'greenAfter', 'excerpt'],
        properties: {
          criterion: { type: 'string' },
          command: { type: 'string' },
          redBefore: { type: 'boolean' },
          greenAfter: { type: 'boolean' },
          excerpt: { type: 'string' },
        },
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

const UNWITNESSED_BRIEF = 'Every acceptance item needs its witness fixed in the brief before the run, in args.witnesses as { criterion, command } with the criterion copied verbatim. No witness for:'

const NO_BASE_SHA = 'the harness reported no base sha, so no witness can run against the base'

const HARNESS_COMMAND_QUESTION = 'Name the harness command: pass args.harness.command, taken from construct.json (harness.command) or, in an attached repository, from .construct/attach.json. Nothing is assumed.'

const DEFAULT_RETRY_LIMIT = 0
const DESIGN_EFFORT = 'xhigh'
const EFFORT_WITHOUT_DESIGN = { high: 'medium', xhigh: 'medium' }

const task = args.task
const acceptance = args.acceptance ?? []
const invariants = args.invariants ?? []
const witnesses = (args.witnesses ?? []).filter(witness => acceptance.includes(witness.criterion))
for (const item of acceptance)
  log(`acceptance: ${item}`)
const harness = { extra: [], contractPaths: [], ...(args.harness ?? {}) }
if (typeof harness.command !== 'string' || harness.command === '')
  return { status: 'blocked', attempts: [], question: HARNESS_COMMAND_QUESTION, acceptance, invariants }
if (acceptance.length === 0)
  return { status: 'blocked', attempts: [], question: NO_ACCEPTANCE_QUESTION, acceptance, invariants }
const withoutWitness = acceptance.filter(item => !witnesses.some(witness => witness.criterion === item))
if (withoutWitness.length > 0)
  return { status: 'blocked', attempts: [], question: `${UNWITNESSED_BRIEF} ${withoutWitness.join(' | ')}`, acceptance, invariants }
const rungs = LADDERS[args.effort] ?? LADDERS.low
const retryLimit = Number.isInteger(args.retryLimit) && args.retryLimit >= 0 ? args.retryLimit : DEFAULT_RETRY_LIMIT

let lastValidationError = null

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

function harnessPrompt(baseSha) {
  return [
    `Harness command: ${harness.command}`,
    harness.extra.length > 0 ? `Extra commands for the area this task touches: ${harness.extra.join(' && ')}` : '',
    `Witness each acceptance criterion with the command the brief fixed for it:\n${witnesses.map(witness => `- ${witness.criterion}\n  command: ${witness.command}`).join('\n')}`,
    `For each one, run the command in the working tree: greenAfter is true only when it exits 0. Then run it against the base in a worktree of its own, outside the repository: \`git worktree add --detach <a new temporary directory> ${baseSha}\`, install dependencies there the way the harness would, run the same command in it (redBefore is true only when it exits non-zero), and remove it with \`git worktree remove --force\`. The working tree has one writer: never stash, check out, move or rewrite a file in it to reach the base. Copy the criterion and the command verbatim, and carry the output of the base run in excerpt.`,
    `Verify the current working tree and return the verdict object, with baseSha ${baseSha}.`,
  ].filter(Boolean).join('\n\n')
}

function architectPrompt(reason) {
  return [
    `Task: ${task}`,
    acceptance.length > 0 ? `Acceptance criteria so far:\n- ${acceptance.join('\n- ')}` : '',
    reason,
    'Return the design spec object.',
  ].filter(Boolean).join('\n\n')
}

function implementerPrompt(spec, feedback) {
  return [
    `Task: ${task}`,
    `Acceptance criteria:\n- ${(spec?.acceptance?.length ? spec.acceptance : acceptance).join('\n- ')}`,
    `Harness: ${harness.command}${harness.extra.length > 0 ? ` (plus ${harness.extra.join(' && ')})` : ''}`,
    `Each acceptance criterion is judged by a witness command fixed in the brief before you started; you do not choose, change or add witnesses, and the run is reported done only when each of these fails on the base and passes after your change:\n${witnesses.map(witness => `- ${witness.criterion}\n  witness: ${witness.command}`).join('\n')}`,
    invariants.length > 0 ? `Invariants, true before your change and still true after it (the harness holds them):\n- ${invariants.join('\n- ')}` : '',
    spec == null
      ? ''
      : `Design spec from the architect:\n${spec.decision}\n\nContract changes: ${spec.contractChanges || 'none'}\nComposition changes: ${spec.compositionChanges || 'none'}\nConstraints:\n- ${spec.constraints.join('\n- ')}\nFiles: ${spec.files.join(', ')}`,
    feedback == null ? '' : `The previous attempt failed the harness. Fix the cause of this before anything else:\n${feedback}`,
    'Return the report object.',
  ].filter(Boolean).join('\n\n')
}

let spec = null
let feedback = null
let designComplete = false
let designFailed = false
let designError = ''
const attempts = []

const NO_CHANGE = 'The previous attempt changed no file. Implement the task; a report without a change is not done.'

function unwitnessedItems(observed) {
  return witnesses
    .filter(fixed => !observed.some(witness => witness.criterion === fixed.criterion && witness.command === fixed.command && witness.redBefore === true && witness.greenAfter === true))
    .map(fixed => fixed.criterion)
}

function unwitnessedReason(items) {
  return `Not witnessed red before the change and green after it: ${items.join(' | ')}`
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

function preflightPrompt() {
  return [
    `Harness command: ${harness.command}`,
    harness.extra.length > 0 ? `Extra commands for the area this task touches: ${harness.extra.join(' && ')}` : '',
    'This is the base before any change: nothing has been implemented yet, so no diff is expected, testsWeakened is false and witnesses is empty. Return the output of `git rev-parse HEAD` as baseSha. Verify the current working tree and return the verdict object.',
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
  return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'schema invalid', reason: lastValidationError }], validationError: lastValidationError, acceptance, invariants }
if (typeof base.baseSha !== 'string' || base.baseSha === '')
  return { status: 'base unverified', attempts: [{ rung: 0, effort: 'low', outcome: 'schema invalid', reason: NO_BASE_SHA }], validationError: NO_BASE_SHA, acceptance, invariants }
if (base.passed !== true)
  return { status: 'base red', attempts: [{ rung: 0, effort: 'low', outcome: 'base red', reason: base.failureExcerpt }], lastFailure: base.failureExcerpt, acceptance, invariants }

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
      return { status: 'blocked', question: report.question, attempts, acceptance, invariants }
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
  const harnessPassed = verdict?.passed === true && verdict.testsWeakened === false
  const unchanged = harnessPassed && verdict.changedFiles.length === 0
  const unwitnessed = harnessPassed && !unchanged ? unwitnessedItems(verdict.witnesses ?? []) : []
  const passed = harnessPassed && !unchanged && unwitnessed.length === 0
  attempts.push(verdict == null
    ? { rung, effort, outcome: 'schema invalid', reason: lastValidationError, securityFinding: '' }
    : {
        rung,
        effort,
        outcome: passed ? 'passed' : !harnessPassed ? 'harness failed' : unchanged ? 'no change' : 'acceptance not witnessed',
        reason: passed
          ? ''
          : !harnessPassed
              ? (verdict.testsWeakened ? 'a test was deleted, skipped or narrowed' : verdict.failureExcerpt)
              : unchanged ? 'the harness saw no changed file' : unwitnessedReason(unwitnessed),
        securityFinding: verdict.securityFinding ?? '',
      })
  log(`rung ${rung} @ ${effort}: ${attempts.at(-1).outcome}`)

  if (passed) {
    return {
      status: designFailed && !designComplete ? 'degraded' : 'done',
      effort: performedEffort(effort),
      attempts,
      files: report.files,
      summary: report.summary,
      harnessTail: report.harnessTail,
      contractChanged: touchesContract(verdict.changedFiles),
      changedFiles: verdict.changedFiles,
      diffStat: verdict.diffStat,
      acceptance,
      invariants,
    }
  }

  feedback = verdict == null
    ? `The harness produced no verdict the schema could validate: ${lastValidationError}`
    : verdict.testsWeakened
      ? `A test was deleted, skipped or narrowed. Restore it and make the implementation pass it.\n${verdict.failureExcerpt}`
      : !harnessPassed
          ? verdict.failureExcerpt
          : unchanged ? NO_CHANGE : `${unwitnessedReason(unwitnessed)} Each criterion needs a command that fails on the base and passes after the change.`
  if (verdict?.securityFinding)
    feedback = `Security invariant failed: ${verdict.securityFinding}\n${feedback}`

  const designed = await redesignBeforeLastRung(rung)
  if (designed === false && args.effort === 'high')
    return designIncomplete(effort)
}

return { status: 'failed', attempts, lastFailure: feedback, effort: performedEffort(rungs[rungs.length - 1]), acceptance, invariants }
