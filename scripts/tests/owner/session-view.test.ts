import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_STARTED, SESSION_HEARTBEAT } from '../../core/events.js'
import { cardSessionOf } from '../../supervisor/expected-time.js'
import { PREFIX, runOwnerSession, USAGE } from '../../supervisor/session-view.js'
import { mergeBench } from '../bus/merge-bench.js'

const CARD = 1938
const SESSION = 's-1938-answer'
const TREE = '/trees/mc-1938'
const START = '2026-11-15T10:00:00.000Z'
const NOW = new Date('2026-11-15T10:58:00.000Z')
const COVERAGE = '--coverage'

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function line(timestamp: string, type: string, content: unknown[]): string {
  return JSON.stringify({ type, timestamp, message: { content } })
}

const TRANSCRIPT = [
  line('2026-11-15T10:00:10.000Z', 'user', [{ type: 'text', text: 'the brief' }]),
  line('2026-11-15T10:01:00.000Z', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'scripts/owner/answer.ts' } }]),
  line('2026-11-15T10:01:02.000Z', 'user', [{ type: 'tool_result', tool_use_id: 't1' }]),
  line('2026-11-15T10:02:00.000Z', 'assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm exec vitest run' } }]),
  line('2026-11-15T10:18:00.000Z', 'user', [{ type: 'tool_result', tool_use_id: 't2' }]),
  line('2026-11-15T10:55:00.000Z', 'assistant', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm typecheck' } }]),
  'not a json line',
].join('\n')

function room(): MergeBench {
  const bench = mergeBench()
  benches.push(bench)
  appendEvent(bench.db, { ts: START, type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:session-view`, payload: { session: 'launch-session', worktree: TREE, pid: 1, pgid: 1 }, legacy: false })
  for (const [index, ts] of ['2026-11-15T10:00:30.000Z', '2026-11-15T10:57:00.000Z'].entries())
    appendEvent(bench.db, { ts, type: SESSION_HEARTBEAT, actor: 'worker:answer:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${SESSION_HEARTBEAT}:session-view-${index}`, payload: { session: SESSION, step: 'answer' }, legacy: false })
  return bench
}

function eventCount(bench: MergeBench): number {
  return (bench.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n
}

describe('the owner session view', () => {
  it('the owner command prints the last actions of the live session of a card with times', () => {
    const bench = room()
    const before = eventCount(bench)
    const read: [string, string][] = []
    const out: string[] = []

    expect(runOwnerSession({ args: [`#${CARD}`], coverageFlag: COVERAGE }, bench.db, (tree, session) => {
      read.push([tree, session])
      return TRANSCRIPT
    }, NOW, line => out.push(line))).toBe(0)

    expect(read).toEqual([[TREE, SESSION]])
    expect(out).toEqual([
      `${PREFIX}card #${CARD} session ${SESSION} in ${TREE}`,
      `${PREFIX}started 10:00:30, 58 min ago · last heartbeat 1 min ago`,
      `${PREFIX}now: Bash pnpm typecheck, running for 3 min`,
      `${PREFIX}last actions:`,
      `${PREFIX}  10:01:00  Read scripts/owner/answer.ts (ran 0 min)`,
      `${PREFIX}  10:02:00  Bash pnpm exec vitest run (ran 16 min)`,
      `${PREFIX}  10:55:00  Bash pnpm typecheck (running 3 min)`,
      `${PREFIX}long gaps:`,
      `${PREFIX}  10:02:00 → 10:18:00  16 min after Bash pnpm exec vitest run`,
      `${PREFIX}  10:18:00 → 10:55:00  37 min after Bash pnpm exec vitest run`,
    ])
    expect(eventCount(bench)).toBe(before)
  })

  it('says where the transcript is missing and refuses a word that names no card', () => {
    const bench = room()
    const out: string[] = []
    expect(runOwnerSession({ args: [String(CARD)], coverageFlag: COVERAGE }, bench.db, () => null, NOW, line => out.push(line))).toBe(0)
    expect(out.at(-1)).toBe(`${PREFIX}no transcript of session ${SESSION} was found for the tree ${TREE}`)
    expect(cardSessionOf(bench.db, 4040)).toBeNull()
    const refused: string[] = []
    expect(runOwnerSession({ args: ['stop'], coverageFlag: COVERAGE }, bench.db, () => null, NOW, line => refused.push(line))).toBe(2)
    expect(refused).toEqual([`${PREFIX}${USAGE}`])
  })
})
