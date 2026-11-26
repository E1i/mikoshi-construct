import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { BusSeed, SeedEvent } from '../../../../tests/board/bus-fixture.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { openDrains } from '../../../../src/commands/board/drain.js'
import { lastHeal } from '../../../../src/commands/board/heal.js'
import { busFacts } from '../../../../src/commands/board/index.js'
import { subagent, writeBus } from '../../../../tests/board/bus-fixture.js'
import { stalePassCountOf, stallLines } from '../../../cli/board-warnings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { lastObjectFieldPerCard, newestEventsOfEachCard } from '../../../core/events-query.js'
import { BUS_HEAL_HELD, BUS_HEALED, CARD_ADMITTED, LEASES_DRAINING, RESTARTED, REVIEW_RECORDED, SLICE_PARENTS_BACKFILLED, WINDOW_HEARTBEAT } from '../../../core/events.js'
import { leaseQueued } from '../../../core/lease.js'
import { keyOf, queueTask } from '../../../core/queue.js'
import { inStates } from '../../../core/tasks-query.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const READERS = [
  'src/commands/board/bus.ts',
  'src/commands/board/bus-panel.ts',
  'src/commands/board/drain.ts',
  'src/commands/board/heal.ts',
  'scripts/cli/board-warnings.ts',
  'scripts/cli/board-page.ts',
]

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, READERS[0]!)) as { languageOptions: { parser: Linter.Parser } }
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: config.languageOptions.parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } },
      ...FOREIGN_TABLE_SQL_POLICY.map(block => ({ ...block, ignores: (block.ignores ?? []).filter(ignored => !EXCEPTED.includes(ignored)) })),
    ],
  })
}

async function foreignTablesOf(files: readonly string[]): Promise<Record<string, string[]>> {
  const results = await (await ruleWithoutExceptions()).lintFiles([...files])
  return Object.fromEntries(results.map(result => [
    path.relative(REPO_ROOT, result.filePath),
    result.messages.filter(message => message.ruleId === RULE).map(message => `${NAMED_TABLE.exec(message.message)?.[1] ?? message.message}:${message.line}`),
  ]))
}

describe('the board reads the tables of other owners only through their contracts', () => {
  it('each file belongs to the board and none stays on the excepted list', () => {
    for (const file of READERS)
      expect(MODULE_FILES.board).toContain(file)
    expect(EXCEPTED.filter(file => READERS.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in any of them', async () => {
    expect(await foreignTablesOf(READERS)).toEqual(Object.fromEntries(READERS.map(file => [file, []])))
  }, LINT_MS)
})

describe('the readings the board now takes from the owners keep their filters', () => {
  const TS = '2026-11-20T10:00:00.000Z'
  const ACTOR = 'worker:test:1'
  const CARD = 4242
  const HEAD = 'a'.repeat(40)

  function event(db: DatabaseSync, type: string, key: string, fields: { cardId?: number | null, pr?: number | null, ts?: string, legacy?: boolean, payload?: object } = {}): void {
    appendEvent(db, { ts: fields.ts ?? TS, type, actor: ACTOR, cardId: fields.cardId ?? null, pr: fields.pr ?? null, head: null, dedupeKey: key, payload: fields.payload ?? {}, legacy: fields.legacy ?? false })
  }

  it('a drain shows only the newest one of each node since the last restart, still open', () => {
    const db = openBus(':memory:')
    event(db, LEASES_DRAINING, 'drain:old', { payload: { node: 'merge', sha: 'old', until: '2026-11-20T11:00:00.000Z' } })
    event(db, RESTARTED, 'restart', { legacy: true })
    event(db, LEASES_DRAINING, 'drain:review:1', { payload: { node: 'review', sha: 'r1', until: '2026-11-20T11:00:00.000Z' } })
    event(db, LEASES_DRAINING, 'drain:review:2', { payload: { node: 'review', sha: 'r2', from: 'r1', until: '2026-11-20T11:00:00.000Z' } })
    event(db, LEASES_DRAINING, 'drain:answer', { payload: { node: 'answer', sha: 'a1', until: '2026-11-20T09:00:00.000Z' } })
    event(db, LEASES_DRAINING, 'drain:launch', { payload: { node: 'launch', sha: 'l1', until: '2026-11-20T11:00:00.000Z' } })
    expect(openDrains(db, new Date(TS))).toEqual([
      { node: 'launch', sha: 'l1', from: null, until: '2026-11-20T11:00:00.000Z' },
      { node: 'review', sha: 'r2', from: 'r1', until: '2026-11-20T11:00:00.000Z' },
    ])
    db.close()
  })

  it('the last heal is the newest of either kind, a held one shown at any age', () => {
    const db = openBus(':memory:')
    expect(lastHeal(db, new Date(TS))).toBeNull()
    event(db, BUS_HEALED, 'healed', { ts: '2026-11-18T10:00:00.000Z', payload: { backup: 'b', broken: [1], steps: ['a', 'b'] } })
    expect(lastHeal(db, new Date(TS))).toBeNull()
    event(db, BUS_HEAL_HELD, 'held', { ts: '2026-11-18T11:00:00.000Z', legacy: true, payload: { failure: 'no space' } })
    expect(lastHeal(db, new Date(TS))).toEqual({ kind: 'held', at: '2026-11-18T11:00:00.000Z', backup: null, done: 'no space' })
    db.close()
  })

  it('open tasks are the queued and leased ones, in the order they were queued', () => {
    const db = openBus(':memory:')
    const first = { queue: 'review' as const, cardId: CARD, pr: 31, head: HEAD }
    const second = { queue: 'close' as const, cardId: CARD + 1 }
    queueTask(db, TS, first)
    queueTask(db, TS, second)
    leaseQueued(db, TS, keyOf(first), 'worker:review:1')
    expect(inStates(db, ['queued', 'leased']).map(task => [task.card_id, task.state])).toEqual([[CARD, 'leased'], [CARD + 1, 'queued']])
    expect(inStates(db, ['leased']).map(task => task.card_id)).toEqual([CARD])
    expect(inStates(db, [])).toEqual([])
    db.close()
  })

  it('the newest events of each card are taken per card, oldest first', () => {
    const db = openBus(':memory:')
    for (const at of [1, 2, 3])
      event(db, REVIEW_RECORDED, `review:${at}`, { cardId: CARD, pr: at })
    event(db, REVIEW_RECORDED, 'review:other', { cardId: CARD + 1, pr: 9 })
    event(db, REVIEW_RECORDED, 'review:none', { pr: 10 })
    expect(newestEventsOfEachCard(db, 2).map(row => [row.card, row.pr])).toEqual([[CARD, 2], [CARD, 3], [CARD + 1, 9]])
    db.close()
  })

  it('a slice parent is the newest admitted one that is an object', () => {
    const db = openBus(':memory:')
    event(db, CARD_ADMITTED, 'admitted:1', { cardId: CARD, payload: { parent: { card: 1, part: 1, of: 2 } } })
    event(db, CARD_ADMITTED, 'admitted:2', { cardId: CARD, payload: { parent: 'not an object' } })
    event(db, CARD_ADMITTED, 'admitted:legacy', { cardId: CARD + 1, legacy: true, payload: { parent: { card: 2, part: 1, of: 2 } } })
    expect(Object.fromEntries(lastObjectFieldPerCard(db, CARD_ADMITTED, 'parent'))).toEqual({ [CARD]: JSON.stringify({ card: 1, part: 1, of: 2 }) })
    db.close()
  })

  it('no open pass and no card in flight reads as nothing, not as a failure', () => {
    const db = openBus(':memory:')
    expect(stalePassCountOf(db)).toBe(0)
    expect(stallLines(db, null, new Date(TS))).toEqual([])
    db.close()
  })
})

describe('the board keeps the journal and the order of the SQL each reading replaced', () => {
  const NOW = new Date('2026-11-20T10:00:00.000Z')
  const CARD = 4343
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString()
  }

  function readSeeded<T>(seed: BusSeed, read: (db: DatabaseSync) => T): T {
    const root = mkdtempSync(path.join(tmpdir(), 'owner-reads-board-'))
    roots.push(root)
    const db = new SqliteDatabase(writeBus(path.join(root, 'bus.db'), seed), { readOnly: true })
    try {
      return read(db)
    }
    finally {
      db.close()
    }
  }

  function windowAgents(seed: BusSeed): string[] {
    return readSeeded(seed, db => busFacts(db, NOW)).services.filter(service => service.role === 'window').flatMap(service => (service.subagents ?? []).map(agent => agent.name))
  }

  function windowBeat(minutes: number, agent: string, legacy: boolean): SeedEvent {
    return { ts: minutesAgo(minutes), type: WINDOW_HEARTBEAT, card: null, legacy, payload: JSON.stringify({ session: `w-${agent}`, subagents: [{ name: agent, context: 1, spent: 1, at: minutesAgo(minutes) }] }) }
  }

  it('a card in flight whose own state event is its last one stalls from that event', () => {
    const since = minutesAgo(30)
    const lines = readSeeded({ cards: [{ id: CARD, state: 'running', lane: null, line: `#${CARD} in flight`, since }] }, db => stallLines(db, minutesAgo(1), NOW))
    expect(lines).toEqual([`stall card ${CARD}: no new event for 30 minutes since card.state at ${since}, while the bus is alive`])
  })

  it('a window subagent written to the legacy journal still reads as running', () => {
    expect(windowAgents({ events: [{ ...subagent(minutesAgo(1), { role: 'scan', phase: 'started', session: 'w-1' }), legacy: true }] })).toEqual(['scan'])
  })

  it('the window beat is the newest one of the live journal, never a legacy one', () => {
    expect(windowAgents({ events: [windowBeat(2, 'live', false), windowBeat(1, 'legacy', true)] })).toEqual(['live'])
  })

  it('a slice parent backfilled twice keeps the first transfer', () => {
    const backfill = (parent: number): SeedEvent => ({ ts: minutesAgo(5), type: SLICE_PARENTS_BACKFILLED, card: null, payload: JSON.stringify({ cards: { [CARD]: { card: parent, part: 1, of: 2 } }, unread: [] }) })
    const seed: BusSeed = { cards: [{ id: CARD, state: 'running', lane: 'lane-1', line: `#${CARD} slice`, since: minutesAgo(10) }], events: [backfill(1), backfill(2)] }
    expect(readSeeded(seed, db => busFacts(db, NOW)).cards.find(card => card.id === CARD)?.parent).toEqual({ card: 1, part: 1, of: 2 })
  })
})
