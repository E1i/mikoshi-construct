import type { Linter } from 'eslint'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { cardsAmong, openWaitEventsByCard, waitStatesAmong } from '../../../core/card-readings.js'
import { mainsSinceLastMechanics } from '../../../core/pr-readings.js'
import * as tasks from '../../../core/tasks-query.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const OWNER_OF: Record<string, string> = {
  'scripts/supervisor/derive-queues.ts': 'session',
  'scripts/core/tasks-query.ts': 'bus',
  'scripts/core/events-query.ts': 'bus',
  'scripts/core/pr-readings.ts': 'pr-record',
  'scripts/core/card-readings.ts': 'card-record',
}
const FILES = Object.keys(OWNER_OF)

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
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

const TABLES = `
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL UNIQUE, queue TEXT NOT NULL, card_id INTEGER NOT NULL, pr INTEGER, head TEXT, state TEXT NOT NULL, lease_gen INTEGER NOT NULL DEFAULT 0, lease_until TEXT, failures INTEGER NOT NULL DEFAULT 0, event_id INTEGER NOT NULL);
  CREATE TABLE mains (sha TEXT PRIMARY KEY, touches_mechanics INTEGER NOT NULL, event_id INTEGER NOT NULL);
  CREATE TABLE cards (card_id INTEGER PRIMARY KEY, state TEXT, pr INTEGER);
  CREATE TABLE owner_waits (id TEXT PRIMARY KEY, card_id INTEGER, state TEXT NOT NULL, event_id INTEGER NOT NULL);
`

const CARD = 2129
const OTHER_CARD = 2130

let db: DatabaseSync | undefined

function tables(): DatabaseSync {
  const opened = new DatabaseSync(':memory:')
  opened.exec(TABLES)
  return opened
}

describe('derive-queues reads the tables of other owners only through their contracts', () => {
  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('each file belongs to its module and derive-queues has left the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(Object.fromEntries(FILES.map(file => [file, []])))
  }, LINT_MS)

  it('bus answers every task, as the keyed reads do', () => {
    db = tables()
    expect(tasks.all(db)).toEqual([])
    db.prepare(`INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES ('answer:2129', 'answer', ?, 7, 'abc', 'queued', 2), ('merge:2130', 'merge', ?, NULL, NULL, 'leased', 1)`).run(CARD, OTHER_CARD)
    expect(tasks.all(db).map(task => task.task_key)).toEqual(['merge:2130', 'answer:2129'])
    expect(tasks.all(db)).toEqual([...tasks.ofQueue(db, 'merge'), ...tasks.ofQueue(db, 'answer')])
  })

  it('pr-record answers the shas of the mains since the last mechanics main', () => {
    db = tables()
    expect(mainsSinceLastMechanics(db)).toBeNull()
    db.exec(`INSERT INTO mains (sha, touches_mechanics, event_id) VALUES ('m1', 1, 1), ('a2', 0, 2), ('m3', 1, 3), ('a4', 0, 4)`)
    expect(mainsSinceLastMechanics(db)).toEqual({ mechanics: 'm3', shas: new Set(['m3', 'a4']) })
  })

  it('card-record answers cards, wait states and the openings of open waits by key', () => {
    db = tables()
    db.prepare(`INSERT INTO cards (card_id, state, pr) VALUES (?, 'closed', 7), (?, NULL, NULL)`).run(CARD, OTHER_CARD)
    db.prepare(`INSERT INTO owner_waits (id, card_id, state, event_id) VALUES ('Q1', ?, 'open', 5), ('Q2', ?, 'closed', 6), ('Q3', ?, 'open', 4), ('Q4', NULL, 'open', 8)`).run(CARD, CARD, OTHER_CARD)
    expect(cardsAmong(db, [CARD, OTHER_CARD, 1])).toEqual(new Map([[CARD, { state: 'closed', pr: 7 }], [OTHER_CARD, { state: null, pr: null }]]))
    expect(waitStatesAmong(db, ['Q1', 'Q2', 'Q9'])).toEqual(new Map([['Q1', 'open'], ['Q2', 'closed']]))
    expect(openWaitEventsByCard(db)).toEqual(new Map([[OTHER_CARD, [4]], [CARD, [5]]]))
  })
})
