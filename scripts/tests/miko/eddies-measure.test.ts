import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { appendExitLine, exitLineOf, projectRoot, realExitReadings, UNKNOWN, UNREAD } from '../../miko/eddies-measure.js'

const SESSION = 'session-972'
const LIMITS = { contextLimit: 250000, sessionSpend: 3000000, agentSpend: 2000000, runSpend: 3000000, warnRatio: 0.8 }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(limits: unknown = LIMITS): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-measure-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, '.claude', 'eddies.json'), JSON.stringify(limits))
  return dir
}

function usageLine(timestamp: string, requestId: string, usage: { input: number, cacheWrite?: number, cacheRead?: number }): string {
  return JSON.stringify({ type: 'assistant', timestamp, requestId, message: { role: 'assistant', usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 } } })
}

function transcript(dir: string, lines: string[]): string {
  const file = path.join(dir, '.claude', 'projects', '-repo', `${SESSION}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('realExitReadings reads the session the way Eddies reads it', () => {
  it('takes the context of the last answer, the counters of the first and last, and the spend over parent and subagents', () => {
    const dir = scratch()
    const file = transcript(dir, [
      usageLine('2026-10-15T00:00:00.000Z', 'r1', { input: 100, cacheWrite: 1000, cacheRead: 0 }),
      usageLine('2026-10-15T00:01:00.000Z', 'r2', { input: 10, cacheWrite: 200, cacheRead: 1100 }),
    ])
    const agent = path.join(file.replace(/\.jsonl$/, ''), 'subagents', 'agent-a1.jsonl')
    mkdirSync(path.dirname(agent), { recursive: true })
    writeFileSync(agent, `${usageLine('2026-10-15T00:00:30.000Z', 'a1', { input: 50 })}\n`)
    expect(realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, path.join(dir, 'bus.db'))).toEqual({
      sessionId: SESSION,
      start: { input: 100, cache_write: 1000, cache_read: 0 },
      end: { input: 10, cache_write: 200, cache_read: 1100 },
      context: 1310,
      contextWarn: LIMITS.contextLimit * LIMITS.warnRatio,
      spent: 100 + 10 + 50 + (1000 + 200) * 1.25 + 1100 * 0.1,
      spendWarn: LIMITS.sessionSpend * LIMITS.warnRatio,
      cards: UNKNOWN,
      busEvents: UNKNOWN,
    })
  })

  it('counts the bus events and their distinct cards from the first line of the session on', () => {
    const dir = scratch()
    transcript(dir, [usageLine('2026-10-15T00:00:00.000Z', 'r1', { input: 1 })])
    const busPath = path.join(dir, 'bus.db')
    const db = openBus(busPath)
    try {
      for (const [n, ts, card] of [[1, '2026-10-14T23:59:59.000Z', 7], [2, '2026-10-15T00:00:00.000Z', 970], [3, '2026-10-15T00:05:00.000Z', 972], [4, '2026-10-15T00:06:00.000Z', 972], [5, '2026-10-15T00:07:00.000Z', null]] as const)
        appendEvent(db, { ts, type: 'note', actor: 'owner', cardId: card, pr: null, head: null, dedupeKey: `note:${n}`, payload: {}, legacy: false })
    }
    finally {
      db.close()
    }
    expect(realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, busPath)).toMatchObject({ busEvents: 4, cards: 2 })
  })

  it.each([
    { name: 'no session variable', env: {} },
    { name: 'a session id that is not a plain id', env: { CLAUDE_CODE_SESSION_ID: '../x' } },
  ])('with $name reads nothing of the session and keeps the limits', ({ env }) => {
    const dir = scratch()
    expect(realExitReadings(env, dir, dir, path.join(dir, 'bus.db'))).toEqual({ ...UNREAD, contextWarn: LIMITS.contextLimit * LIMITS.warnRatio, spendWarn: LIMITS.sessionSpend * LIMITS.warnRatio })
  })

  it.each([
    { name: 'a warn ratio above one', limits: { ...LIMITS, warnRatio: 2 }, read: UNREAD },
    { name: 'a session spend of zero', limits: { ...LIMITS, sessionSpend: 0 }, read: { ...UNREAD, contextWarn: LIMITS.contextLimit * LIMITS.warnRatio } },
  ])('reads limits it cannot validate as unknown, never as zero: $name', ({ limits, read }) => {
    const dir = scratch(limits)
    expect(realExitReadings({}, dir, dir, path.join(dir, 'bus.db'))).toEqual(read)
  })
})

describe('the session-exit line', () => {
  it('is appended to .construct/eddies.jsonl of the project root, one line per exit', () => {
    const dir = scratch()
    appendExitLine(dir, exitLineOf(UNREAD, 'context', '2026-10-15T00:00:00.000Z'))
    appendExitLine(dir, exitLineOf(UNREAD, 'done', '2026-10-15T00:00:01.000Z'))
    const lines = readFileSync(path.join(dir, '.construct', 'eddies.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { reason: string, spent: unknown })
    expect(lines.map(line => [line.reason, line.spent])).toEqual([['context', UNKNOWN], ['done', UNKNOWN]])
  })

  it.each([
    { env: { CLAUDE_PROJECT_DIR: '/p' }, root: '/p' },
    { env: { CLAUDE_PROJECT_DIR: '' }, root: path.join(import.meta.dirname, '..', '..', '..') },
    { env: {}, root: path.join(import.meta.dirname, '..', '..', '..') },
  ])('takes its project root from CLAUDE_PROJECT_DIR, else the repository of the script ($env)', ({ env, root }) => {
    expect(projectRoot(env)).toBe(root)
  })
})
