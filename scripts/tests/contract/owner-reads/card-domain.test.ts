import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { CARD_STOPPED } from '../../../core/events.js'
import * as prs from '../../../core/pr-readings.js'
import * as tasks from '../../../core/tasks-query.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const CARD_DOMAIN_FILES = ['scripts/core/card-automaton.ts', 'scripts/core/card-hold.ts', 'scripts/supervisor/card-waits.ts']

const CARD = 7301
const OTHER_CARD = 7302
const HEAD = 'b'.repeat(40)

let db: DatabaseSync | null = null

afterEach(() => {
  db?.close()
  db = null
})

function anEvent(bus: DatabaseSync, cardId: number, n: number): number {
  appendEvent(bus, { ts: `2026-11-21T10:00:${String(n).padStart(2, '0')}.000Z`, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}:${n}`, payload: { reason: 'test' }, legacy: false })
  return Number((bus.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function aTask(bus: DatabaseSync, row: { key: string, queue: string, card: number, state: string, gen: number, event: number }): void {
  bus.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, lease_gen, event_id) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)').run(row.key, row.queue, row.card, row.state, row.gen, row.event)
}

function aPr(bus: DatabaseSync, pr: number, card: number | null, state: string, event: number): void {
  bus.prepare('INSERT INTO prs (pr, card_id, base, head, state, event_id) VALUES (?, ?, \'main\', ?, ?, ?)').run(pr, card, HEAD, state, event)
}

function plain<T extends object>(rows: readonly T[]): T[] {
  return rows.map(row => ({ ...row }))
}

function withTasks(): DatabaseSync {
  const bus = openBus(':memory:')
  const events = Array.from({ length: 6 }, (_, n) => anEvent(bus, n % 2 === 0 ? CARD : OTHER_CARD, n))
  aTask(bus, { key: 'answer:z', queue: 'answer', card: CARD, state: 'withdrawn', gen: 0, event: events[0]! })
  aTask(bus, { key: 'launch:1', queue: 'launch', card: CARD, state: 'done', gen: 1, event: events[2]! })
  aTask(bus, { key: 'answer:a', queue: 'answer', card: CARD, state: 'withdrawn', gen: 0, event: events[4]! })
  aTask(bus, { key: 'launch:2', queue: 'launch', card: OTHER_CARD, state: 'leased', gen: 7, event: events[5]! })
  aTask(bus, { key: 'launch:0', queue: 'launch', card: CARD, state: 'leased', gen: 3, event: events[3]! })
  return bus
}

describe('the card domain reads the tables of other owners only through their contracts', () => {
  describe('the card domain reads tasks and prs through their owners, not through SQL of its own', () => {
    it('tasks.ofCard gives the launch lease the session read by its own SQL', () => {
      db = withTasks()
      const before = { ...db.prepare('SELECT task_key, state, lease_gen FROM tasks WHERE queue = \'launch\' AND card_id = ? ORDER BY event_id DESC LIMIT 1').get(CARD) }
      const now = tasks.ofCard(db, CARD, { queue: 'launch' }).at(-1)!
      expect({ task_key: now.task_key, state: now.state, lease_gen: now.lease_gen }).toEqual(before)
      expect(before).toEqual({ task_key: 'launch:0', state: 'leased', lease_gen: 3 })
    })

    it('tasks.ofCard gives the withdrawn answers since an event that card-hold read by its own SQL', () => {
      db = withTasks()
      const since = 1
      const before = plain(db.prepare('SELECT task_key, queue, card_id, pr, head, state, event_id FROM tasks WHERE card_id = ? AND queue = \'answer\' AND state = ? AND event_id > ? ORDER BY task_key').all(CARD, 'withdrawn', since) as Record<string, unknown>[])
      const now = tasks.ofCard(db, CARD, { queue: 'answer', state: 'withdrawn', after: since })
        .map(({ task_key, queue, card_id, pr, head, state, event_id }) => ({ task_key, queue, card_id, pr, head, state, event_id }))
        .sort((a, b) => a.task_key.localeCompare(b.task_key))
      expect(now).toEqual(before)
      expect(now.map(task => task.task_key)).toEqual(['answer:a'])
    })

    it('tasks.ofCard keeps the order of events and leaves out the tasks of other cards', () => {
      db = withTasks()
      expect(tasks.ofCard(db, CARD).map(task => task.task_key)).toEqual(['answer:z', 'launch:1', 'launch:0', 'answer:a'])
      expect(tasks.ofCard(db, OTHER_CARD).map(task => task.task_key)).toEqual(['launch:2'])
      expect(tasks.ofCard(db, 1)).toEqual([])
    })

    it('prs.ofPr and prs.ofCard give the rows of prs as values', () => {
      db = openBus(':memory:')
      const event = anEvent(db, CARD, 0)
      aPr(db, 52, CARD, 'merged', event)
      aPr(db, 51, CARD, 'open', event)
      aPr(db, 53, null, 'open', event)
      expect(prs.ofPr(db, 52)).toEqual({ ...db.prepare('SELECT * FROM prs WHERE pr = 52').get() })
      expect(prs.ofPr(db, 52)?.state).toBe('merged')
      expect(prs.ofPr(db, 99)).toBeNull()
      expect(prs.ofCard(db, CARD).map(row => row.pr)).toEqual([51, 52])
      expect(prs.ofCard(db, OTHER_CARD)).toEqual([])
      expect(prs.all(db)).toEqual((db.prepare('SELECT * FROM prs ORDER BY pr').all() as Record<string, unknown>[]).map(row => ({ ...row })))
      expect(prs.all(db).map(row => row.pr)).toEqual([51, 52, 53])
    })
  })

  async function ruleWithoutExceptions(): Promise<ESLint> {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, CARD_DOMAIN_FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
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
      [...new Set(result.messages.filter(message => message.ruleId === RULE).map(message => NAMED_TABLE.exec(message.message)?.[1] ?? message.message))].sort(),
    ]))
  }

  describe('the card domain names no table of another owner', () => {
    it('card-automaton, card-hold and card-waits are files of card-record and have left the excepted list', () => {
      expect(MODULE_FILES['card-record']).toEqual(expect.arrayContaining(CARD_DOMAIN_FILES))
      expect(EXCEPTED.filter(file => CARD_DOMAIN_FILES.includes(file))).toEqual([])
    })

    it('the rule without exceptions finds no foreign table in them', async () => {
      expect(await foreignTablesOf(CARD_DOMAIN_FILES)).toEqual(Object.fromEntries(CARD_DOMAIN_FILES.map(file => [file, []])))
    }, LINT_MS)
  })
})
