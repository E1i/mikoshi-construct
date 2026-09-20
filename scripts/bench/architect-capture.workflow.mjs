export const meta = {
  name: 'architect-capture',
  description: 'Run the architect alone against each brief and record what the design step returned',
  phases: [{ title: 'Design', detail: 'one architect entry per brief, the same call the ladder makes' }],
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

const DESIGN_EFFORT = 'xhigh'

const briefs = args.briefs ?? []
const stopAfterTokens = args.stopAfterTokens ?? null

const results = []
let spentBefore = budget.spent ?? 0

for (const brief of briefs) {
  if (stopAfterTokens != null && (budget.spent ?? 0) >= stopAfterTokens) {
    log(`stopping before ${brief.name}: ${budget.spent} tokens spent, limit ${stopAfterTokens}`)
    break
  }

  phase('Design')
  let design = null
  let validationError = ''
  try {
    design = await agent(brief.text, {
      agentType: 'architect',
      effort: DESIGN_EFFORT,
      phase: 'Design',
      label: `design ${brief.name}`,
      schema: SPEC,
    })
  }
  catch (error) {
    validationError = String(error?.message ?? error)
  }

  const spentAfter = budget.spent ?? 0
  results.push({
    brief: brief.name,
    returned: design != null,
    validationError,
    tokens: spentAfter - spentBefore,
    design,
  })
  spentBefore = spentAfter
  log(`${brief.name}: ${design == null ? `returned nothing — ${validationError}` : 'returned a design'}`)
}

return { effort: DESIGN_EFFORT, spent: budget.spent ?? null, results }
