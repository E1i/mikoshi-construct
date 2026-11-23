import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_STARTED, SESSION_HEARTBEAT } from '../../scripts/core/events.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { BOARD_BUS } from '../../src/commands/board/index.js'
import { screenLines } from '../../src/commands/board/screens.js'
import { queuedLine } from '../../src/commands/board/sessions.js'
import { readTranscript, sessionTimeLine } from '../../src/commands/liveness.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-15T11:00:00.000Z')
const RUNNING = 1938
const SILENT = 1939
const BEHIND = 1940
const QUEUED = 1941

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function line(timestamp: string, type: string, content: unknown[]): string {
  return JSON.stringify({ type, timestamp, message: { content } })
}

const TRANSCRIPTS: Record<string, string> = {
  's-running': [
    line('2026-11-15T10:21:00.000Z', 'user', [{ type: 'text', text: 'the brief' }]),
    line('2026-11-15T10:57:00.000Z', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm exec vitest run' } }]),
  ].join('\n'),
  's-silent': [
    line('2026-11-15T10:30:00.000Z', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } }]),
    line('2026-11-15T10:48:00.000Z', 'user', [{ type: 'tool_result', tool_use_id: 't1' }]),
  ].join('\n'),
}

function beat(card: number, session: string, ts: string): { ts: string, type: string, card: number, payload: string } {
  return { ts, type: SESSION_HEARTBEAT, card, payload: JSON.stringify({ session, step: 'answer' }) }
}

function started(card: number): { ts: string, type: string, card: number, payload: string } {
  return { ts: '2026-11-15T10:00:00.000Z', type: CARD_STARTED, card, payload: JSON.stringify({ session: `launch-${card}`, worktree: `/trees/mc-${card}` }) }
}

function facts(): BusFacts {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-session-time-'))
  dirs.push(dir)
  const file = writeBus(path.join(dir, 'bus.db'), {
    cards: [RUNNING, SILENT, BEHIND, QUEUED].map(id => ({ id, state: 'changes', lane: 'lane-a', line: `card: #${id} timed` })),
    tasks: [{ queue: 'review', card: BEHIND, pr: null, head: null, state: 'leased' }, { queue: 'review', card: QUEUED, pr: null, head: null, state: 'queued' }],
    events: [
      started(RUNNING),
      started(SILENT),
      beat(RUNNING, 's-running', '2026-11-15T10:20:00.000Z'),
      beat(RUNNING, 's-running', '2026-11-15T10:59:00.000Z'),
      beat(SILENT, 's-silent', '2026-11-15T10:25:00.000Z'),
      beat(SILENT, 's-silent', '2026-11-15T10:58:00.000Z'),
    ],
  })
  const reading = busReaderAt(file, () => NOW, (tree, session) => tree.startsWith('/trees/mc-') ? TRANSCRIPTS[session] ?? null : null)(BOARD_BUS)
  if (reading.status !== 'read')
    throw new Error(`the bus was not read: ${reading.status}`)
  return reading.facts
}

function stepOf(read: BusFacts, card: number): string {
  return read.services.find(service => service.task === `#${card}` && service.role === 'answer')!.step
}

describe('the board shows the time of a live session', () => {
  it('a live session row shows elapsed time and the current action and an unknown wait reason without a reliable source', () => {
    const read = facts()

    expect(stepOf(read, RUNNING)).toContain('started 40 min ago · now Bash pnpm exec vitest run for 3 min')
    expect(stepOf(read, SILENT)).toContain('started 35 min ago · waits for an unknown reason for 12 min, no line in the transcript since 10:48:00 · last Edit src/a.ts ended at 10:48:00')
    expect(screenLines(read, PLAIN_LORE).join('\n')).toContain('now Bash pnpm exec vitest run for 3 min')
  })

  it('names the wait only from a reliable source, and says when no transcript was read', () => {
    const transcript = readTranscript(TRANSCRIPTS['s-silent']!)
    const wait = { source: 'scheduler', reason: 'the heavy-run slot is held by #1937', since: '2026-11-15T10:50:00.000Z' } as const
    expect(sessionTimeLine({ startedAt: '2026-11-15T10:25:00.000Z', transcript, wait }, NOW)).toBe('started 35 min ago · waits on the scheduler: the heavy-run slot is held by #1937 for 10 min · last Edit src/a.ts ended at 10:48:00')
    expect(sessionTimeLine({ startedAt: '2026-11-15T10:25:00.000Z', transcript: null, wait: null }, NOW)).toBe('started 35 min ago · current action not read: no transcript of this session was found')
    expect(sessionTimeLine({ startedAt: '2026-11-15T10:25:00.000Z', transcript, wait: null }, new Date('2026-11-15T10:50:00.000Z'))).toContain('between actions for 2 min')
  })

  it('a queued task shows whom it stands behind and how long it waited', () => {
    const read = facts()
    expect(read.queued).toEqual([{ card: QUEUED, queue: 'review', since: null, behind: [BEHIND] }])
    expect(screenLines(read, PLAIN_LORE).join('\n')).toContain('queued in review, behind #1940 · waited for a time the bus did not record')
    expect(queuedLine({ card: QUEUED, queue: 'answer', since: '2026-11-15T10:45:00.000Z', behind: [] }, NOW)).toBe('queued in answer, first in the queue · waited 15 min')
  })
})
