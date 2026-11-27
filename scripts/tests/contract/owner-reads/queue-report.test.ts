import type { Linter } from 'eslint'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = Object.keys((await import(CONFIG_URL) as { JOURNAL_HISTORY_REPLAYS: Record<string, string> }).JOURNAL_HISTORY_REPLAYS)

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const THE_REPORT_REPLAY = 'scripts/core/report.ts'
const OWNER_OF: Record<string, string> = {
  'scripts/core/queue.ts': 'bus',
  'scripts/core/tasks.ts': 'session',
  'scripts/core/chain.ts': 'session',
  [THE_REPORT_REPLAY]: 'session',
}
const FILES = Object.keys(OWNER_OF)
const READERS = FILES.filter(file => file !== THE_REPORT_REPLAY)

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
    result.messages.filter(message => message.ruleId === RULE).map(message => NAMED_TABLE.exec(message.message)?.[1] ?? message.message),
  ]))
}

describe('queue, report, tasks and chain read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module, and only the report replay stays on the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([THE_REPORT_REPLAY])
  })

  it('the rule without exceptions finds no table of another owner in queue, tasks and chain, and in report only the replay insert into events', async () => {
    expect(await foreignTablesOf(FILES)).toEqual({ ...Object.fromEntries(READERS.map(file => [file, []])), [THE_REPORT_REPLAY]: ['events'] })
  }, LINT_MS)
})
