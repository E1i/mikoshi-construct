import type { BusEvent } from '../../bus/db.js'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { decisionsIntake } from '../../bus/decisions-import.js'
import { recordDecision } from '../../bus/decisions.js'
import { projectionDump, reduce, REJECTED } from '../../bus/reducer.js'
import { runDecisionsAdd } from '../../decisions/add.js'

const FILE = '/d/owner-decisions.md'
const ARCHIVE = '/d/owner-decisions.archive.md'
const NOW = new Date('2026-10-10T08:30:00Z')
const TS = '2026-10-10T08:00:00.000Z'
const BEFORE = '# Owner decisions\n\n- D-1 · 2026-10-08 — one.\n'
const OWNER_FILE = [
  '# Owner decisions',
  '',
  'Append-only.',
  '',
  '- D-1 · 2026-10-08 — one. · superseded-by D-2',
  '- D-2 · 2026-10-08 — #807 stays owner-merged. · card #807 · decisions:add',
  'a line out of format',
  '- D-77 · 2026-10-10 ~13:35Z — Owner-PR мержится шиной по pass ревью воркера и зелёному CI.',
  '',
].join('\n')
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-decisions-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function event(type: string, fields: Partial<BusEvent>): BusEvent {
  sequence += 1
  return { ts: TS, type, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${type}:test-${sequence}`, payload: {}, legacy: false, ...fields }
}

function stopped(cardId: number, reason: string): BusEvent {
  return event('card.stopped', { actor: 'worker:answer:s1', cardId, payload: { reason, detail: `card ${cardId} stopped on ${reason}` } })
}

function recorded(decisionId: number, scope: number[], actor = 'owner'): BusEvent {
  return event('decision.recorded', { actor, payload: { decision_id: decisionId, text: `decision ${decisionId}`, scope, source: 'owner' } })
}

function add(db: ReturnType<typeof openBus>, files: Record<string, string>, args: string[]): { code: number, err: string[], files: Record<string, string> } {
  const state = { ...files }
  const err: string[] = []
  const code = runDecisionsAdd(['--file', FILE, ...args], {
    home: '/home/x',
    now: () => NOW,
    exists: file => file in state,
    read: file => state[file]!,
    write: (file, text) => {
      state[file] = text
    },
    remove: (file) => {
      delete state[file]
    },
    record: decision => recordDecision(db, decision),
    out: () => {},
    err: line => err.push(line),
  })
  return { code, err, files: state }
}

function rows(db: ReturnType<typeof openBus>, query: string): Record<string, unknown>[] {
  return db.prepare(query).all() as Record<string, unknown>[]
}

describe('owner decisions on the bus', () => {
  it('decisions:add records decision.recorded and the reducer projects it into decisions', () => {
    const db = newBus()
    const result = add(db, { [FILE]: BEFORE }, ['--card', '#807', '[owner] #807 stays owner-merged.'])
    expect(result).toMatchObject({ code: 0, err: [] })
    expect(rows(db, `SELECT type, actor, card_id, dedupe_key, payload FROM events`)).toEqual([{
      type: 'decision.recorded',
      actor: 'owner',
      card_id: null,
      dedupe_key: 'decision.recorded:2',
      payload: JSON.stringify({ decision_id: 2, text: '#807 stays owner-merged.', scope: [807], source: 'owner' }),
    }])
    expect(rows(db, 'SELECT * FROM decisions')).toEqual([])
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(rows(db, 'SELECT * FROM decisions')).toEqual([{ decision_id: 2, text: '#807 stays owner-merged.', scope: '[807]', source: 'owner', event_id: 1 }])
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(rows(db, 'SELECT decision_id FROM decisions')).toEqual([{ decision_id: 2 }])
  })

  it('a decision.recorded whose actor is not owner is rejected', () => {
    const db = newBus()
    for (const actor of ['policy', 'worker:answer:s1'])
      appendEvent(db, recorded(1, [807], actor))
    appendEvent(db, event('decision.recorded', { payload: { decision_id: 2, text: 'two', scope: [], source: 'operator' } }))
    expect(reduce(db)).toEqual({ applied: 0, rejected: 3 })
    expect(rows(db, 'SELECT * FROM decisions')).toEqual([])
    expect(rows(db, `SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = '${REJECTED}' ORDER BY id`).map(row => row.reason)).toEqual([
      'decision.recorded is the owner\'s, not policy\'s',
      'decision.recorded is the owner\'s, not worker:answer:s1\'s',
      'source is not owner',
    ])
  })

  it('a failed event write restores owner-decisions.md', () => {
    const db = newBus()
    recordDecision(db, { ts: TS, decisionId: 3, text: 'already on the bus', cards: [] })
    const before = { [FILE]: '# Owner decisions\n\n- D-1 · 2026-10-08 — one.\n- D-2 · 2026-10-08 — two.\n' }
    const taken = add(db, before, ['--supersedes', 'D-1', '[owner] three.'])
    expect(taken.code).toBe(1)
    expect(taken.files).toEqual(before)
    expect(taken.err).toEqual([`[decisions] D-3 not recorded in the bus: decision.recorded:3 is already in the bus; ${FILE} restored as it was`])
    const archived = { ...before, [ARCHIVE]: '# Owner decisions archive\n\n' }
    db.close()
    const closed = add(db, archived, ['--supersedes', 'D-1', '[owner] three.'])
    expect(closed.code).toBe(1)
    expect(closed.files).toEqual(archived)
    expect(closed.err[0]).toMatch(/^\[decisions\] D-3 not recorded in the bus: .+; \/d\/owner-decisions\.md restored as it was$/)
  })

  it('the decisions table equals owner-decisions.md and a replay gives the same', () => {
    const db = newBus()
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'bus-owner-decisions-')), 'owner-decisions.md')
    roots.push(path.dirname(file))
    writeFileSync(file, OWNER_FILE)
    decisionsIntake(db, file, () => NOW)()
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(rows(db, 'SELECT decision_id, text, scope, source FROM decisions ORDER BY decision_id')).toEqual([
      { decision_id: 2, text: '#807 stays owner-merged.', scope: '[807]', source: 'owner-decisions.md' },
      { decision_id: 77, text: 'Owner-PR мержится шиной по pass ревью воркера и зелёному CI.', scope: '[]', source: 'owner-decisions.md' },
    ])
    const projection = projectionDump(db)
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(projectionDump(db)).toBe(projection)
  })

  it('a change of owner-decisions.md is imported without writing the file', () => {
    const db = newBus()
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'bus-owner-decisions-')), 'owner-decisions.md')
    roots.push(path.dirname(file))
    writeFileSync(file, OWNER_FILE)
    let now = NOW
    const intake = decisionsIntake(db, file, () => now)
    intake()
    now = new Date(NOW.getTime() + 60_000)
    intake()
    appendEvent(db, stopped(809, 'question.owner'))
    expect(rows(db, `SELECT count(*) AS n FROM events WHERE type = 'decisions.imported'`)).toEqual([{ n: 1 }])
    reduce(db)
    const [firstImport] = rows(db, `SELECT id FROM events WHERE type = 'decisions.imported'`)
    const before = statSync(file).mtimeMs

    const changed = OWNER_FILE.replace('· decisions:add', '· decisions:add · superseded-by D-78').concat('- D-78 · 2026-10-10 — #809 goes to the bus. · card #809\n')
    writeFileSync(file, changed)
    const written = statSync(file).mtimeMs
    intake()
    expect(rows(db, `SELECT count(*) AS n FROM events WHERE type = 'decisions.imported'`)).toEqual([{ n: 2 }])
    expect(reduce(db)).toEqual({ applied: 3, rejected: 0 })
    expect(rows(db, 'SELECT decision_id, scope FROM decisions ORDER BY decision_id')).toEqual([{ decision_id: 77, scope: '[]' }, { decision_id: 78, scope: '[809]' }])
    expect(rows(db, 'SELECT event_id FROM decisions WHERE decision_id = 77')).toEqual([{ event_id: firstImport!.id }])
    expect(rows(db, 'SELECT card_id, state FROM cards')).toEqual([{ card_id: 809, state: 'queued' }])
    expect(readFileSync(file, 'utf8')).toBe(changed)
    expect(statSync(file).mtimeMs).toBe(written)
    expect(written).toBeGreaterThanOrEqual(before)
  })

  it('decisions.imported is netwatch\'s and lists each decision once', () => {
    const db = newBus()
    appendEvent(db, event('decisions.imported', { actor: 'owner', payload: { decisions: [] } }))
    appendEvent(db, event('decisions.imported', { actor: 'netwatch', payload: { decisions: [{ decision_id: 1, text: 'a', scope: [] }, { decision_id: 1, text: 'b', scope: [] }] } }))
    expect(reduce(db)).toEqual({ applied: 0, rejected: 2 })
    expect(rows(db, `SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = '${REJECTED}' ORDER BY id`).map(row => row.reason)).toEqual([
      'decisions.imported is netwatch\'s, not owner\'s',
      'a decision_id is listed twice',
    ])
  })

  it('a decision naming a card stopped on question.owner returns it to queued', () => {
    const db = newBus()
    appendEvent(db, recorded(1, [810]))
    appendEvent(db, stopped(807, 'question.owner'))
    appendEvent(db, stopped(808, 'fault'))
    appendEvent(db, stopped(809, 'question.owner'))
    appendEvent(db, stopped(810, 'question.owner'))
    appendEvent(db, recorded(2, [807, 808, 811], 'policy'))
    appendEvent(db, recorded(3, [807, 808, 811]))
    expect(reduce(db)).toEqual({ applied: 6, rejected: 1 })
    expect(rows(db, 'SELECT card_id, state FROM cards ORDER BY card_id')).toEqual([
      { card_id: 807, state: 'queued' },
      { card_id: 808, state: 'stopped' },
      { card_id: 809, state: 'stopped' },
      { card_id: 810, state: 'stopped' },
    ])
  })
})
