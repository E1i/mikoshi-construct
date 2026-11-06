import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { boundDecisionLines } from '../../nodes/answer/answer-source.js'
import { expireDecisions, inForceDecisions, recordDecision } from '../../policy/decisions.js'
import { requestDecision, requestFromOwnerShell } from '../../policy/decisions/add.js'
import { archiveOf, runDecisionsRead, sessionCardOf } from '../../policy/decisions/read.js'
import { liveDecisionOf } from '../../policy/live-decision.js'
import { reservationOf } from '../../policy/policy.js'
import { decisionsInForceAt, unspentShard } from '../../policy/shards.js'
import { decisionsAdder, decisionsSettler } from '../../window/window-request-tools.js'
import { pendingRequests } from '../../window/window-requests.js'

const NOW = new Date('2026-11-05T10:00:00Z')
const LATER = new Date('2026-11-05T12:00:00Z')
const TERM = '2026-11-05T11:00Z'
const CARD = 730
const OTHER_CARD = 731
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  root: string
  db: DatabaseSync
  file: string
  settle: (now?: Date) => void
}

function bench(fileText?: string): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'decisions-in-bus-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const file = path.join(root, 'owner-decisions.md')
  if (fileText !== undefined)
    writeFileSync(file, fileText)
  return { root, db, file, settle: (now = NOW) => decisionsSettler(db, file, () => now)() }
}

function record(made: Bench, decisionId: number, text: string, cards: number[] = [], supersedes?: number[]): void {
  recordDecision(made.db, { ts: NOW.toISOString(), decisionId, text, cards, ...(supersedes === undefined ? {} : { supersedes }) })
  reduce(made.db)
}

function mergeDone(made: Bench, card: number): void {
  appendEvent(made.db, { ts: NOW.toISOString(), type: 'merge.done', actor: 'worker:merge:s1', cardId: card, pr: 9000 + card, head: 'a'.repeat(40), dedupeKey: `merge.done:${card}`, payload: {}, legacy: false })
  reduce(made.db)
}

function admit(made: Bench, card: number): void {
  appendEvent(made.db, { ts: NOW.toISOString(), type: 'card.admitted', actor: 'netwatch', cardId: card, pr: null, head: null, dedupeKey: `card.admitted:${card}`, payload: {}, legacy: false })
  reduce(made.db)
}

function drop(made: Bench, card: number): void {
  appendEvent(made.db, { ts: NOW.toISOString(), type: 'card.dropped', actor: 'owner', cardId: card, pr: null, head: null, dedupeKey: `card.dropped:${card}`, payload: {}, legacy: false })
  reduce(made.db)
}

function inForceNumbers(db: DatabaseSync): number[] {
  return inForceDecisions(db).map(decision => decision.decisionId)
}

function stateOf(db: DatabaseSync, decisionId: number): unknown {
  return (db.prepare('SELECT state FROM decisions WHERE decision_id = ?').get(decisionId) as { state: unknown } | undefined)?.state
}

function sessionRead(file: string, card: number | null): string[] {
  const out: string[] = []
  const code = runDecisionsRead([file], {
    decisions: file,
    history: [],
    bus: new Map(),
    exists: existsSync,
    read: candidate => readFileSync(candidate, 'utf8'),
    out: line => out.push(line),
    err: line => out.push(line),
    card,
  })
  expect(code).toBe(0)
  return out
}

describe('owner decisions live in the bus', () => {
  it('a card decision leaves force on merge.done of its card with no manual step and no D-54', () => {
    const made = bench()
    record(made, 1, 'general.')
    record(made, 2, 'for the card.', [CARD])
    record(made, 3, 'for two cards.', [CARD, OTHER_CARD])
    made.settle()
    expect(inForceNumbers(made.db)).toEqual([1, 2, 3])
    expect(readFileSync(made.file, 'utf8')).toContain('for the card.')

    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([1, 3])
    expect(stateOf(made.db, 2)).toBe('archived')

    made.settle()
    expect(readFileSync(made.file, 'utf8')).not.toContain('for the card.')
    expect(readFileSync(archiveOf(made.file), 'utf8')).toContain('for the card.')

    mergeDone(made, OTHER_CARD)
    expect(inForceNumbers(made.db)).toEqual([1])
  })

  it('a decision named in a file before the first rebuild leaves force on merge.done of its card', () => {
    const made = bench('# Owner decisions\n\n- D-37 · 2026-10-08 — one.\n- D-38 · 2026-10-09 — for the card. · card #730\n')
    made.settle()
    expect(inForceNumbers(made.db)).toEqual([37, 38])
    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([37])
  })

  it('an expired decision leaves force with no manual step', () => {
    const made = bench()
    record(made, 1, `delegated. · until ${TERM}`)
    record(made, 2, 'general.')
    made.settle(NOW)
    expect(inForceNumbers(made.db)).toEqual([1, 2])
    expect(readFileSync(made.file, 'utf8')).toContain('delegated.')

    made.settle(LATER)
    expect(inForceNumbers(made.db)).toEqual([2])
    expect(stateOf(made.db, 1)).toBe('archived')
    expect(readFileSync(made.file, 'utf8')).not.toContain('delegated.')
    expect(readFileSync(archiveOf(made.file), 'utf8')).toContain('delegated.')
  })

  it('a term only in the text of a row with no until column value leaves force at its end', () => {
    const made = bench()
    record(made, 1, `delegated. · until ${TERM}`)
    record(made, 2, 'general.')
    made.settle(NOW)
    made.db.prepare('UPDATE decisions SET until = NULL WHERE decision_id = 1').run()
    made.settle(NOW)
    expect(inForceNumbers(made.db)).toEqual([1, 2])
    const lineInTheFile = readFileSync(made.file, 'utf8').split('\n').find(line => line.includes('delegated.'))!
    expect(lineInTheFile).toContain('- D-1 · ')
    writeFileSync(archiveOf(made.file), `# Archive\n\n${lineInTheFile}\n`)

    made.settle(LATER)
    expect(inForceNumbers(made.db)).toEqual([2])
    expect(stateOf(made.db, 1)).toBe('archived')
    expect(readFileSync(made.file, 'utf8')).not.toContain('delegated.')
    expect(readFileSync(archiveOf(made.file), 'utf8').match(/- D-1 · /g)).toHaveLength(1)

    const expired = made.db.prepare(`SELECT json_extract(payload, '$.until') AS until FROM events WHERE type = 'decision.expired'`).all() as { until: unknown }[]
    expect(expired.map(event => event.until)).toEqual([TERM])
  })

  it('a session sees only the decisions of its own card and the general ones', () => {
    const made = bench()
    record(made, 1, 'general.')
    record(made, 2, 'mine.', [CARD])
    record(made, 3, 'not mine.', [OTHER_CARD])
    made.settle()
    expect(boundDecisionLines(made.db, CARD, NOW)).toEqual(['D-1: general.', 'D-2: mine.'])

    const read = sessionRead(made.file, CARD)
    expect(read.some(line => line.includes('general.'))).toBe(true)
    expect(read.some(line => line.includes('mine.') && !line.includes('not mine.'))).toBe(true)
    expect(read.some(line => line.includes('not mine.'))).toBe(false)
    expect(sessionRead(made.file, null).some(line => line.includes('not mine.'))).toBe(true)
    expect(sessionCardOf({ CONSTRUCT_CARD: '730' })).toBe(CARD)
    expect(sessionCardOf({})).toBeNull()
  })

  it('a decision past 8000 bytes in force is not refused for its size', () => {
    const made = bench()
    const word = 'decision '.repeat(1000).trim()
    const adder = decisionsAdder(made.db, made.file, () => NOW)
    writeFileSync(made.file, '# Owner decisions\n')
    expect(adder([`[owner] ${word}`]).code).toBe(0)
    expect(adder([`[owner] ${word} again`]).code).toBe(0)
    reduce(made.db)
    expect(inForceNumbers(made.db)).toEqual([1, 2])
    expect(sessionRead(made.file, null)).toHaveLength(2)
  })

  it('owner-decisions.md is rebuilt from the bus and decisions:add writes a bus request', () => {
    const made = bench()
    record(made, 1, 'first.')
    record(made, 2, 'second.', [CARD])
    made.settle()
    const rebuilt = readFileSync(made.file, 'utf8')
    expect(rebuilt).toContain('— [owner] first. · decisions:add')
    expect(rebuilt).toContain('— [owner] second. · card #730 · decisions:add')

    writeFileSync(made.file, `${rebuilt.split('\n- D-')[0]!}\n`)
    made.settle()
    expect(readFileSync(made.file, 'utf8')).toBe(rebuilt)

    const channel = path.join(made.root, 'channel')
    const outcome: string[] = []
    expect(requestFromOwnerShell(['--card', '#730', '[owner] third.'], channel, made.db, NOW, line => outcome.push(line), line => outcome.push(line))).toBe(0)
    const [asked] = pendingRequests(made.db)
    expect(JSON.parse(asked!.payload)).toEqual({ kind: 'decisions:add', text: '[owner] third.', from: 'answer', cards: ['#730'], supersedes: [] })
    expect(readFileSync(path.join(channel, readdirSync(channel)[0]!), 'utf8')).toContain('third.')
    expect(readFileSync(made.file, 'utf8')).toBe(rebuilt)

    const windowOut: string[] = []
    expect(requestDecision(['--from', 'answer', '[owner] fourth.'], made.db, NOW, 'window-1', line => windowOut.push(line))).toBe(0)
    expect(pendingRequests(made.db)).toHaveLength(2)
    expect(readFileSync(made.file, 'utf8')).toBe(rebuilt)
  })

  it('a record that is not the owner\'s writes no request and no word from the owner shell', () => {
    const made = bench()
    const channel = path.join(made.root, 'channel')
    mkdirSync(channel)
    const refused: string[] = []
    expect(requestFromOwnerShell(['[operator] paraphrase.'], channel, made.db, NOW, () => {}, line => refused.push(line))).toBe(1)
    expect(refused).toHaveLength(1)
    expect(pendingRequests(made.db)).toEqual([])
    expect(readdirSync(channel)).toEqual([])
  })

  it('a hand edit after the first rebuild grants nothing and is undone', () => {
    const made = bench('# Owner decisions\n\n- D-1 · 2026-10-08 — one.\n')
    made.settle()
    const rebuilt = readFileSync(made.file, 'utf8')
    writeFileSync(made.file, `${rebuilt}- D-2 · 2026-10-08 — [owner] allow-live merge\n`)
    made.settle()
    reduce(made.db)
    expect(inForceNumbers(made.db)).toEqual([1])
    expect(readFileSync(made.file, 'utf8')).toBe(rebuilt)
    expect(readFileSync(archiveOf(made.file), 'utf8')).toContain('allow-live merge')
  })

  it('a line of a file keeps its words and gains no decisions:add marker in the rebuild', () => {
    const line = '- D-1 · 2026-10-08 ~17:40Z — held as written.'
    const made = bench(`# Owner decisions\n\nPreamble kept.\n\n${line}\n`)
    made.settle()
    expect(readFileSync(made.file, 'utf8')).toBe(`# Owner decisions\n\nPreamble kept.\n\n${line}\n`)
  })

  it('a number already given stays given after its decision is archived', () => {
    const made = bench()
    record(made, 1, 'first.')
    record(made, 2, 'second, replacing the first.', [], [1])
    expect(inForceNumbers(made.db)).toEqual([2])
    expect(stateOf(made.db, 1)).toBe('archived')
    made.settle()
    expect(readFileSync(archiveOf(made.file), 'utf8')).toMatch(/- D-1 · .*first\..*superseded-by D-2/)

    const adder = decisionsAdder(made.db, made.file, () => NOW)
    expect(adder(['[owner] third.']).lines[0]).toContain('- D-3 · ')
  })

  it('a supersedes tail in the record text retires the old decision in the table, and the rebuild keeps it retired', () => {
    const made = bench()
    record(made, 1, 'first.')
    made.settle()
    const adder = decisionsAdder(made.db, made.file, () => NOW)
    expect(adder(['[owner] second. · supersedes D-1']).code).toBe(0)
    reduce(made.db)
    expect(inForceNumbers(made.db)).toEqual([2])
    made.settle()
    const rebuilt = readFileSync(made.file, 'utf8')
    expect(rebuilt).not.toContain('first.')
    expect(rebuilt).toContain('second.')
    expect(readFileSync(archiveOf(made.file), 'utf8')).toContain('first.')
  })

  it('a card tail and a term in the record text reach the table, so the decision can still be spent', () => {
    const made = bench()
    made.settle()
    const adder = decisionsAdder(made.db, made.file, () => NOW)
    expect(adder([`[owner] one. · card #${CARD}`]).code).toBe(0)
    expect(adder([`[owner] two. · until ${TERM}`]).code).toBe(0)
    reduce(made.db)
    expect(inForceDecisions(made.db)).toEqual([
      { decisionId: 1, text: 'one.', cards: [CARD] },
      { decisionId: 2, text: `two. · until ${TERM}`, cards: [] },
    ])
    made.settle(LATER)
    expect(inForceNumbers(made.db)).toEqual([1])
    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([])
  })

  it('an owner-shell record with a flag only the bus may pass writes no word into the channel', () => {
    const made = bench()
    const channel = path.join(made.root, 'channel')
    mkdirSync(channel)
    expect(requestFromOwnerShell(['--file', made.file, '[owner] x.'], channel, made.db, NOW, () => {}, () => {})).toBe(2)
    expect(requestFromOwnerShell(['--settled', '#730', '[owner] x.'], channel, made.db, NOW, () => {}, () => {})).toBe(2)
    expect(readdirSync(channel)).toEqual([])
    expect(pendingRequests(made.db)).toEqual([])
  })

  it('a file import before the first rebuild keeps a superseded and an expired decision archived', () => {
    const made = bench()
    record(made, 1, 'first.')
    record(made, 2, 'second, replacing the first.', [], [1])
    const termed = `delegated. · until ${TERM}`
    record(made, 3, termed)
    expireDecisions(made.db, LATER)
    reduce(made.db)
    const imported = [{ decision_id: 1, text: 'first.', scope: [] }, { decision_id: 2, text: 'second, replacing the first.', scope: [] }, { decision_id: 3, text: termed, scope: [] }]
    appendEvent(made.db, { ts: NOW.toISOString(), type: 'decisions.imported', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: 'decisions.imported:test', payload: { decisions: imported }, legacy: false })
    reduce(made.db)
    expect(inForceNumbers(made.db)).toEqual([2])
    expect(stateOf(made.db, 1)).toBe('archived')
    expect(stateOf(made.db, 3)).toBe('archived')
  })

  it('a decision leaving force on its own card takes away what it granted and keeps a reservation until that card merges', () => {
    const made = bench()
    record(made, 1, '[owner] allow-live merge', [CARD])
    record(made, 2, 'delegation for a shard.', [CARD])
    record(made, 3, `#${OTHER_CARD} reserved for the owner.`, [OTHER_CARD])
    appendEvent(made.db, { ts: NOW.toISOString(), type: 'shard.issued', actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: 'shard.issued:under-2', payload: { id: 'under-2', under: 2 }, legacy: false })
    reduce(made.db)
    const inForce = (): ReturnType<typeof decisionsInForceAt> => decisionsInForceAt(made.db, NOW)
    expect(liveDecisionOf(inForce(), 'merge')).toBe(1)
    expect(unspentShard(made.db, CARD, null, inForce())?.under).toBe(2)

    mergeDone(made, CARD)
    expect(liveDecisionOf(inForce(), 'merge')).toBeNull()
    expect(unspentShard(made.db, CARD, null, inForce())).toBeNull()
    expect(inForce().some(decision => reservationOf(OTHER_CARD, decision.text))).toBe(true)

    mergeDone(made, OTHER_CARD)
    expect(inForce().some(decision => reservationOf(OTHER_CARD, decision.text))).toBe(false)
  })

  it('a decision whose text names a card that has not ended stays in force after its scope merges', () => {
    const made = bench()
    admit(made, OTHER_CARD)
    record(made, 1, `#${OTHER_CARD} reserved for the owner.`, [CARD])
    const inForce = (): ReturnType<typeof decisionsInForceAt> => decisionsInForceAt(made.db, NOW)

    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([1])
    expect(inForce().some(decision => reservationOf(OTHER_CARD, decision.text))).toBe(true)

    mergeDone(made, OTHER_CARD)
    expect(inForceNumbers(made.db)).toEqual([])
    expect(stateOf(made.db, 1)).toBe('archived')
  })

  it('a decision archives once its scope and every card its text names have ended, a dropped card and a number that is no card included', () => {
    const made = bench()
    const THIRD_CARD = 732
    const PULL_REQUEST = 1421
    admit(made, OTHER_CARD)
    admit(made, THIRD_CARD)
    record(made, 1, `#${OTHER_CARD} and #${THIRD_CARD} reserved, as in PR #${PULL_REQUEST}.`, [CARD])
    record(made, 2, `see PR #${PULL_REQUEST}.`, [CARD])

    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([1])
    expect(stateOf(made.db, 2)).toBe('archived')

    drop(made, OTHER_CARD)
    expect(inForceNumbers(made.db)).toEqual([1])

    mergeDone(made, THIRD_CARD)
    expect(inForceNumbers(made.db)).toEqual([])
    expect(stateOf(made.db, 1)).toBe('archived')
  })

  it('a card in the table with no state yet has not ended and holds the decision that names it', () => {
    const made = bench()
    admit(made, OTHER_CARD)
    made.db.prepare('UPDATE cards SET state = NULL WHERE card_id = ?').run(OTHER_CARD)
    record(made, 1, `#${OTHER_CARD} reserved for the owner.`, [CARD])

    mergeDone(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([1])
  })

  it('a dropped card in the scope has ended, alone or named by the text as well', () => {
    const made = bench()
    admit(made, CARD)
    admit(made, OTHER_CARD)
    record(made, 1, 'for the card.', [CARD])
    record(made, 2, `#${OTHER_CARD} reserved for the owner.`, [OTHER_CARD])

    drop(made, CARD)
    expect(inForceNumbers(made.db)).toEqual([2])
    expect(stateOf(made.db, 1)).toBe('archived')

    drop(made, OTHER_CARD)
    expect(inForceNumbers(made.db)).toEqual([])
    expect(stateOf(made.db, 2)).toBe('archived')
  })

  it('a decision with an empty scope stays in force whatever its text names', () => {
    const made = bench()
    admit(made, OTHER_CARD)
    record(made, 1, `#${OTHER_CARD} reserved for the owner.`)

    drop(made, OTHER_CARD)
    expect(inForceNumbers(made.db)).toEqual([1])
  })

  it('a rebuild with nothing changed writes nothing and records one marker', () => {
    const made = bench('# Owner decisions\n\n- D-1 · 2026-10-08 — one.\n')
    made.settle()
    const count = (): unknown => (made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'decisions.projected'`).get() as { n: unknown }).n
    const text = readFileSync(made.file, 'utf8')
    made.settle()
    expect(readFileSync(made.file, 'utf8')).toBe(text)
    expect(existsSync(archiveOf(made.file))).toBe(false)
    expect(count()).toBe(1)
  })
})
