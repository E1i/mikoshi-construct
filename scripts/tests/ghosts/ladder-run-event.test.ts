import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER_FILE } from '../../../src/commands/cost/ledger.js'
import { RUN_RECORD_CARD_VARIABLE, runRecord } from '../../../src/commands/run-record.js'
import { BUS_DB_VARIABLE, busPathOf } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { EVENT_PAYLOADS, LADDER_RUN } from '../../core/events.js'
import { busLadderRun } from '../../intake/intake.js'
import { ladderRunMark, NO_LADDER_RUN, readLadderOutcome, readLadderStage, runSourceOf } from '../../ladder/ledger.js'
import { CARD_VARIABLE } from '../../ports/session.js'

const CARD = 1750
const NOW = new Date('2026-11-10T12:00:00.000Z')
const STEP_FOUR = { run: 'wf_1750', at: '2026-11-10T11:59:00.000Z', task: 'ladder-run-event-writer', effort: 'medium', status: 'done', rung: 'medium', attempts: [{ rung: 1, effort: 'low', outcome: 'harness failed', reason: 'red' }, { rung: 2, effort: 'medium', outcome: 'passed', reason: '' }], agents: 3, tokens: 120_000, toolUses: 40, seconds: 600 }

function aTree(): { tree: string, home: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ladder-run-event-'))
  return { tree: path.join(root, 'tree'), home: path.join(root, 'home') }
}

function wiredBus(): { tree: string, home: string, busPath: string, env: NodeJS.ProcessEnv } {
  const { tree, home } = aTree()
  const busPath = path.join(path.dirname(tree), 'bus.db')
  openBus(busPath).close()
  return { tree, home, busPath, env: { [BUS_DB_VARIABLE]: busPath, [RUN_RECORD_CARD_VARIABLE]: String(CARD) } }
}

function ladderRuns(busPath: string): { type: string, card_id: number | null, actor: string, ts: string, payload: string, legacy: number }[] {
  const db = openBus(busPath)
  try {
    return db.prepare('SELECT type, card_id, actor, ts, payload, legacy FROM events WHERE type = ? ORDER BY id').all(LADDER_RUN) as { type: string, card_id: number | null, actor: string, ts: string, payload: string, legacy: number }[]
  }
  finally {
    db.close()
  }
}

describe('the run record of the /implement ladder', () => {
  it('the run command records one ladder.run event and writes no runs.jsonl line', () => {
    const { tree, home, busPath, env } = wiredBus()
    const result = runRecord(JSON.stringify(STEP_FOUR), { dir: tree, env, home, now: () => NOW }, busLadderRun)

    expect(result).toEqual({ kind: 'recorded', adapter: 'bus', target: busPath, fresh: true })
    const rows = ladderRuns(busPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: LADDER_RUN, card_id: CARD, actor: 'worker:ladder:wf_1750', ts: NOW.toISOString(), legacy: 0 })
    expect(JSON.parse(rows[0]!.payload)).toEqual(STEP_FOUR)
    expect(existsSync(path.join(tree, LEDGER_FILE))).toBe(false)
  })

  it('the supervisor reads the ladder outcome of a run from its ladder.run event', () => {
    const { tree, home, busPath, env } = wiredBus()
    const source = runSourceOf(tree, CARD, env, home)
    expect(source).toEqual({ kind: 'bus', busPath, card: CARD })

    runRecord(JSON.stringify({ ...STEP_FOUR, run: 'wf_before', status: 'failed', cause: 'task' }), { dir: tree, env, home, now: () => NOW }, busLadderRun)
    const mark = ladderRunMark(source)
    expect(readLadderOutcome(source, mark)).toEqual({ status: NO_LADDER_RUN, run: null, iterations: null, actual: null })

    runRecord(JSON.stringify({ ...STEP_FOUR, run: 'wf_other' }), { dir: tree, env: { ...env, [RUN_RECORD_CARD_VARIABLE]: '9' }, home, now: () => NOW }, busLadderRun)
    runRecord(JSON.stringify(STEP_FOUR), { dir: tree, env, home, now: () => NOW }, busLadderRun)

    expect(readLadderOutcome(source, mark)).toEqual({ status: 'done', run: 'wf_1750', iterations: 2, actual: { tokens: 120_000, minutes: 10 } })
    expect(readLadderStage(source)).toEqual({ kind: 'entry', status: 'done', run: 'wf_1750' })
    expect(existsSync(path.join(tree, LEDGER_FILE))).toBe(false)
  })

  it('with no bus wired the run command appends one runs.jsonl line with the step 4 fields and writes no event', () => {
    const { tree, home } = aTree()
    const env: NodeJS.ProcessEnv = { [RUN_RECORD_CARD_VARIABLE]: String(CARD) }
    const result = runRecord(JSON.stringify(STEP_FOUR), { dir: tree, env, home, now: () => NOW }, busLadderRun)

    const file = path.join(tree, LEDGER_FILE)
    expect(result).toEqual({ kind: 'recorded', adapter: 'file', target: file, fresh: true })
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => line !== '')
    expect(lines.map(line => JSON.parse(line) as unknown)).toEqual([STEP_FOUR])
    expect(existsSync(busPathOf(env, home, tree))).toBe(false)
    expect(runSourceOf(tree, CARD, env, home)).toEqual({ kind: 'file', runsPath: file })
  })

  it('takes the card from the same variable a card session carries, and the fields the ladder.run event declares', () => {
    expect(RUN_RECORD_CARD_VARIABLE).toBe(CARD_VARIABLE)
    expect([...EVENT_PAYLOADS[LADDER_RUN]].sort()).toEqual(Object.keys({ ...STEP_FOUR, cause: 0, tokensSource: 0, agreedSha256: 0, argsSha256: 0, sketch: 0 }).sort())
  })

  it('records the same run once, and takes the card from the task when the session names none', () => {
    const { tree, home, busPath } = wiredBus()
    const env = { [BUS_DB_VARIABLE]: busPath }
    const record = JSON.stringify({ ...STEP_FOUR, task: '#1751 ladder-run-step-four' })
    expect(runRecord(record, { dir: tree, env, home, now: () => NOW }, busLadderRun)).toMatchObject({ fresh: true })
    expect(runRecord(record, { dir: tree, env, home, now: () => NOW }, busLadderRun)).toMatchObject({ fresh: false })
    expect(ladderRuns(busPath).map(row => row.card_id)).toEqual([1751])
  })

  it('with a bus wired and no factory port the published command writes nothing and names the bus', () => {
    const { tree, home, busPath, env } = wiredBus()
    expect(runRecord(JSON.stringify(STEP_FOUR), { dir: tree, env, home, now: () => NOW })).toEqual({ kind: 'needsBus', busPath })
    expect(ladderRuns(busPath)).toEqual([])
    expect(existsSync(path.join(tree, LEDGER_FILE))).toBe(false)
  })
})
