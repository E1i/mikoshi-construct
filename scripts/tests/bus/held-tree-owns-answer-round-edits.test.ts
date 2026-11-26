import type { CardStart } from '../../nodes/launch/launch-executor.js'
import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { TreeFile } from '../../nodes/launch/session-journal.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED, CARD_STOPPED, SESSION_HEARTBEAT } from '../../core/events.js'
import { busCardSessions } from '../../nodes/launch/launch-root.js'
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

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busOfAStoppedAnswerRound(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'held-tree-answer-round-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  let sequence = 0
  const record = (minutes: number, type: string, payload: Record<string, unknown>): void => {
    appendEvent(db, { ts: stamp(minutes), type, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `test:${++sequence}`, payload, legacy: false })
  }
  try {
    record(0, CARD_STARTED, { session: LAUNCH_SESSION, worktree: TREE })
    record(10, CARD_STOPPED, { reason: 'question.owner', detail: 'a question' })
    record(20, SESSION_HEARTBEAT, { step: 'answer', session: ANSWER_ROUND_SESSION })
    record(25, CARD_STOPPED, { reason: 'fault', detail: 'the answer commit was refused outside the touches' })
    record(30, SESSION_HEARTBEAT, { step: 'review', session: REVIEW_SESSION })
  }
  finally {
    db.close()
  }
  return busPath
}

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
    cardSessions: busCardSessions(busOfAStoppedAnswerRound()),
    readTranscript: (worktree, session) => worktree === TREE ? JOURNALS[session] ?? null : null,
    treeFile: file => TREE_FILES[path.relative(TREE, file)] ?? null,
    freshen: () => ({ kind: 'kept', why: 'the fake tree is not a git tree' }),
  }
  return new ShiftCardStarter({ launchDir: LAUNCH_DIR, claude: 'claude', treePr: 'true' }, ports).start({ cardId: CARD, lane: 'lane-1', continueIn: { worktree: TREE, base: null } })
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
