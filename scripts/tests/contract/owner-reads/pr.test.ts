import type { Linter } from 'eslint'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { plans, releases } from '../../../core/plan-readings.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = Object.keys((await import(CONFIG_URL) as { JOURNAL_HISTORY_REPLAYS: Record<string, string> }).JOURNAL_HISTORY_REPLAYS)

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const OWNER_OF: Record<string, string> = {
  'scripts/nodes/review/pr-close.ts': 'pr-record',
  'scripts/core/pr-status.ts': 'pr-record',
  'scripts/core/pr-folds.ts': 'pr-record',
  'scripts/nodes/review/pr-reopen.ts': 'pr-record',
  'scripts/nodes/review/record-verdict.ts': 'pr-record',
  'scripts/nodes/merge/merge-worker.ts': 'node-merge',
  'scripts/core/plan-readings.ts': 'plan',
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

const RELEASE = 'factory-0.47.0'
const OPEN = 'open'
const PLANNED_CARD = 2128
const UNPLANNED_CARD = 2129

const PLAN_TABLES = `
  CREATE TABLE plans (plan_id TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE card_releases (card_id INTEGER PRIMARY KEY, release TEXT NOT NULL);
`

let db: DatabaseSync | undefined

function planTables(): DatabaseSync {
  const tables = new DatabaseSync(':memory:')
  tables.exec(PLAN_TABLES)
  return tables
}

describe('the pr domain reads the tables of other owners only through their contracts', () => {
  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('each file belongs to its module and has left the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(Object.fromEntries(FILES.map(file => [file, []])))
  }, LINT_MS)

  it('plan answers the release of a card and the plan it stands in', () => {
    db = planTables()
    expect(releases.ofCard(db, PLANNED_CARD)).toBeNull()
    expect(plans.ofCard(db, PLANNED_CARD)).toBeNull()
    db.prepare('INSERT INTO plans (plan_id, state) VALUES (?, ?)').run(RELEASE, OPEN)
    db.prepare('INSERT INTO card_releases (card_id, release) VALUES (?, ?)').run(PLANNED_CARD, RELEASE)
    expect(releases.ofCard(db, PLANNED_CARD)).toBe(RELEASE)
    expect(plans.ofCard(db, PLANNED_CARD)).toEqual({ plan: RELEASE, state: OPEN })
    expect(releases.ofCard(db, UNPLANNED_CARD)).toBeNull()
    expect(plans.ofCard(db, UNPLANNED_CARD)).toBeNull()
  })
})
