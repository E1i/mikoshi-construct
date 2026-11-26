import type { DatabaseSync } from 'node:sqlite'
import type { BusContract, BusEventRow } from '../../core/bus-contract.js'
import type { CardStart } from '../../nodes/launch/launch-executor.js'
import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { TreeFile } from '../../nodes/launch/session-journal.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { cardSessionsIn } from '../../core/card-bodies.js'
import { CARD_STARTED, CARD_STOPPED, SESSION_HEARTBEAT } from '../../core/events.js'
import { ShiftCardStarter } from '../../nodes/launch/launch-starter.js'

const CARD = 2137
const TREE = '/trees/mc-2137'
const LAUNCH_DIR = '/launch'
const LAUNCH_SESSION = 'sess-launch'
const ANSWER_ROUND_SESSION = 'sess-answer-round'
const REVIEW_SESSION = 'sess-review'
const T0 = Date.parse('2026-11-26T10:00:00.000Z')
const MINUTE = 60_000

function at(minutes: number): number {
  return T0 + minutes * MINUTE
}

function stamp(minutes: number): string {
  return new Date(at(minutes)).toISOString()
}

let toolIds = 0

function written(minutes: number, file: string, content: string): string {
  const id = `toolu_${++toolIds}`
  return [
    JSON.stringify({ type: 'assistant', timestamp: stamp(minutes), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `${TREE}/${file}`, content } }] } }),
    JSON.stringify({ type: 'user', timestamp: stamp(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
    JSON.stringify({ type: 'system', timestamp: stamp(minutes + 5) }),
  ].join('\n')
}

const JOURNALS: Record<string, string> = {
  [LAUNCH_SESSION]: written(1, 'src/launched.ts', 'launched\n'),
  [ANSWER_ROUND_SESSION]: written(20, 'src/answered.ts', 'answered\n'),
  [REVIEW_SESSION]: written(30, 'src/foreign.ts', 'nobody of the card wrote this\n'),
}

const TREE_FILES: Record<string, TreeFile> = {
  'src/launched.ts': { content: 'launched\n', mtimeMs: at(1) },
  'src/answered.ts': { content: 'answered\n', mtimeMs: at(20) },
  'src/foreign.ts': { content: 'nobody of the card wrote this\n', mtimeMs: at(30) },
}

const CARD_TEXT = parkingFileText({ card: `#${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: ['src/**'], continue: 'auto', who: 'shift', body: 'Do the card.' })

function row(id: number, type: string, data: Record<string, unknown>): BusEventRow {
  return { id, ts: stamp(id), type, card_id: CARD, pr: null, head: null, dedupe_key: `test:${id}`, payload: JSON.stringify(data), actor: 'worker:launch:launch-1', legacy: false, data }
}

const STOPPED_ANSWER_ROUND: BusEventRow[] = [
  row(0, CARD_STARTED, { session: LAUNCH_SESSION, worktree: TREE }),
  row(10, CARD_STOPPED, { reason: 'question.owner', detail: 'a question' }),
  row(20, SESSION_HEARTBEAT, { step: 'answer', session: ANSWER_ROUND_SESSION }),
  row(25, CARD_STOPPED, { reason: 'fault', detail: 'the answer commit was refused outside the touches' }),
  row(30, SESSION_HEARTBEAT, { step: 'review', session: REVIEW_SESSION }),
]

const RECORDED_BUS = {
  ofCard: (_db: DatabaseSync, card: number, query?: { types?: readonly string[] }) => STOPPED_ANSWER_ROUND.filter(event => event.card_id === card && (query?.types?.includes(event.type) ?? true)),
} as Partial<BusContract> as BusContract

const NO_DB = {} as DatabaseSync

function continuation(changed: string[]): CardStart {
  const ports: StarterPorts = {
    read: cardId => cardId === CARD ? CARD_TEXT : null,
    cut: () => {
      throw new Error('a held tree is never cut')
    },
    base: () => 'b'.repeat(40),
    spawnDetached: () => 4242,
    pgidOf: pid => pid,
    kill: () => {},
    uuid: () => 'sess-next',
    envOf: () => ({}),
    prompt: task => task.body,
    changedPaths: () => changed,
    readReport: () => null,
    cardSessions: cardId => [...new Set(cardSessionsIn(RECORDED_BUS, NO_DB, cardId))],
    readTranscript: (worktree, session) => worktree === TREE ? JOURNALS[session] ?? null : null,
    treeFile: file => TREE_FILES[path.relative(TREE, file)] ?? null,
    freshen: () => ({ kind: 'kept', why: 'the fake tree is not a git tree' }),
  }
  return new ShiftCardStarter({ launchDir: LAUNCH_DIR, treePr: 'true' }, ports).start({ cardId: CARD, lane: 'lane-1', continueIn: { worktree: TREE, base: null } })
}

describe('the held tree guard and an answer round that stopped without card.answered', () => {
  it('edits written by an answer round that stopped without card.answered do not refuse the continuation', () => {
    expect(continuation(['src/launched.ts', 'src/answered.ts'])).toMatchObject({ kind: 'started', card: { worktree: TREE } })
  })

  it('a path no session of the card wrote still refuses with held_tree_changed', () => {
    const outcome = continuation(['src/launched.ts', 'src/foreign.ts'])

    expect(outcome).toMatchObject({ kind: 'refused', denial: { reason: 'held_tree_changed', paths: ['src/foreign.ts'] } })
    expect(outcome.kind === 'refused' && outcome.denial.detail).not.toContain(REVIEW_SESSION)
  })
})
