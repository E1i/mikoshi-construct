import type { ModelPick, SessionSpec } from '../../ports/client/contract.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeAdapter, clientHome } from '../../ports/client/claude/adapter.js'

const lsof = vi.hoisted(() => ({ run: (): string => '' }))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: () => lsof.run(),
}))

const SESSION = '11111111-2222-3333-4444-555555555555'
const CONTRACT = path.join(import.meta.dirname, '..', '..', 'ports', 'client', 'contract.ts')
const CLIENT_NAMES_THE_CONTRACT_NEVER_SAYS = /claude|codex|cursor|lsof|anthropic/i
const LSOF_FOUND_NONE = 1
const LSOF_REFUSED = 2

const roots: string[] = []

beforeEach(() => {
  lsof.run = () => ''
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'client-guarantees-'))
  roots.push(root)
  return root
}

function failedWith(status: number, stdout: string): () => never {
  return () => {
    throw Object.assign(new Error(`lsof exited ${status}`), { status, stdout })
  }
}

function specWith(pick: SessionSpec['pick']): SessionSpec {
  return { kind: 'start', role: 'review', session: SESSION, cwd: '/tree', prompt: 'the prompt', addDirs: [], pick, policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: true } }
}

function argvOf(pick: SessionSpec['pick']): string[] {
  const invocation = claudeAdapter.invocation(specWith(pick))
  if ('reason' in invocation)
    throw new Error(invocation.reason)
  return invocation.args
}

function stubHomeHolding(lines: string[], project = 'a-project-of-another-tree'): void {
  vi.stubEnv('HOME', aRoot())
  const holder = path.join(clientHome({}), 'projects', project)
  mkdirSync(holder, { recursive: true })
  writeFileSync(path.join(holder, `${SESSION}.jsonl`), `${lines.join('\n')}\n`)
}

function assistantWith(input: number, tool: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'tool_use', name: tool, input: {} }] } })
}

describe('the guarantees of the client', () => {
  it('claude declares every guarantee', () => {
    expect(claudeAdapter.capabilities.guarantees).toEqual({ allowlist: true, writeConfinement: true, mcpOff: true, toolNarrowing: true, guardFailsClosed: true })
  })

  it('the contract names no client', () => {
    expect(readFileSync(CONTRACT, 'utf8')).not.toMatch(CLIENT_NAMES_THE_CONTRACT_NEVER_SAYS)
  })
})

describe('the pick of the client', () => {
  it('carries effort null whatever effort was asked', () => {
    for (const effort of [null, 'low', 'max'] as const) {
      expect(claudeAdapter.modelFor('launch', effort, 'auto')).toMatchObject({ effort: null })
      expect(claudeAdapter.modelFor('review', effort, 'opus')).toMatchObject({ effort: null })
    }
  })

  it('leaves the argv as it was, with or without a model', () => {
    const named = claudeAdapter.modelFor('review', 'max', 'opus') as ModelPick
    expect(argvOf(named)).toEqual(argvOf({ model: 'opus' }))
    expect(argvOf({ model: null, effort: null })).toEqual(argvOf({ model: null }))
    expect(argvOf(named).join(' ')).not.toContain('effort')
  })

  it('offers a list, never the null of a client without one', () => {
    expect(claudeAdapter.models()).not.toBeNull()
  })
})

describe('readBudget of a session place', () => {
  it('reads the session by its place from the client home, whichever project holds it', () => {
    stubHomeHolding([assistantWith(100, 'Read'), assistantWith(140, 'Edit')])
    expect(claudeAdapter.readBudget({ session: SESSION, cwd: '/tree', stdoutPath: null })).toEqual({ startContext: 100, readBeforeEdit: 40 })
  })

  it('reports null for a session the client home does not hold', () => {
    stubHomeHolding([assistantWith(100, 'Read')])
    expect(claudeAdapter.readBudget({ session: 'another-session', cwd: '/tree', stdoutPath: null })).toEqual({ startContext: null, readBeforeEdit: null })
    vi.stubEnv('HOME', path.join(aRoot(), 'no-such-home'))
    expect(claudeAdapter.readBudget({ session: SESSION, cwd: '/tree', stdoutPath: null })).toEqual({ startContext: null, readBeforeEdit: null })
  })
})

describe('liveCwds', () => {
  it('returns the parsed directories, one per process, and no raw listing', () => {
    lsof.run = () => 'p101\nfcwd\nn/trees/1\np102\nfcwd\nn/trees/two words\n'
    expect(claudeAdapter.processes.liveCwds()).toEqual({ kind: 'listed', cwds: ['/trees/1', '/trees/two words'] })
  })

  it('an empty search is an empty list, and a search that found none keeps what it printed', () => {
    expect(claudeAdapter.processes.liveCwds()).toEqual({ kind: 'listed', cwds: [] })
    lsof.run = failedWith(LSOF_FOUND_NONE, '')
    expect(claudeAdapter.processes.liveCwds()).toEqual({ kind: 'listed', cwds: [] })
    lsof.run = failedWith(LSOF_FOUND_NONE, 'p101\nfcwd\nn/trees/1\n')
    expect(claudeAdapter.processes.liveCwds()).toEqual({ kind: 'listed', cwds: ['/trees/1'] })
  })

  it('a search that failed is unreadable and says why, never an empty list', () => {
    lsof.run = failedWith(LSOF_REFUSED, 'n/trees/1\n')
    expect(claudeAdapter.processes.liveCwds()).toEqual({ kind: 'unreadable', why: `lsof exited ${LSOF_REFUSED}` })
  })
})
