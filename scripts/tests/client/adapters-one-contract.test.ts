import type { Capabilities, ClientAdapter, ClientGuarantees, Invocation, Refusal, SessionPolicy, SessionReading, SessionSpec } from '../../ports/client/contract.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ENV_PREFIXES, clientHome, transcriptFile } from '../../ports/client/claude/adapter.js'
import { codexAdapter } from '../../ports/client/codex/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'

const SESSION = 'sess-1642'
const PROMPT = 'Review this change.'
const STDERR_TEXT = 'the client could not start'
const CODEX_W1 = path.join(import.meta.dirname, 'fixtures', 'codex-w1.jsonl')
const CLIENT_DEFAULT: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false }

interface Spot {
  root: string
  tree: string
}

interface Row {
  adapter: ClientAdapter
  completedStream: (spot: Spot) => string
}

function claudeCompletedStream(spot: Spot): string {
  const at = '2026-11-08T00:00:00.000Z'
  const usage = { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 }
  const assistant = { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'a-model', content: [{ type: 'text', text: 'done' }], usage } }
  const transcript = transcriptFile(clientHome(process.env), spot.tree, SESSION)!
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify(assistant)}\n`)
  const stream = [
    { type: 'system', subtype: 'init', model: 'a-model', session_id: SESSION, timestamp: at },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } },
    { type: 'result', is_error: false, total_cost_usd: 0.01, num_turns: 2, usage, permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/elsewhere', content: 'x' } }], timestamp: '2026-11-08T00:00:01.000Z' },
  ]
  const file = path.join(spot.root, 'claude-out.jsonl')
  writeFileSync(file, `${stream.map(line => JSON.stringify(line)).join('\n')}\n`)
  return file
}

const ROWS: Row[] = [
  { adapter: clientAdapter(), completedStream: claudeCompletedStream },
  { adapter: codexAdapter, completedStream: () => CODEX_W1 },
]

const REPORTED_FIELD: Record<keyof Capabilities['reports'], (reading: SessionReading) => unknown> = {
  cost: reading => reading.costUsd,
  turns: reading => reading.turns,
  model: reading => reading.model,
  denials: reading => reading.denials,
  journal: reading => reading.journal,
}

const NOT_REPORTED: Record<keyof Capabilities['reports'], (value: unknown) => boolean> = {
  cost: value => value === null,
  turns: value => value === null,
  model: value => value === null,
  denials: value => value === null || (Array.isArray(value) && value.length === 0),
  journal: value => value === 'unreadable',
}

const REPORTED: Record<keyof Capabilities['reports'], (value: unknown) => boolean> = {
  cost: value => typeof value === 'number',
  turns: value => typeof value === 'number',
  model: value => typeof value === 'string',
  denials: value => Array.isArray(value),
  journal: value => value !== 'unreadable' && value !== null && typeof value === 'object',
}

const POLICY_ASKING: Record<Exclude<keyof ClientGuarantees, 'guardFailsClosed'>, Partial<SessionPolicy>> = {
  allowlist: { gateCommands: ['pnpm run gate'] },
  writeConfinement: { profile: 'sandboxed' },
  mcpOff: { mcpOff: true },
  toolNarrowing: { tools: ['web'] },
}

const spots: string[] = []

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'adapters-one-contract-'))
  spots.push(root)
  for (const variable of Object.keys(process.env).filter(name => CLIENT_ENV_PREFIXES.some(prefix => name.startsWith(prefix))))
    vi.stubEnv(variable, undefined)
  vi.stubEnv('HOME', path.join(root, 'home'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of spots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aSpot(): Spot {
  const root = spots.at(-1)!
  const tree = path.join(root, 'tree')
  mkdirSync(tree, { recursive: true })
  writeFileSync(path.join(tree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run gate' }, shift: { prepush: ['pnpm run gate'] } })}\n`)
  return { root, tree }
}

function aSpec(spot: Spot, overrides: Partial<SessionSpec> = {}): SessionSpec {
  return { kind: 'start', role: 'review', session: SESSION, cwd: spot.tree, prompt: PROMPT, addDirs: [], pick: { model: null }, policy: CLIENT_DEFAULT, ...overrides }
}

function isRefusal(result: Invocation | Refusal | object): result is Refusal {
  return 'kind' in result && result.kind === 'refused'
}

function expectInvocation(result: Invocation | Refusal, label: string): Invocation {
  expect(isRefusal(result), `${label}: ${isRefusal(result) ? result.reason : ''}`).toBe(false)
  const invocation = result as Invocation
  expect(typeof invocation.command).toBe('string')
  expect(invocation.args.every(word => typeof word === 'string')).toBe(true)
  expect(typeof invocation.env).toBe('object')
  return invocation
}

function expectRefusal(result: Invocation | Refusal, label: string): void {
  expect(result, label).toEqual({ kind: 'refused', reason: expect.any(String) })
  expect((result as Refusal).reason.trim(), label).not.toBe('')
}

function expectReadingShape(reading: SessionReading): void {
  expect(['completed', 'failed', 'missing']).toContain(reading.end)
  expect(reading.failure === null || typeof reading.failure === 'string').toBe(true)
  if (reading.usage !== null)
    expect(Object.keys(reading.usage).sort()).toEqual(['cacheWrite', 'cached', 'input', 'output', 'reasoning'])
  expect(reading.durationMs === null || typeof reading.durationMs === 'number').toBe(true)
  expect(reading.contextTokens === null || typeof reading.contextTokens === 'number').toBe(true)
  expect(reading.lastSteps === null || reading.lastSteps.every(step => typeof step === 'string')).toBe(true)
  expect(reading.clientSession === null || typeof reading.clientSession === 'string').toBe(true)
  for (const use of reading.toolUses)
    expect(['write', 'exec', 'other']).toContain(use.kind)
}

function expectReportsAsDeclared(adapter: ClientAdapter, reading: SessionReading, mustCarry: boolean): void {
  for (const report of Object.keys(REPORTED_FIELD) as (keyof Capabilities['reports'])[]) {
    const value = REPORTED_FIELD[report](reading)
    if (!adapter.capabilities.reports[report])
      expect(NOT_REPORTED[report](value), `${adapter.id} declares no ${report} and reads ${JSON.stringify(value)}`).toBe(true)
    else if (mustCarry)
      expect(REPORTED[report](value), `${adapter.id} declares ${report} and reads ${JSON.stringify(value)}`).toBe(true)
  }
}

it('the table holds both adapters, the selected one and codex, each once', () => {
  expect(ROWS.map(row => row.adapter)).toEqual([clientAdapter(), codexAdapter])
  expect(new Set(ROWS.map(row => row.adapter.id)).size).toBe(ROWS.length)
})

describe.each(ROWS.map(row => [row.adapter.id, row] as const))('the %s adapter passes the ClientAdapter contract', (_id, { adapter, completedStream }) => {
  it('declares its id and every capability', () => {
    expect(adapter.id.trim()).not.toBe('')
    expect(['assigned', 'reported']).toContain(adapter.capabilities.identity)
    expect(typeof adapter.capabilities.ladder).toBe('boolean')
    expect(Object.keys(adapter.capabilities.reports).sort()).toEqual(['cost', 'denials', 'journal', 'model', 'turns'])
    expect(Object.keys(adapter.capabilities.guarantees).sort()).toEqual(['allowlist', 'guardFailsClosed', 'mcpOff', 'toolNarrowing', 'writeConfinement'])
    for (const flag of [...Object.values(adapter.capabilities.reports), ...Object.values(adapter.capabilities.guarantees)])
      expect(typeof flag).toBe('boolean')
  })

  it('starts a review in its tree with the prompt, and names its process by the command it runs', () => {
    const invocation = expectInvocation(adapter.invocation(aSpec(aSpot())), 'review start')
    expect([...invocation.args, invocation.stdin]).toContain(PROMPT)
    expect(adapter.processes.isolationCommand()[0]).toBe(invocation.command)
    expect(adapter.processes.processNames).toContain(invocation.command)
    expect(adapter.processes.isClient(`${invocation.command} ${invocation.args.join(' ')}`)).toBe(true)
    expect(adapter.processes.isClient(`grep -r something ${invocation.command}`)).toBe(false)
  })

  it('runs the ladder role exactly when it declares the ladder', () => {
    const result = adapter.invocation(aSpec(aSpot(), { role: 'ladder' }))
    if (adapter.capabilities.ladder)
      expectInvocation(result, 'ladder start')
    else
      expectRefusal(result, 'ladder start')
  })

  it.each(Object.keys(POLICY_ASKING) as (keyof typeof POLICY_ASKING)[])('a review whose policy asks for %s is refused exactly when the guarantee is not declared', (guarantee) => {
    const result = adapter.invocation(aSpec(aSpot(), { policy: { ...CLIENT_DEFAULT, ...POLICY_ASKING[guarantee] } }))
    if (adapter.capabilities.guarantees[guarantee])
      expectInvocation(result, guarantee)
    else
      expectRefusal(result, guarantee)
  })

  it('reads a completed run as completed, carrying every report it declares and none it does not', () => {
    const spot = aSpot()
    const reading = adapter.reading({ session: SESSION, cwd: spot.tree, stdoutPath: completedStream(spot), stderrPath: null, exitCode: 0 })
    expectReadingShape(reading)
    expect(reading).toMatchObject({ end: 'completed', failure: null })
    expect(reading.toolUses.length).toBeGreaterThan(0)
    expect(reading.usage).not.toBeNull()
    expectReportsAsDeclared(adapter, reading, true)
    expect(reading.clientSession).not.toBeNull()
    if (adapter.capabilities.identity === 'assigned')
      expect(reading.clientSession).toBe(SESSION)
  })

  it('reads no stream as missing, and holds the session only when it assigned it', () => {
    const spot = aSpot()
    const reading = adapter.reading({ session: SESSION, cwd: spot.tree, stdoutPath: path.join(spot.root, 'no-stream.jsonl'), stderrPath: null, exitCode: null })
    expectReadingShape(reading)
    expect(reading).toMatchObject({ end: 'missing', failure: null, usage: null, toolUses: [] })
    expectReportsAsDeclared(adapter, reading, false)
    expect(reading.clientSession).toBe(adapter.capabilities.identity === 'assigned' ? SESSION : null)
  })

  it('reads a client that exited non-zero with no stream as failed, with its error text', () => {
    const spot = aSpot()
    const stderrPath = path.join(spot.root, 'stderr')
    writeFileSync(stderrPath, `${STDERR_TEXT}\n`)
    const reading = adapter.reading({ session: SESSION, cwd: spot.tree, stdoutPath: null, stderrPath, exitCode: 1 })
    expect(reading).toMatchObject({ end: 'failed', failure: STDERR_TEXT })
    expectReportsAsDeclared(adapter, reading, false)
  })

  it('answers the rest of the contract in its shape', () => {
    const spot = aSpot()
    const budget = adapter.readBudget({ session: SESSION, cwd: spot.tree, stdoutPath: null })
    expect(budget).toEqual({ startContext: null, readBeforeEdit: null })
    const offers = adapter.models()
    for (const offer of offers ?? [])
      expect(offer).toEqual({ id: expect.any(String), efforts: expect.any(Array), contextWindow: offer.contextWindow, recommendedFor: expect.any(Array) })
    const pick = adapter.modelFor('review', null, 'auto')
    expect(isRefusal(pick)).toBe(false)
    expect(pick).toEqual({ model: expect.toSatisfy((model: unknown) => model === null || typeof model === 'string'), effort: null })
    const marker = adapter.processes.sessionMarker(SESSION)
    expect(marker === null || marker.includes(SESSION)).toBe(true)
    expect(adapter.ownSession({})).toBeNull()
  })
})
