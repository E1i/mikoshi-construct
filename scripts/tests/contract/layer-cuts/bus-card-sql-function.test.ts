import type { DatabaseSync } from 'node:sqlite'
import type { AnswerRun } from '../../../nodes/answer/answer-worker.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { closedWaitIds } from '../../../core/card-readings.js'
import { appendEvent, BUS_DB_VARIABLE, openBus, openBusWait } from '../../../core/db.js'
import { CARD_STOPPED, QUESTION_OWNER, REQUEST_DONE, REQUEST_REFUSED } from '../../../core/events.js'
import { CARD_BLOCKS } from '../../../core/inbox.js'
import { reduce } from '../../../core/reducer.js'
import { answerNodeOf } from '../../../nodes/answer/answer-worker.js'
import { cardDecisionCommand } from '../../../policy/shards.js'
import { busProjections, openComposedBus } from '../../../supervisor/composition.js'
import { runReducerLoop } from '../../../supervisor/reducer-thread.js'
import { OWNER_WORD_NEEDED, runRequest } from '../../../window/window-requests.js'

const INBOX_ROOT = path.join(import.meta.dirname, '..', '..', '..', 'owner', 'inbox.ts')

const DB = 'scripts/core/db.ts'
const GRAMMAR = 'src/card/grammar.ts'
const CARD_LINE = '#2113 cut-bus-card-sql-function [implement/construct/M/cheap/auto] · depends — · blocks #2114 #2115'
const NOT_A_CARD = 'not a card line'
const STOPPED_CARD = 2113
const NOW = new Date('2026-11-21T09:00:00.000Z')

const opened: DatabaseSync[] = []
const dirs: string[] = []

function busFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bus-card-sql-'))
  dirs.push(dir)
  return path.join(dir, 'bus.db')
}

function blocksOf(db: DatabaseSync, line: string | null): unknown {
  return (db.prepare(`SELECT ${CARD_BLOCKS}(?) AS blocks`).get(line) as { blocks: unknown }).blocks
}

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('the bus opens the database and the card owner registers its own SQL function', () => {
  it('repositoryReport() holds no import scripts/core/db.ts -> src/card/grammar.ts', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === DB && to === GRAMMAR)).toEqual([])
  })

  it('a bus opened by the composition answers card_blocks', () => {
    const db = openComposedBus(busFile())
    opened.push(db)
    expect(JSON.parse(String(blocksOf(db, CARD_LINE)))).toEqual([2114, 2115])
    expect(blocksOf(db, NOT_A_CARD)).toBeNull()
    expect(blocksOf(db, null)).toBeNull()
  })

  it('the answer node registers card_blocks on the bare bus its worker opened', () => {
    const db = openBus(busFile())
    opened.push(db)
    const run: AnswerRun = { liveSession: () => null, busPath: ':memory:', answerer: async () => Promise.reject(new Error('no answer runs here')), ownerMerges: () => '', cardText: () => null, session: 'worker-1', pause: async () => {}, isolation: () => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [] }) }
    answerNodeOf(run, db, 'shadow')
    expect(JSON.parse(String(blocksOf(db, CARD_LINE)))).toEqual([2114, 2115])
  })

  it('a bare bus knows no card grammar', () => {
    const db = openBus(busFile())
    opened.push(db)
    expect(() => blocksOf(db, CARD_LINE)).toThrow(/no such function/)
  })

  it('the inbox root reads the owner inbox from a bus the composition opened', () => {
    const file = busFile()
    const printed = spawnSync(process.execPath, ['--import', 'tsx', INBOX_ROOT], { env: { ...process.env, [BUS_DB_VARIABLE]: file }, encoding: 'utf8' })
    expect(printed.stderr).toBe('')
    expect(printed.stdout).toContain('the owner inbox is empty')
    expect(printed.status).toBe(0)
  }, 60_000)
  it('the reducer thread answers an owner-wait-close request that reads card_blocks on the bus it opened', async () => {
    const file = busFile()
    const setup = openComposedBus(file)
    opened.push(setup)
    const ts = NOW.toISOString()
    const wait = openBusWait(setup, closedWaitIds(setup), ts, 'worker:answer:s1', { need: 'decision', text: `card #${STOPPED_CARD} asks: which path?`, command: cardDecisionCommand(STOPPED_CARD), card: STOPPED_CARD })
    appendEvent(setup, { ts, type: CARD_STOPPED, actor: 'worker:answer:s1', cardId: STOPPED_CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${STOPPED_CARD}`, payload: { reason: QUESTION_OWNER, detail: 'which path?' }, legacy: false })
    reduce(setup, 'pending', busProjections())
    expect(runRequest(['owner.wait.close', '--id', wait, '--answer', 'go'], setup, NOW, 'test', () => {})).toBe(0)

    let passes = 0
    await runReducerLoop(file, path.join(path.dirname(file), 'home'), 0, () => passes++ === 0, () => {}, () => {})

    const outcomes = setup.prepare('SELECT type, payload FROM events WHERE type IN (?, ?)').all(REQUEST_DONE, REQUEST_REFUSED) as { type: string, payload: string }[]
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.payload).not.toContain('no such function')
    expect(outcomes[0]!.type).toBe(REQUEST_REFUSED)
    expect(outcomes[0]!.payload).toContain(OWNER_WORD_NEEDED)
  }, 60_000)
})
