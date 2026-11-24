import type { Linter } from 'eslint'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { mainsSinceLastMechanics } from '../../../core/pr-readings.js'

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
  CREATE TABLE mains (sha TEXT PRIMARY KEY, touches_mechanics INTEGER NOT NULL, event_id INTEGER NOT NULL);
`

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

  it('pr-record answers the shas of the mains since the last mechanics main', () => {
    db = tables()
    expect(mainsSinceLastMechanics(db)).toBeNull()
    db.exec(`INSERT INTO mains (sha, touches_mechanics, event_id) VALUES ('m1', 1, 1), ('a2', 0, 2), ('m3', 1, 3), ('a4', 0, 4)`)
    expect(mainsSinceLastMechanics(db)).toEqual({ mechanics: 'm3', shas: new Set(['m3', 'a4']) })
  })
})
