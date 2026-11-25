import type { Linter } from 'eslint'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY, TABLE_NAME_CONSTANTS } = await import(CONFIG_URL) as {
  FOREIGN_TABLE_SQL_POLICY: Linter.Config[]
  TABLE_NAME_CONSTANTS: Record<string, string>
}

const RULE = 'tables/no-foreign-table-sql'
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]
const TABLE_OWNERS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/table-owners.json'), 'utf8')) as Record<string, string>
const DECLARED_MODULES = readdirSync(path.join(REPO_ROOT, 'declarations/modules')).map(file => path.basename(file, '.json'))
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>

const A_FILE_WITH_NO_MODULE = 'scripts/core/foreign-sql-probe.ts'
const A_FILE_OF_PR_RECORD = 'scripts/nodes/review/pr-rerun.ts'
const A_TEST_FILE = 'scripts/tests/core/foreign-sql-probe.test.ts'
const AN_EXCEPTED_FILE = 'scripts/ports/netwatch.ts'
const THE_REPORT_REPLAY = 'scripts/core/report.ts'
const WHOLE_LIST_MS = 300_000

const eslint = new ESLint({ cwd: REPO_ROOT })

async function foreignTableMessages(source: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, file) })
  return result!.messages.filter(message => message.ruleId === RULE || message.fatal === true).map(message => message.message)
}

function exported(sql: string): string {
  return `export const READING = ${sql}\n`
}

async function ruleWithoutExceptions(): Promise<ESLint> {
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, AN_EXCEPTED_FILE)) as { languageOptions: { parser: Linter.Parser } }
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: config.languageOptions.parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } },
      ...FOREIGN_TABLE_SQL_POLICY.map(block => ({ ...block, ignores: (block.ignores ?? []).filter(ignored => !EXCEPTED.includes(ignored)) })),
    ],
  })
}

describe('a SQL literal reaches a bus table only from the module that owns it', () => {
  it('a SQL literal naming a table of another owner is refused outside the excepted files', async () => {
    expect(MODULE_FILES['pr-record']).toContain(A_FILE_OF_PR_RECORD)
    expect(EXCEPTED).not.toContain(A_FILE_OF_PR_RECORD)
    expect(await foreignTableMessages(exported('\'SELECT card FROM cards WHERE card = ?\''), A_FILE_OF_PR_RECORD)).toHaveLength(1)
    expect(await foreignTableMessages(exported('`SELECT pr FROM prs JOIN events ON events.id = prs.event`'), A_FILE_OF_PR_RECORD)).toHaveLength(1)
    expect(await foreignTableMessages(exported('\'DELETE FROM owner_waits WHERE card = ?\''), A_FILE_OF_PR_RECORD)).toHaveLength(1)
    expect(await foreignTableMessages(exported('\'INSERT INTO main.check_tests (test) VALUES (?)\''), A_FILE_OF_PR_RECORD)).toHaveLength(1)
    expect(await foreignTableMessages(exported('\'UPDATE cards SET size = ? WHERE card = ?\''), A_FILE_OF_PR_RECORD)).toHaveLength(1)
    expect(await foreignTableMessages(exported('\'SELECT card FROM cards\''), A_FILE_WITH_NO_MODULE)).toHaveLength(1)
  })

  it('a table-name constant in a template span counts as the table it names, any other span does not', async () => {
    for (const [constant, table] of Object.entries(TABLE_NAME_CONSTANTS)) {
      const source = `const ${constant} = '${table}'\nexport const READING = \`SELECT * FROM \${${constant}} WHERE id = ?\`\n`
      expect(await foreignTableMessages(source, A_FILE_WITH_NO_MODULE), constant).toHaveLength(1)
    }
    expect(await foreignTableMessages(`const where = 'cards'\nexport const READING = \`SELECT * FROM \${where}\`\n`, A_FILE_WITH_NO_MODULE)).toEqual([])
  })

  it('the owner\'s own tables, schema DDL, tests and the excepted files pass', async () => {
    expect(await foreignTableMessages(exported('\'SELECT pr FROM prs JOIN mains ON mains.sha = prs.base\''), A_FILE_OF_PR_RECORD)).toEqual([])
    expect(await foreignTableMessages(exported('\'CREATE TABLE IF NOT EXISTS cards (card TEXT PRIMARY KEY)\''), A_FILE_OF_PR_RECORD)).toEqual([])
    expect(await foreignTableMessages(exported('\'ALTER TABLE cards ADD COLUMN size TEXT\''), A_FILE_OF_PR_RECORD)).toEqual([])
    expect(await foreignTableMessages(exported('\'SELECT card FROM cards\''), A_TEST_FILE)).toEqual([])
    expect(await foreignTableMessages(exported('\'SELECT card FROM cards\''), AN_EXCEPTED_FILE)).toEqual([])
  })

  it('every excepted file still names a table of another owner', async () => {
    expect(EXCEPTED).toEqual([...new Set(EXCEPTED)].sort())
    expect(EXCEPTED.filter(file => !existsSync(path.join(REPO_ROOT, file)))).toEqual([])
    const results = await (await ruleWithoutExceptions()).lintFiles(EXCEPTED)
    const clean = results
      .filter(result => !result.messages.some(message => message.ruleId === RULE))
      .map(result => path.relative(REPO_ROOT, result.filePath))
    expect(results).toHaveLength(EXCEPTED.length)
    expect(clean).toEqual([])
  }, WHOLE_LIST_MS)

  it('the report replay stays listed by name: it inserts into events of openBus(\':memory:\'), a throwaway replay copy and never the bus file (write-scan separate store report-replay)', () => {
    expect(EXCEPTED).toContain(THE_REPORT_REPLAY)
  })

  it('every table has an owner among the declared modules, and every table-name constant names a table of the map', () => {
    expect(Object.values(TABLE_OWNERS).filter(owner => !DECLARED_MODULES.includes(owner))).toEqual([])
    expect(Object.values(TABLE_NAME_CONSTANTS).filter(table => !(table in TABLE_OWNERS))).toEqual([])
  })
})
