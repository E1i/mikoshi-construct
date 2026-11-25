import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexAdapter } from '../../ports/client/codex/adapter.js'

const PROBE_ROLLOUT = path.join(import.meta.dirname, 'fixtures', 'codex-token-count.jsonl')
const THREAD = '01a20e60-f504-7c70-b3ea-b83dadef0893'
const ROLLOUT_NAME = `rollout-2026-11-24T23-26-04-${THREAD}.jsonl`

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aCodexHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-window-measure-'))
  roots.push(root)
  vi.stubEnv('CODEX_HOME', root)
  return root
}

function placeRollout(home: string, name: string, from: string = PROBE_ROLLOUT): string {
  const day = path.join(home, 'sessions', '2026', '11', '24')
  mkdirSync(day, { recursive: true })
  const file = path.join(day, name)
  copyFileSync(from, file)
  return file
}

function windowReading(session: string): ReturnType<typeof codexAdapter.reading> {
  return codexAdapter.reading({ session, cwd: '/tree', stdoutPath: null, stderrPath: null, exitCode: null })
}

describe('the codex adapter reads the context and the spend of a window session from its rollout', () => {
  it('takes the spend from the last token_count total and the context from its last turn, as the 0.170.0 probe recorded them', () => {
    placeRollout(aCodexHome(), ROLLOUT_NAME)
    expect(windowReading(THREAD)).toEqual({
      end: 'missing',
      failure: null,
      usage: { input: 3152, cached: 24320, cacheWrite: 0, output: 35, reasoning: 19 },
      costUsd: null,
      turns: null,
      durationMs: null,
      model: null,
      denials: null,
      toolUses: [],
      journal: 'unreadable',
      lastSteps: null,
      contextTokens: 13762,
      clientSession: THREAD,
    })
  })

  it('the spend basis keeps cached out of input and cache-write apart, unlike the claude counters', () => {
    const home = aCodexHome()
    const counted = readFileSync(PROBE_ROLLOUT, 'utf8').replace('"input_tokens":27472,"cached_input_tokens":24320,"cache_write_input_tokens":0', '"input_tokens":27472,"cached_input_tokens":24320,"cache_write_input_tokens":512')
    const source = path.join(home, 'source.jsonl')
    writeFileSync(source, counted)
    placeRollout(home, ROLLOUT_NAME, source)
    expect(windowReading(THREAD).usage).toEqual({ input: 3152, cached: 24320, cacheWrite: 512, output: 35, reasoning: 19 })
  })

  it('a rollout with no token_count measures nothing, never a zero', () => {
    const home = aCodexHome()
    const source = path.join(home, 'source.jsonl')
    writeFileSync(source, `${readFileSync(PROBE_ROLLOUT, 'utf8').split('\n').filter(line => !line.includes('"token_count"')).join('\n')}\n`)
    placeRollout(home, ROLLOUT_NAME, source)
    expect(windowReading(THREAD)).toMatchObject({ usage: null, contextTokens: null, clientSession: THREAD })
  })

  it('a session with no rollout, or no session at all, reads nothing', () => {
    placeRollout(aCodexHome(), ROLLOUT_NAME)
    expect(windowReading('01a20e60-0000-4000-8000-000000000000')).toMatchObject({ usage: null, contextTokens: null, clientSession: null })
    vi.stubEnv('CODEX_HOME', path.join(tmpdir(), 'no-such-codex-home'))
    expect(windowReading(THREAD)).toMatchObject({ usage: null, contextTokens: null })
  })

  it('a recorded exec stream is still read from the stream, not from a rollout', () => {
    placeRollout(aCodexHome(), ROLLOUT_NAME)
    const stream = path.join(import.meta.dirname, 'fixtures', 'codex-w1.jsonl')
    const reading = codexAdapter.reading({ session: THREAD, cwd: '/tree', stdoutPath: stream, stderrPath: null, exitCode: null })
    expect(reading).toMatchObject({ end: 'completed', contextTokens: null, usage: { input: 15506, cached: 21760 } })
  })

  it('the probe rollout carries no home path and no account', () => {
    expect(readFileSync(PROBE_ROLLOUT, 'utf8')).not.toMatch(/\/Users\/|\/home\/|~\/|creator_user_id|creator_account_id/)
  })
})
