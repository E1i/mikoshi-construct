import type { SessionPolicy, SessionReading, SessionSpec } from '../../ports/client/contract.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAdapter } from '../../ports/client/codex/adapter.js'

const TREE = '/tree'
const W1 = path.join(import.meta.dirname, 'fixtures', 'codex-w1.jsonl')
const NOTHING_ASKED: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false }
const BOOT_ERROR = 'error: unexpected argument found\n'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aFile(text: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-guarantees-'))
  roots.push(root)
  const file = path.join(root, 'captured')
  writeFileSync(file, text)
  return file
}

function aReview(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return { kind: 'start', role: 'review', session: 'core-session', cwd: TREE, prompt: 'Review this change.', addDirs: [], pick: { model: null }, policy: NOTHING_ASKED, ...overrides }
}

function read(stdoutPath: string | null, stderrPath: string | null, exitCode: number | null): SessionReading {
  return codexAdapter.reading({ session: 'core-session', cwd: TREE, stdoutPath, stderrPath, exitCode })
}

describe('the guarantees of the client', () => {
  it('holds write confinement for a read-only review and nothing else', () => {
    expect(codexAdapter.capabilities.guarantees).toEqual({ allowlist: false, writeConfinement: true, mcpOff: false, toolNarrowing: false, guardFailsClosed: false })
  })

  it.each<[string, Partial<SessionPolicy>]>([
    ['allowlist', { gateCommands: ['pnpm run quality'] }],
    ['mcpOff', { mcpOff: true }],
    ['toolNarrowing', { tools: ['web'] }],
  ])('a policy asking for %s is a refusal naming it', (guarantee, asked) => {
    expect(codexAdapter.invocation(aReview({ policy: { ...NOTHING_ASKED, ...asked } }))).toEqual({ kind: 'refused', reason: expect.stringContaining(guarantee) })
  })

  it('a refusal names every guarantee that is missing', () => {
    const invocation = codexAdapter.invocation(aReview({ policy: { ...NOTHING_ASKED, mcpOff: true, gateCommands: ['pnpm run quality'] } }))
    expect(invocation).toEqual({ kind: 'refused', reason: expect.stringMatching(/allowlist, mcpOff/) })
  })

  it('a sandboxed profile asks only for the confinement it holds and runs read-only', () => {
    expect(codexAdapter.invocation(aReview({ policy: { ...NOTHING_ASKED, profile: 'sandboxed' } }))).toMatchObject({ args: expect.arrayContaining(['read-only']) })
  })

  it('an empty list of tools narrows nothing and asks for nothing', () => {
    expect(codexAdapter.invocation(aReview({ policy: { ...NOTHING_ASKED, tools: [] } }))).toHaveProperty('args')
  })

  it('paths to write are refused, because a read-only review would silently write none of them', () => {
    expect(codexAdapter.invocation(aReview({ policy: { ...NOTHING_ASKED, writePaths: ['/tree/report.md'] } }))).toEqual({ kind: 'refused', reason: expect.stringContaining('read-only') })
  })

  it('a further directory is refused and never dropped from a running session', () => {
    expect(codexAdapter.invocation(aReview({ addDirs: ['/elsewhere'] }))).toEqual({ kind: 'refused', reason: expect.stringContaining('addDirs') })
  })

  it('the refusal of a role comes before the reading of its policy', () => {
    expect(codexAdapter.invocation(aReview({ role: 'launch', policy: { ...NOTHING_ASKED, mcpOff: true } }))).toEqual({ kind: 'refused', reason: expect.stringContaining('the role launch') })
  })
})

describe('what the stream cannot say', () => {
  it('denials are null and never an empty list', () => {
    expect(read(W1, null, 0).denials).toBeNull()
    expect(read(null, null, null).denials).toBeNull()
  })

  it('the session of the client is the thread of thread.started, not the session of the core', () => {
    expect(read(W1, null, 0).clientSession).toBe('01a1aa9f-0000-4000-8000-000000000001')
    expect(read(aFile('{"type":"thread.started"}\n'), null, 0).clientSession).toBeNull()
    expect(read(null, null, null).clientSession).toBeNull()
  })
})

describe('a start that failed', () => {
  it('a nonzero exit with no stream line reads failed with the text of stderr', () => {
    expect(read(aFile(''), aFile(BOOT_ERROR), 2)).toMatchObject({ end: 'failed', failure: BOOT_ERROR.trim(), usage: null })
  })

  it('a line that does not parse is no stream line', () => {
    expect(read(aFile('not json\n'), aFile(BOOT_ERROR), 2)).toMatchObject({ end: 'failed', failure: BOOT_ERROR.trim() })
  })

  it('a nonzero exit with empty or absent stderr still names the exit', () => {
    expect(read(aFile(''), aFile('  \n'), 2)).toMatchObject({ end: 'failed', failure: expect.stringContaining('exited 2') })
    expect(read(null, null, 137)).toMatchObject({ end: 'failed', failure: expect.stringContaining('exited 137') })
    expect(read(null, path.join(tmpdir(), 'no-such-codex-stderr'), 1)).toMatchObject({ end: 'failed', failure: expect.stringContaining('exited 1') })
  })

  it('no stream with exit zero or an unknown exit stays missing', () => {
    expect(read(aFile(''), aFile(BOOT_ERROR), 0)).toMatchObject({ end: 'missing', failure: null })
    expect(read(aFile(''), aFile(BOOT_ERROR), null)).toMatchObject({ end: 'missing', failure: null })
  })

  it('a nonzero exit after a stream reads by the stream', () => {
    expect(read(W1, aFile(BOOT_ERROR), 1)).toMatchObject({ end: 'completed', failure: null })
    expect(read(aFile('{"type":"thread.started","thread_id":"t"}\n'), aFile(BOOT_ERROR), 1)).toMatchObject({ end: 'missing', failure: null, clientSession: 't' })
  })
})
