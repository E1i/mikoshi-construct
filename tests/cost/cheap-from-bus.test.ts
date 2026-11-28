import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ghostLines } from '../../scripts/core/bus-history.js'
import { cardTurnsOf, ladderRunPayloads, legacyLinePayloads } from '../../scripts/core/card-readings.js'
import { openBus } from '../../scripts/core/db.js'
import { CARD_ANSWERED, CARD_CLOSED, CARD_STARTED, GHOST_LINE, LADDER_RUN, PR_CLOSED } from '../../scripts/core/events.js'
import { ladderRunMark, readLadderOutcome } from '../../scripts/ladder/ledger.js'
import { endedCards, readBusTasks, readLegacyLines } from '../../src/commands/cost/bus.js'
import { cheapRows, projectKey, readCheapClasses, readCheapTasks } from '../../src/commands/cost/index.js'
import { readLedger } from '../../src/commands/cost/ledger.js'
import { busCard, writeBus, writeLegacy } from '../cost-bus.js'

const WINDOW_TREE = '/work/main'
const CARD_TREE = '/work/mc-90'

function root(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-cheap-bus-')))
}

function session(projects: string, worktree: string, id: string, tokens: number): void {
  const file = path.join(projects, projectKey(worktree), `${id}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })}\n`)
}

function windowLines(task: string): Record<string, unknown>[] {
  return [
    { event: 'path', task, path: 'cheap', started: '2026-10-01T00:00:00.000Z', session: `w${task}`, worktree: WINDOW_TREE, card: { id: Number(task), kind: 'implement', size: 'S', contour: 'cheap' }, ts: '2026-10-01T00:00:00.000Z' },
    { event: 'path', task, path: 'cheap', pr: Number(task), verification: 'run', ended: '2026-10-01T00:06:00.000Z', sessions: [{ id: `w${task}`, project: projectKey(WINDOW_TREE) }], ts: '2026-10-01T00:06:00.000Z' },
  ]
}

const CARD_CLOSE_IN_JOURNAL = { event: 'path', task: '90', path: 'cheap', pr: 90, verification: 'run', ended: '2026-10-14T00:10:00.000Z', sessions: [{ id: 's90', project: projectKey(CARD_TREE) }, { id: 'a90', project: projectKey(CARD_TREE) }], ts: '2026-10-14T00:10:00.000Z' }

describe('cost cheap reads the bus', () => {
  it('cost cheap from the bus matches the journal figures for one period', () => {
    const projects = root()
    const windowTasks = ['11', '12', '13', '14', '15']
    windowTasks.forEach((task, index) => session(projects, WINDOW_TREE, `w${task}`, (index + 1) * 1000))
    session(projects, CARD_TREE, 's90', 300)
    session(projects, CARD_TREE, 'a90', 200)
    const bus = path.join(root(), 'bus.db')
    writeBus(bus, [busCard(90, {
      started: '2026-10-14T00:00:00.000Z',
      ended: CARD_CLOSE_IN_JOURNAL.ended,
      start: { session: 's90', worktree: CARD_TREE, branch: 'b' },
      answered: { ts: '2026-10-14T00:05:00.000Z', answer: { session: 'a90', worktree: CARD_TREE } },
    })])
    writeLegacy(bus, [...windowTasks.flatMap(windowLines), CARD_CLOSE_IN_JOURNAL])

    const reading = readCheapClasses(path.join(root(), 'no-shifts'), projects, bus)
    expect(reading.classes.map(({ forecast, notes }) => ({ forecast, notes }))).toEqual([
      { forecast: { kind: 'none', taskClass: 'implement/M', n: 1 }, notes: [] },
      { forecast: { kind: 'forecast', taskClass: 'implement/S', n: 5, tokens: 3000, minutes: 6 }, notes: [] },
    ])
    const { tasks } = readCheapTasks(path.join(root(), 'no-shifts'), bus)
    expect(cheapRows(tasks, 'implement/M', projects)).toEqual([{ task: '90', tokens: 300 + 200, minutes: 10 }])
  })
})

const ENDED_CARDS_SQL = `
SELECT c.card_id, b.card_line, e.ts AS ended, e.type AS end_type, e.payload AS end_payload
FROM cards c
JOIN card_bodies b ON b.card_id = c.card_id
JOIN events e ON e.id = coalesce(
  (SELECT max(m.id) FROM events m WHERE (m.card_id = c.card_id OR m.pr IN (SELECT p.pr FROM prs p WHERE p.card_id = c.card_id)) AND m.type = '${PR_CLOSED}' AND m.legacy = 0 AND json_extract(m.payload, '$.merged') = 1),
  (SELECT max(k.id) FROM events k WHERE k.card_id = c.card_id AND k.type = '${CARD_CLOSED}')
)
WHERE e.ts IS NOT NULL
ORDER BY c.card_id
`
const SPEND_EVENTS_SQL = `SELECT card_id, type, ts, payload FROM events WHERE legacy = 0 AND type IN ('card.started', 'card.answered') AND card_id IS NOT NULL AND ts IS NOT NULL ORDER BY id`
const LEGACY_LINES_SQL = 'SELECT payload FROM events WHERE legacy = 1 ORDER BY id'
const LEDGER_EVENTS_SQL = 'SELECT payload FROM events WHERE type = ? ORDER BY id'
const GHOST_LINES_SQL = `SELECT payload FROM events WHERE type = '${GHOST_LINE}' AND legacy = 0 ORDER BY id`
const LAST_EVENT_ID_SQL = 'SELECT coalesce(max(id), 0) AS id FROM events'
const LAST_RUN_OF_CARD_SQL = 'SELECT id, payload FROM events WHERE type = ? AND card_id = ? AND id > ? ORDER BY id DESC LIMIT 1'

const MERGED_THROUGH_PRS_ONLY = 7
const LADDER_CARD = 7
const BASE = Date.parse('2026-11-20T00:00:00.000Z')
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString()
const cheapLine = (id: number, size = 'M'): string => `#${id} owner-reads-ladder [implement/construct/${size}/cheap/owner] · depends — · blocks —`
const ladderRow = (run: string): string => JSON.stringify({ run, at: at(1), task: 'owner-reads-ladder', effort: 'medium', status: 'done', rung: 'medium', attempts: [{ rung: 1, effort: 'medium', outcome: 'passed', reason: '' }], agents: 1, tokens: 1000, toolUses: 3, seconds: 60 })

interface FixtureEvent {
  type: string
  ts?: string | null
  card?: number
  pr?: number
  legacy?: boolean
  payload?: unknown
}

function fixtureBus(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'owner-reads-ladder-')), 'bus.db')
  openBus(file).close()
  const db = new DatabaseSync(file)
  let key = 0
  const event = ({ type, ts = at(0), card, pr, legacy = false, payload = {} }: FixtureEvent): number => {
    key += 1
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return Number(db.prepare('INSERT INTO events (ts, type, actor, card_id, pr, dedupe_key, payload, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ts, type, legacy ? null : 'reducer', card ?? null, pr ?? null, `fixture:${key}`, text, legacy ? 1 : 0).lastInsertRowid)
  }
  const card = (id: number, line: string | null): void => {
    const admitted = event({ type: 'card.admitted', card: id })
    db.prepare('INSERT INTO cards (card_id, state, event_id) VALUES (?, ?, ?)').run(id, 'closed', admitted)
    db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, card_line) VALUES (?, ?, ?, ?, ?)').run(id, admitted, line ?? '', 'sha', line)
  }
  const linkInPrs = (pr: number, id: number): void => {
    db.prepare('INSERT INTO prs (pr, card_id, event_id) VALUES (?, ?, ?)').run(pr, id, event({ type: 'pr.observed', pr }))
  }

  card(MERGED_THROUGH_PRS_ONLY, cheapLine(MERGED_THROUGH_PRS_ONLY))
  linkInPrs(70, MERGED_THROUGH_PRS_ONLY)
  event({ type: CARD_STARTED, ts: at(0), card: MERGED_THROUGH_PRS_ONLY, payload: { session: 's7', worktree: '/work/mc-7' } })
  event({ type: CARD_STARTED, ts: at(0), card: MERGED_THROUGH_PRS_ONLY, legacy: true, payload: { session: 'legacy7', worktree: '/work/legacy-7' } })
  event({ type: CARD_ANSWERED, ts: at(3), card: MERGED_THROUGH_PRS_ONLY, payload: { session: 'a7', worktree: '/work/mc-7' } })
  event({ type: LADDER_RUN, ts: at(1), card: LADDER_CARD, payload: ladderRow('wf_live') })
  event({ type: LADDER_RUN, ts: at(2), card: LADDER_CARD, legacy: true, payload: ladderRow('wf_legacy') })
  event({ type: LADDER_RUN, ts: at(2), card: 8, payload: ladderRow('wf_other_card') })
  event({ type: PR_CLOSED, ts: at(6), pr: 70, payload: { merged: true } })

  card(8, cheapLine(8, 'S'))
  event({ type: CARD_STARTED, ts: at(0), card: 8, payload: { session: 's8', worktree: '/work/mc-8' } })
  event({ type: CARD_CLOSED, ts: at(2), card: 8, payload: { verification: 'run' } })
  event({ type: PR_CLOSED, ts: at(4), card: 8, pr: 80, payload: { merged: 1 } })

  card(9, cheapLine(9))
  event({ type: CARD_STARTED, ts: at(0), card: 9, payload: { session: 's9', worktree: '/work/mc-9' } })
  event({ type: PR_CLOSED, ts: at(3), card: 9, pr: 90, payload: { merged: false } })
  event({ type: CARD_CLOSED, ts: at(5), card: 9, legacy: true, payload: { verification: 'run' } })

  card(10, cheapLine(10))
  event({ type: PR_CLOSED, ts: at(3), card: 10, pr: 100, legacy: true, payload: { merged: true } })
  event({ type: CARD_CLOSED, ts: at(7), card: 10, payload: { verification: 'run' } })

  card(11, cheapLine(11))
  event({ type: CARD_CLOSED, ts: null, card: 11, legacy: true, payload: { verification: 'run' } })

  card(12, null)
  event({ type: CARD_CLOSED, ts: at(1), card: 12, payload: {} })

  event({ type: CARD_CLOSED, ts: at(1), card: 13, payload: {} })

  card(14, cheapLine(14))
  linkInPrs(140, 14)
  linkInPrs(141, 14)
  event({ type: PR_CLOSED, ts: at(8), pr: 141, payload: { merged: true } })
  event({ type: PR_CLOSED, ts: at(9), pr: 140, payload: { merged: true } })
  event({ type: PR_CLOSED, ts: at(10), pr: 142, payload: { merged: true } })

  event({ type: GHOST_LINE, ts: at(1), payload: { ghost: 'live' } })
  event({ type: GHOST_LINE, ts: at(1), legacy: true, payload: { ghost: 'legacy' } })
  event({ type: 'path', ts: null, legacy: true, payload: { event: 'path', task: '5' } })
  event({ type: 'unreadable', ts: null, legacy: true, payload: 'not json' })
  db.close()
  return file
}

function withBus<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function plain<T>(rows: unknown[]): T[] {
  return rows.map(row => ({ ...(row as object) }) as T)
}

describe('the owner readings of cost and ladder return what the SQL they replace returned', () => {
  const bus = fixtureBus()

  it('ended cards match ENDED_CARDS, a merge of a PR linked to its card only in prs included', () => {
    withBus(bus, (db) => {
      const ended = endedCards(db)
      expect(ended).toEqual(plain(db.prepare(ENDED_CARDS_SQL).all()))
      expect(ended.map(row => [row.card_id, row.end_type, row.ended])).toEqual([
        [7, PR_CLOSED, at(6)],
        [8, PR_CLOSED, at(4)],
        [9, CARD_CLOSED, at(5)],
        [10, CARD_CLOSED, at(7)],
        [12, CARD_CLOSED, at(1)],
        [14, PR_CLOSED, at(9)],
      ])
    })
  })

  it('construct cost times a card whose merged PR is linked only in prs', () => {
    expect(readBusTasks(bus).find(task => task.task === String(MERGED_THROUGH_PRS_ONLY))).toEqual({
      task: String(MERGED_THROUGH_PRS_ONLY),
      taskClass: 'implement/M',
      sessions: [{ id: 's7', project: expect.any(String) }, { id: 'a7', project: expect.any(String) }],
      minutes: 6,
    })
  })

  it('spend turns match SPEND_EVENTS and leave legacy turns out', () => {
    withBus(bus, (db) => {
      const turns = cardTurnsOf(db, [CARD_STARTED, CARD_ANSWERED])
      expect(turns).toEqual(plain(db.prepare(SPEND_EVENTS_SQL).all()))
      expect(turns.some(turn => turn.payload.includes('legacy7'))).toBe(false)
    })
  })

  it('ladder runs match LEDGER_EVENTS, legacy runs included', () => {
    withBus(bus, (db) => {
      const runs = ladderRunPayloads(db)
      expect(runs).toEqual((db.prepare(LEDGER_EVENTS_SQL).all(LADDER_RUN) as { payload: string }[]).map(row => row.payload))
      expect(runs.map(run => (JSON.parse(run) as { run: string }).run)).toEqual(['wf_live', 'wf_legacy', 'wf_other_card'])
    })
    expect(readLedger(path.dirname(bus), bus).entries.map(entry => entry.run)).toEqual(['wf_live', 'wf_legacy', 'wf_other_card'])
  })

  it('legacy lines match LEGACY_LINES and hold no live line', () => {
    withBus(bus, (db) => {
      const lines = legacyLinePayloads(db)
      expect(lines).toEqual((db.prepare(LEGACY_LINES_SQL).all() as { payload: string }[]).map(row => row.payload))
      expect(lines.some(line => line.includes('wf_live') || line.includes('"ghost":"live"'))).toBe(false)
    })
    expect(readLegacyLines<{ ghost?: string }>(bus).filter(line => line.ghost !== undefined)).toEqual([{ ghost: 'legacy' }])
  })

  it('ghost lines match GHOST_LINES', () => {
    const expected = withBus(bus, db => (db.prepare(GHOST_LINES_SQL).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as unknown))
    expect(ghostLines(bus)).toEqual(expected)
    expect(expected).toEqual([{ ghost: 'live' }])
  })

  it('the ladder mark and the last run of a card match LAST_EVENT_ID and LAST_RUN_OF_CARD', () => {
    const source = { kind: 'bus' as const, busPath: bus, card: LADDER_CARD, runsPath: path.join(path.dirname(bus), 'no-runs.jsonl') }
    const lastId = withBus(bus, db => Number((db.prepare(LAST_EVENT_ID_SQL).get() as { id: number }).id))
    expect(ladderRunMark(source)).toEqual({ event: lastId, line: 0 })
    const runs = withBus(bus, db => (db.prepare(LEDGER_EVENTS_SQL).all(LADDER_RUN) as { payload: string }[]).length)
    expect(runs).toBe(3)
    for (const after of [0, 1, lastId]) {
      const expected = withBus(bus, db => db.prepare(LAST_RUN_OF_CARD_SQL).get(LADDER_RUN, LADDER_CARD, after) as { payload: string } | undefined)
      const outcome = readLadderOutcome(source, { event: after, line: 0 })
      expect(outcome.run).toBe(expected === undefined ? null : (JSON.parse(expected.payload) as { run: string }).run)
    }
    expect(readLadderOutcome(source, { event: 0, line: 0 }).run).toBe('wf_legacy')
  })
})
