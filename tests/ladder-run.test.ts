import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow.mjs'

interface LadderResult {
  status: string
  recovery?: string
  effort?: string
  attempts: { rung: number, effort: string, outcome: string, reason: string }[]
  validationError?: string
  question?: string
  lastFailure?: string
}

interface AgentCall {
  agentType: string
  prompt: string
}

type Reply = unknown | Error

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<LadderResult>

function ladder(): (...values: unknown[]) => Promise<LadderResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)
}

const SPEC = {
  decision: 'keep the change local',
  contractChanges: '',
  compositionChanges: '',
  constraints: ['no new dependency'],
  acceptance: ['the harness is green'],
  files: ['scripts/construct/implement.workflow.mjs'],
}

const REPORT = { status: 'done', summary: 'changed the ladder', files: ['a.ts'], harnessTail: 'ok', question: '' }
const BLOCKED = { status: 'blocked', summary: '', files: [], harnessTail: '', question: 'which of the two designs?' }
const GREEN = { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, contractChanged: false }
const RED = { passed: false, failureExcerpt: 'vitest failed', securityFinding: '', diffStat: '', testsWeakened: false, contractChanged: false }

const REJECTED = new Error('SPEC: decision: missing')

async function run(args: Record<string, unknown>, replies: Record<string, Reply[]>, base: Reply = GREEN): Promise<{ result: LadderResult, calls: AgentCall[] }> {
  const queues: Record<string, Reply[]> = { architect: [], implementer: [], ...replies, harness: [base, ...(replies.harness ?? [])] }
  const calls: AgentCall[] = []
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    calls.push({ agentType: options.agentType, prompt })
    const reply = queues[options.agentType].shift()
    if (reply instanceof Error)
      throw reply
    return reply ?? null
  }
  const result = await ladder()({ harness: { command: 'pnpm run quality' }, ...args }, agent, () => {}, () => {})
  return { result, calls }
}

describe('the design step is part of the run', () => {
  it('records an architect rejected by the schema in the attempts the ladder returns', async () => {
    const { result } = await run({ task: 'redesign the contract', effort: 'high' }, { architect: [REJECTED] })

    expect(result.attempts).toEqual([{ rung: 1, effort: 'xhigh', outcome: 'design schema invalid', reason: REJECTED.message }])
  })

  it('names a schema rejection apart from a harness failure and from a blocked report', async () => {
    const { result } = await run({ task: 'add a rule', effort: 'medium' }, {
      implementer: [BLOCKED, REPORT, REPORT],
      architect: [REJECTED, SPEC],
      harness: [RED, GREEN],
    })

    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['blocked', 'design schema invalid', 'harness failed', 'designed', 'passed'])
  })

  it('blocks a high run when the architect fails, carrying the validator error and running no implementer', async () => {
    const { result, calls } = await run({ task: 'change the composition model', effort: 'high' }, { architect: [REJECTED] })

    expect(result.status).toBe('design incomplete')
    expect(result.validationError).toBe(REJECTED.message)
    expect(calls.map(call => call.agentType)).toEqual(['harness', 'architect'])
  })

  it('lets a medium run continue after a failed architect but never reports it as a plain success', async () => {
    const { result, calls } = await run({ task: 'add an endpoint', effort: 'medium' }, {
      implementer: [BLOCKED, REPORT],
      architect: [REJECTED],
      harness: [GREEN],
    })

    expect(result.status).toBe('degraded')
    expect(calls.filter(call => call.agentType === 'implementer')).toHaveLength(2)
    expect(result.attempts.some(attempt => attempt.outcome === 'design schema invalid')).toBe(true)
  })

  it('reports the effort that executed, not the class the rung asked for, when the design was skipped', async () => {
    const { result } = await run({ task: 'fix the ladder', effort: 'low' }, {
      implementer: [REPORT, REPORT, REPORT, REPORT],
      architect: [REJECTED],
      harness: [RED, RED, RED, GREEN],
    })

    expect(result.attempts.at(-1)).toMatchObject({ rung: 4, effort: 'high', outcome: 'passed' })
    expect(result.effort).toBe('medium')
    expect(result.status).toBe('degraded')
  })

  it('records a design that completed, so a run cannot claim high with nothing to show for the step', async () => {
    const { result } = await run({ task: 't', acceptance: [], effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [GREEN] })
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['designed', 'passed'])
    expect(result.effort).toBe('high')
  })

  it('reports high when the design completed and the first rung is green', async () => {
    const { result, calls } = await run({ task: 'change a boundary', effort: 'high' }, {
      implementer: [REPORT],
      architect: [SPEC],
      harness: [GREEN],
    })

    expect(result.status).toBe('done')
    expect(result.effort).toBe('high')
    expect(calls[2].prompt).toContain(SPEC.decision)
  })
})

describe('a design step that ran out names the way out of it', () => {
  it('carries the measured recovery route on the result, not only in the log', async () => {
    const { result } = await run({ task: 'redesign the contract', effort: 'high' }, { architect: [REJECTED] })

    expect(result.status).toBe('design incomplete')
    expect(result.recovery).toContain('one class lower')
    expect(result.recovery).toContain('design written into the brief')
  })

  it('says why the run does not simply try again, so the route is not read as a missing feature', async () => {
    const { result } = await run({ task: 'redesign the contract', effort: 'high' }, { architect: [REJECTED] })

    expect(result.recovery).toContain('does not retry the design step')
    expect(result.recovery).toContain('pays for the exploration again')
  })

  it('leaves a run that completed its design with no recovery to relay', async () => {
    const { result } = await run({ task: 'redesign the contract', effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [GREEN] })

    expect(result.status).toBe('done')
    expect(result.recovery).toBeUndefined()
  })
})

describe('a run with no harness command names nothing and asks for it', () => {
  it('returns blocked with an empty attempts array and calls no agent when args.harness is absent', async () => {
    const { result, calls } = await run({ task: 'add a rule', effort: 'low', harness: undefined }, {
      implementer: [REPORT],
      harness: [GREEN],
    })

    expect(result.status).toBe('blocked')
    expect(result.attempts).toEqual([])
    expect(result.question).toContain('harness command')
    expect(result.question).toContain('.construct/attach.json')
    expect(calls).toEqual([])
  })
})

describe('a red base stops the ladder before it spends anything', () => {
  it('checks the base with the harness before the first rung, and before the architect of a high run', async () => {
    const { calls } = await run({ task: 'change a boundary', effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [GREEN] })

    expect(calls.map(call => call.agentType)).toEqual(['harness', 'architect', 'implementer', 'harness'])
  })

  it('returns base red with the harness failure and runs no implementer and no architect', async () => {
    const { result, calls } = await run({ task: 'change a boundary', effort: 'high' }, { architect: [SPEC], implementer: [REPORT] }, RED)

    expect(result.status).toBe('base red')
    expect(result.lastFailure).toBe(RED.failureExcerpt)
    expect(result.attempts).toEqual([{ rung: 0, effort: 'low', outcome: 'base red', reason: RED.failureExcerpt }])
    expect(calls.map(call => call.agentType)).toEqual(['harness'])
  })

  it('names a base it could not verify apart from a red one, and still runs nothing', async () => {
    const { result, calls } = await run({ task: 'add a rule', effort: 'low' }, { implementer: [REPORT] }, REJECTED)

    expect(result.status).toBe('base unverified')
    expect(result.validationError).toBe(REJECTED.message)
    expect(calls.map(call => call.agentType)).toEqual(['harness'])
  })

  it('tells the harness it is looking at the base, so no change is expected in the diff', async () => {
    const { calls } = await run({ task: 'add a rule', effort: 'low' }, { implementer: [REPORT], harness: [GREEN] })

    expect(calls[0].prompt).toContain('before any change')
  })
})
