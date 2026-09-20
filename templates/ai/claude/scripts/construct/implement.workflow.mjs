export const meta = {
  name: 'implement',
  description: 'Implement a task at low effort, verify with the harness, escalate on repeated failure or ambiguity',
  phases: [
    { title: 'Design', detail: 'architect inside the run, for high effort before the first rung and after a blocked or failed attempt' },
    { title: 'Implement', detail: 'implementer at the current rung' },
    { title: 'Verify', detail: 'harness against the working tree' },
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
  required: ['passed', 'failureExcerpt', 'securityFinding', 'diffStat', 'testsWeakened', 'contractChanged'],
  properties: {
    passed: { type: 'boolean' },
    failureExcerpt: { type: 'string' },
    securityFinding: { type: 'string' },
    diffStat: { type: 'string' },
    testsWeakened: { type: 'boolean' },
    contractChanged: { type: 'boolean' },
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

const DEFAULT_RETRY_LIMIT = 0
const DESIGN_EFFORT = 'xhigh'
const EFFORT_WITHOUT_DESIGN = { high: 'medium', xhigh: 'medium' }

const task = args.task
const acceptance = args.acceptance ?? []
const harness = { command: 'pnpm run quality', extra: [], ...(args.harness ?? {}) }
const rungs = LADDERS[args.effort] ?? LADDERS.low
const retryLimit = Number.isInteger(args.retryLimit) && args.retryLimit >= 0 ? args.retryLimit : DEFAULT_RETRY_LIMIT

let lastValidationError = null

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

function harnessPrompt() {
  return [
    `Harness command: ${harness.command}`,
    harness.extra.length > 0 ? `Extra commands for the area this task touches: ${harness.extra.join(' && ')}` : '',
    'Verify the current working tree and return the verdict object.',
  ].filter(Boolean).join('\n')
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
  }
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
      return { status: 'blocked', question: report.question, attempts }
    const designed = await design(rung, `The implementer stopped on this question:\n${report.question}`, `design after blocked ${rung}`)
    if (!designed && args.effort === 'high')
      return designIncomplete(effort, report.question)
    feedback = null
    log(`rung ${rung}/${rungs.length} @ ${effort}: blocked, architect ${designed ? 'answered' : 'did not answer'}`)
    continue
  }

  phase('Verify')
  log(`rung ${rung}/${rungs.length} @ ${effort}: running ${harness.command}`)
  const verdict = await ask(harnessPrompt(), {
    agentType: 'harness',
    effort: 'low',
    phase: 'Verify',
    label: `verify ${rung}/${rungs.length}`,
    schema: VERDICT,
  })
  const passed = verdict?.passed === true && verdict.testsWeakened === false
  attempts.push(verdict == null
    ? { rung, effort, outcome: 'schema invalid', reason: lastValidationError, securityFinding: '' }
    : {
        rung,
        effort,
        outcome: passed ? 'passed' : 'harness failed',
        reason: passed ? '' : (verdict.testsWeakened ? 'a test was deleted, skipped or narrowed' : verdict.failureExcerpt),
        securityFinding: verdict.securityFinding ?? '',
      })
  log(`rung ${rung} @ ${effort}: ${passed ? 'harness passed' : 'harness failed'}`)

  if (passed) {
    return {
      status: designFailed && !designComplete ? 'degraded' : 'done',
      effort: performedEffort(effort),
      attempts,
      files: report.files,
      summary: report.summary,
      harnessTail: report.harnessTail,
      contractChanged: verdict.contractChanged,
      diffStat: verdict.diffStat,
    }
  }

  feedback = verdict == null
    ? `The harness produced no verdict the schema could validate: ${lastValidationError}`
    : verdict.testsWeakened
      ? `A test was deleted, skipped or narrowed. Restore it and make the implementation pass it.\n${verdict.failureExcerpt}`
      : verdict.failureExcerpt
  if (verdict?.securityFinding)
    feedback = `Security invariant failed: ${verdict.securityFinding}\n${feedback}`

  if (rung === rungs.length - 1) {
    log(`rung ${rung}/${rungs.length} failed twice: architect redesigns before the last rung`)
    const designed = await design(rung, `Two rungs have failed the harness. Latest failure:\n${feedback}\n\nDecide whether the approach, the contract or the boundary is wrong before the last attempt.`, 'design before last rung')
    if (!designed && args.effort === 'high')
      return designIncomplete(effort)
  }
}

return { status: 'failed', attempts, lastFailure: feedback, effort: performedEffort(rungs[rungs.length - 1]) }
