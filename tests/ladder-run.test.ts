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
  acceptance?: string[]
  invariants?: string[]
  contractChanged?: boolean
  changedFiles?: string[]
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

const DEFAULT_ACCEPTANCE = ['the rule rejects the case']
const WITNESS_COMMAND = 'pnpm vitest run tests/rule.test.ts'

function witnessed(items: string[], outcome: { baseExitCode: number, afterExitCode: number, baseExcerpt?: string } = { baseExitCode: 1, afterExitCode: 0 }): unknown[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND, baseExcerpt: outcome.baseExitCode === 0 ? '1 passed' : '1 failed', ...outcome }))
}

const INSTALLED = { command: 'pnpm install --frozen-lockfile', exitCode: 0 }

const BASE_SHA = '36f7abc9815cea1962b05bcf98bdcec193ba9fc5'
const TAUTOLOGY = 'test -f a.ts'

const REPORT = { status: 'done', summary: 'changed the ladder', files: ['a.ts'], harnessTail: 'ok', question: '' }
const BLOCKED = { status: 'blocked', summary: '', files: [], harnessTail: '', question: 'which of the two designs?' }
const GREEN = { passed: true, failureExcerpt: '', securityFinding: '', diffStat: ' 1 file changed', testsWeakened: false, changedFiles: ['a.ts'], baseSha: BASE_SHA, baseInstall: INSTALLED, witnesses: witnessed(DEFAULT_ACCEPTANCE) }
const RED = { passed: false, failureExcerpt: 'vitest failed', securityFinding: '', diffStat: '', testsWeakened: false, changedFiles: ['a.ts'], baseSha: BASE_SHA, baseInstall: INSTALLED, witnesses: [] }

function fixedWitnesses(items: string[]): { criterion: string, command: string }[] {
  return items.map(criterion => ({ criterion, command: WITNESS_COMMAND }))
}

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
  const acceptance = (args.acceptance as string[] | undefined) ?? DEFAULT_ACCEPTANCE
  const result = await ladder()({ harness: { command: 'pnpm run quality' }, acceptance, witnesses: fixedWitnesses(acceptance), ...args }, agent, () => {}, () => {})
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
    const { result } = await run({ task: 't', effort: 'high' }, { architect: [SPEC], implementer: [REPORT], harness: [GREEN] })
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

describe('the ladder echoes the acceptance it received', () => {
  const ACCEPTANCE = ['the harness is green', 'the template copy is byte-identical']

  it('echoes the acceptance it received in a done result', async () => {
    const args = { task: 'add a rule', effort: 'low', acceptance: [ACCEPTANCE[0]] }
    const { result } = await run(args, { implementer: [REPORT], harness: [{ ...GREEN, witnesses: witnessed(args.acceptance) }] })

    expect(result.status).toBe('done')
    expect(result.acceptance).toEqual(args.acceptance)
  })

  it('echoes the acceptance it received in a failed result', async () => {
    const args = { task: 'add a rule', effort: 'medium', acceptance: [ACCEPTANCE[0]] }
    const { result } = await run(args, { implementer: [REPORT, REPORT, REPORT], architect: [SPEC], harness: [RED, RED, RED] })

    expect(result.status).toBe('failed')
    expect(result.acceptance).toEqual(args.acceptance)
  })

  it('echoes the acceptance it received in a blocked result', async () => {
    const args = { task: 'add a rule', effort: 'high', acceptance: [ACCEPTANCE[0]] }
    const { result } = await run(args, { architect: [SPEC, SPEC, SPEC], implementer: [BLOCKED, BLOCKED, BLOCKED] })

    expect(result.status).toBe('blocked')
    expect(result.acceptance).toEqual(args.acceptance)
  })

  it('echoes every acceptance item, not only the first', async () => {
    const args = { task: 'add a rule', effort: 'low', acceptance: ACCEPTANCE }
    const { result } = await run(args, { implementer: [REPORT], harness: [GREEN] })

    expect(result.acceptance).toEqual(args.acceptance)
    expect(result.acceptance).toHaveLength(2)
  })

  it('echoes it on the early blocked for a missing harness command, on base red and on design incomplete', async () => {
    const args = { task: 'add a rule', effort: 'high', acceptance: ACCEPTANCE }
    const missing = await run({ ...args, harness: undefined }, {})
    const red = await run(args, {}, RED)
    const incomplete = await run(args, { architect: [REJECTED] })

    for (const { result } of [missing, red, incomplete])
      expect(result.acceptance, result.status).toEqual(args.acceptance)
  })
})

describe('the ladder derives contractChanged from the changed files, never from the harness agent', () => {
  const CONTRACT = 'contract/surface.json'
  const withContract = { harness: { command: 'pnpm run quality', contractPaths: [CONTRACT] } }

  it('is true when changedFiles contains a path contractPaths names', async () => {
    const { result } = await run({ task: 'add a command', effort: 'low', ...withContract }, {
      implementer: [REPORT],
      harness: [{ ...GREEN, changedFiles: ['src/program.ts', CONTRACT] }],
    })

    expect(result.status).toBe('done')
    expect(result.contractChanged).toBe(true)
    expect(result.changedFiles).toEqual(['src/program.ts', CONTRACT])
  })

  it('is false when only other files changed, even when the agent claims a contract change', async () => {
    const { result } = await run({ task: 'fix a typo', effort: 'low', ...withContract }, {
      implementer: [REPORT],
      harness: [{ ...GREEN, changedFiles: ['src/ui/lore.ts'], contractChanged: true }],
    })

    expect(result.status).toBe('done')
    expect(result.contractChanged).toBe(false)
  })

  it('matches a contract path exactly, so a sibling that shares its prefix is not a contract change', async () => {
    const { result } = await run({ task: 'back up the surface', effort: 'low', ...withContract }, {
      implementer: [REPORT],
      harness: [{ ...GREEN, changedFiles: [`${CONTRACT}.bak`] }],
    })

    expect(result.contractChanged).toBe(false)
  })

  it('is false when no contract path was passed', async () => {
    const { result } = await run({ task: 'add a command', effort: 'low' }, {
      implementer: [REPORT],
      harness: [{ ...GREEN, changedFiles: [CONTRACT] }],
    })

    expect(result.contractChanged).toBe(false)
  })
})

describe('done needs every acceptance item witnessed red before the change and green after it (#240)', () => {
  const NOTHING_CHANGED = { ...GREEN, diffStat: '', changedFiles: [], witnesses: [] }
  const EMPTY_REPORT = { ...REPORT, files: [], witnesses: [] }

  it('does not report done for the shape of wf_c3fc5325-1c7: a report with no file and a green, unchanged tree', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'medium' }, {
      implementer: [EMPTY_REPORT, EMPTY_REPORT, EMPTY_REPORT],
      architect: [SPEC],
      harness: [NOTHING_CHANGED, NOTHING_CHANGED, NOTHING_CHANGED],
    })

    expect(result.status).not.toBe('done')
    expect(result.status).toBe('failed')
  })

  it('stops a rung whose implementer changed no file before it spends a harness run on it', async () => {
    const { result, calls } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [EMPTY_REPORT, REPORT],
      harness: [GREEN],
    })

    expect(result.status).toBe('done')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['no change', 'passed'])
    expect(calls.map(call => call.agentType)).toEqual(['harness', 'implementer', 'implementer', 'harness'])
  })

  it('does not report done when the harness saw no changed file, whatever the implementer claims', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, changedFiles: [] }, GREEN],
    })

    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['no change', 'passed'])
  })

  it('does not report done when an acceptance item was already green on the base', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 0, afterExitCode: 0 }) }, GREEN],
    })

    expect(result.attempts[0]).toMatchObject({ outcome: 'acceptance not witnessed' })
    expect(result.attempts[0].reason).toContain(DEFAULT_ACCEPTANCE[0])
  })

  it('does not report done when an acceptance item is still red after the change', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 1, afterExitCode: 1 }) }, GREEN],
    })

    expect(result.attempts[0]).toMatchObject({ outcome: 'acceptance not witnessed' })
  })

  it('names the item no witness covered, and counts only a criterion copied verbatim', async () => {
    const acceptance = ['the reader parses the file', 'an empty file reads unknown']
    const { result } = await run({ task: 'add a reader', effort: 'low', acceptance }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, witnesses: [...witnessed([acceptance[0]]), ...witnessed(['an empty file reads as unknown'])] }, { ...GREEN, witnesses: witnessed(acceptance) }],
    })

    expect(result.attempts[0].reason).toContain(acceptance[1])
    expect(result.attempts[0].reason).not.toContain(acceptance[0])
    expect(result.status).toBe('done')
  })

  it('gives the harness the witness commands the brief fixed, and the base sha to run them at in a worktree of its own', async () => {
    const { calls } = await run({ task: 'add a reader', effort: 'low' }, { implementer: [REPORT], harness: [GREEN] })

    expect(calls[2].prompt).toContain(WITNESS_COMMAND)
    expect(calls[2].prompt).toContain(DEFAULT_ACCEPTANCE[0])
    expect(calls[2].prompt).toContain(`git worktree add --detach`)
    expect(calls[2].prompt).toContain(BASE_SHA)
    expect(calls[2].prompt).not.toContain('set aside')
    expect(calls[2].prompt).toContain('never stash, check out, move or rewrite a file in it')
  })

  it('removes the base worktree even when a step fails', async () => {
    const { calls } = await run({ task: 'add a reader', effort: 'low' }, { implementer: [REPORT], harness: [GREEN] })

    expect(calls[2].prompt).toContain(`trap 'git worktree remove --force "$base"' EXIT`)
  })

  it('reads a base whose worktree was never installed as unverified and never done, even when every witness failed there', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, baseInstall: { command: '', exitCode: -1 }, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 1, afterExitCode: 0, baseExcerpt: 'Error: Cannot find module \'vitest\'' }) }, GREEN],
    })

    expect(result.status).toBe('base unverified')
    expect(result.attempts.at(-1)).toMatchObject({ outcome: 'base environment' })
  })

  it('reads a witness the base cannot even run (exit 127) as unverified, not as red, whatever it printed', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 127, afterExitCode: 0, baseExcerpt: '' }) }, GREEN],
    })

    expect(result.status).toBe('base unverified')
  })

  it('reads a base whose install failed as unverified, even when the witness output there looks behavioural', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 1 }, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 1, afterExitCode: 0, baseExcerpt: '1 failed' }) }, GREEN],
    })

    expect(result.status).toBe('base unverified')
  })

  it('reads a missing package on the base as unverified even when the install reported success', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT, REPORT],
      harness: [{ ...GREEN, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 1, afterExitCode: 0, baseExcerpt: 'Error: Cannot find package \'vitest\' imported from /tmp/base/vitest.config.ts' }) }, GREEN],
    })

    expect(result.status).toBe('base unverified')
  })

  it('counts a missing module of the change itself as a behavioural red', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [REPORT],
      harness: [{ ...GREEN, witnesses: witnessed(DEFAULT_ACCEPTANCE, { baseExitCode: 1, afterExitCode: 0, baseExcerpt: 'Error: Cannot find module \'../src/model/junit-report.js\'' }) }],
    })

    expect(result.status).toBe('done')
  })

  it('shows the implementer the witnesses fixed before it started, as commands it does not choose', async () => {
    const { calls } = await run({ task: 'add a reader', effort: 'low' }, { implementer: [REPORT], harness: [GREEN] })

    expect(calls[1].prompt).toContain(WITNESS_COMMAND)
    expect(calls[1].prompt).toContain('fixed in the brief')
  })

  it('does not count a tautological witness the implementer substituted for the brief\'s', async () => {
    const { result } = await run({ task: 'add a reader', effort: 'low' }, {
      implementer: [{ ...REPORT, witnesses: [{ criterion: DEFAULT_ACCEPTANCE[0], command: TAUTOLOGY }] }, REPORT],
      harness: [{ ...GREEN, witnesses: [{ criterion: DEFAULT_ACCEPTANCE[0], command: TAUTOLOGY, baseExitCode: 1, afterExitCode: 0, baseExcerpt: '' }] }, GREEN],
    })

    expect(result.attempts[0]).toMatchObject({ outcome: 'acceptance not witnessed' })
  })

  it('returns blocked and calls no agent when an acceptance item has no witness in the brief', async () => {
    const acceptance = ['the reader parses the file', 'an empty file reads unknown']
    const { result, calls } = await run({ task: 'add a reader', effort: 'low', acceptance, witnesses: fixedWitnesses([acceptance[0]]) }, { implementer: [REPORT], harness: [GREEN] })

    expect(result.status).toBe('blocked')
    expect(result.question).toContain(acceptance[1])
    expect(calls).toEqual([])
  })

  it('names a base that reported no sha as unverified, since no witness could run against it', async () => {
    const { result, calls } = await run({ task: 'add a reader', effort: 'low' }, { implementer: [REPORT] }, { ...GREEN, baseSha: '' })

    expect(result.status).toBe('base unverified')
    expect(calls.map(call => call.agentType)).toEqual(['harness'])
  })

  it('passes the invariants through to the implementer and echoes them, without witnessing them', async () => {
    const invariants = ['pnpm run quality stays green']
    const { result, calls } = await run({ task: 'add a reader', effort: 'low', invariants }, { implementer: [REPORT], harness: [GREEN] })

    expect(result.status).toBe('done')
    expect(result.invariants).toEqual(invariants)
    expect(calls[1].prompt).toContain(invariants[0])
  })

  it('returns blocked and calls no agent when the brief carries no acceptance', async () => {
    const { result, calls } = await run({ task: 'add a reader', effort: 'low', acceptance: [] }, { implementer: [REPORT], harness: [GREEN] })

    expect(result.status).toBe('blocked')
    expect(result.question).toContain('args.acceptance')
    expect(calls).toEqual([])
  })
})
