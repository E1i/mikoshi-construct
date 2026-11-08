import type { Role, SessionSpec } from '../../ports/client/contract.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAdapter } from '../../ports/client/codex/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'

const TREE = '/tree'
const W1 = path.join(import.meta.dirname, 'fixtures', 'codex-w1.jsonl')
const W6 = path.join(import.meta.dirname, 'fixtures', 'codex-w6.jsonl')
const NOT_REPORTED = { costUsd: null, turns: null, durationMs: null, model: null, denials: null, journal: 'unreadable', lastSteps: null, contextTokens: null }
const UNAVAILABLE = 'The model is not supported when using Codex with a ChatGPT account.'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aStream(...lines: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-reading-'))
  roots.push(root)
  const file = path.join(root, 'out.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function read(stdoutPath: string | null): ReturnType<typeof codexAdapter.reading> {
  return codexAdapter.reading({ session: 'core-session', cwd: TREE, stdoutPath, stderrPath: null, exitCode: null })
}

function linesOf(fixture: string): string[] {
  return readFileSync(fixture, 'utf8').trim().split('\n')
}

function aSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    kind: 'start',
    role: 'review',
    session: 'core-session',
    cwd: TREE,
    prompt: 'Review this change.',
    addDirs: [],
    pick: { model: null },
    policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false },
    ...overrides,
  }
}

describe('the capabilities of the second adapter', () => {
  it('reports nothing it cannot read and is selected by nothing yet', () => {
    expect(codexAdapter.id).toBe('codex')
    expect(codexAdapter.capabilities).toMatchObject({ identity: 'reported', ladder: false, reports: { cost: false, turns: false, model: false, denials: false, journal: false } })
    expect(clientAdapter().id).toBe('claude')
  })
})

describe('a recorded stream', () => {
  it('the census run: cached sits inside input and what the stream does not carry is null', () => {
    expect(read(W1)).toEqual({
      end: 'completed',
      failure: null,
      usage: { input: 15506, cached: 21760, cacheWrite: 0, output: 100, reasoning: 0 },
      toolUses: [{ kind: 'exec', command: '/bin/zsh -lc \'git rev-parse --short HEAD\'', path: null }],
      clientSession: '01a1aa9f-0000-4000-8000-000000000001',
      ...NOT_REPORTED,
    })
  })

  it('the guarded run: a blocked command leaves no item and no denial, and an agent message is no tool use', () => {
    expect(read(W6)).toEqual({
      end: 'completed',
      failure: null,
      usage: { input: 15688, cached: 21760, cacheWrite: 0, output: 176, reasoning: 12 },
      toolUses: [{ kind: 'exec', command: '/bin/zsh -lc \'touch w6-allowed.txt\'', path: null }],
      clientSession: '01a1aa9f-0000-4000-8000-000000000006',
      ...NOT_REPORTED,
    })
  })

  it('the fixtures carry no home path', () => {
    for (const fixture of [W1, W6])
      expect(readFileSync(fixture, 'utf8')).not.toMatch(/\/Users\/|\/home\/|~\//)
  })
})

describe('how a session ended', () => {
  const started = linesOf(W1).slice(0, 2)
  const completed = linesOf(W1).at(-1)!

  it('turn.failed is failed with its text and no usage', () => {
    const reading = read(aStream(...started, JSON.stringify({ type: 'turn.failed', error: { message: UNAVAILABLE } })))
    expect(reading).toMatchObject({ end: 'failed', failure: UNAVAILABLE, usage: null })
  })

  it('turn.failed with no text still names the failure', () => {
    expect(read(aStream(...started, '{"type":"turn.failed"}'))).toMatchObject({ end: 'failed', failure: 'the client reported a failed turn and no text' })
  })

  it('the last turn decides the end', () => {
    expect(read(aStream(...started, completed, '{"type":"turn.failed","error":{"message":"later"}}')).end).toBe('failed')
    expect(read(aStream(...started, '{"type":"turn.failed","error":{"message":"earlier"}}', completed))).toMatchObject({ end: 'completed', failure: null })
  })

  it('a stream with neither end is missing, and so is no stream at all', () => {
    const cut = read(aStream(...linesOf(W1).slice(0, 3)))
    expect(cut).toMatchObject({ end: 'missing', failure: null, usage: null })
    expect(cut.toolUses).toHaveLength(1)
    expect(read(aStream('not json', '{"type":"turn.completed"'))).toMatchObject({ end: 'missing', usage: null })
    expect(read(path.join(tmpdir(), 'no-such-codex-stream.jsonl')).end).toBe('missing')
    expect(read(null).end).toBe('missing')
  })

  it('a usage missing a count is null, never a zero', () => {
    const short = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":1}}'
    expect(read(aStream(short))).toMatchObject({ end: 'completed', usage: null })
    expect(read(aStream('{"type":"turn.completed"}'))).toMatchObject({ end: 'completed', usage: null })
  })
})

describe('the invocation', () => {
  it('a review is read-only, in its tree, with the prompt as its argument', () => {
    expect(codexAdapter.invocation(aSpec())).toEqual({ command: 'codex', args: ['exec', '--json', '-s', 'read-only', '-C', TREE, 'Review this change.'], env: {}, stdin: null })
  })

  it('a picked model goes through -m', () => {
    expect(codexAdapter.invocation(aSpec({ pick: { model: 'some-model' } }))).toMatchObject({ args: ['exec', '--json', '-s', 'read-only', '-C', TREE, '-m', 'some-model', 'Review this change.'] })
  })

  it('no hook flag, no config override and no bypass flag', () => {
    const invocation = codexAdapter.invocation(aSpec({ pick: { model: 'some-model' } }))
    expect(invocation).toHaveProperty('args')
    const { args } = invocation as { args: string[] }
    expect(args.filter(word => word.startsWith('--dangerously') || word.includes('hook') || word === '-c')).toEqual([])
  })

  it.each(['launch', 'answer', 'ladder', 'ghost', 'window'] satisfies Role[])('the role %s is a refusal naming read-only review', (role) => {
    expect(codexAdapter.invocation(aSpec({ role }))).toEqual({ kind: 'refused', reason: expect.stringMatching(/only a read-only review.*Q167/) })
  })

  it('a resumed review is a refusal, not a fresh session under the same id', () => {
    expect(codexAdapter.invocation(aSpec({ kind: 'resume' }))).toEqual({ kind: 'refused', reason: expect.stringContaining('never resumes') })
  })
})

describe('the models', () => {
  it('holds no list, because the list is not what is available', () => {
    expect(codexAdapter.models()).toBeNull()
  })

  it('passes a named model through and leaves auto to the client', () => {
    expect(codexAdapter.modelFor('review', null, 'no-such-model-x')).toEqual({ model: 'no-such-model-x', effort: null })
    expect(codexAdapter.modelFor('review', 'high', 'auto')).toEqual({ model: null, effort: null })
  })
})

describe('the rest of the contract', () => {
  it('names the client process by the head of its argv only', () => {
    expect(codexAdapter.processes.isClient('codex exec --json')).toBe(true)
    expect(codexAdapter.processes.isClient('/opt/bin/codex exec --json')).toBe(true)
    expect(codexAdapter.processes.isClient('node /opt/bin/codex exec')).toBe(true)
    expect(codexAdapter.processes.isClient('grep -r something codex')).toBe(false)
  })

  it('holds no session marker, no own session and no budget reading, and names its process codex', () => {
    expect(codexAdapter.processes.sessionMarker('core-session')).toBeNull()
    expect(codexAdapter.ownSession({})).toBeNull()
    expect(codexAdapter.processes.processNames).toEqual(['codex'])
    expect(codexAdapter.readBudget({ session: 'core-session', cwd: '/tree', stdoutPath: null })).toEqual({ startContext: null, readBeforeEdit: null })
    expect(codexAdapter.processes.isolationCommand()).toEqual(['codex', 'exec', '--json', '-s', 'read-only', '-C'])
  })
})
