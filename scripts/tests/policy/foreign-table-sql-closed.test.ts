import type { Linter } from 'eslint'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY, JOURNAL_HISTORY_REPLAYS = {} } = await import(CONFIG_URL) as {
  FOREIGN_TABLE_SQL_POLICY: Linter.Config[]
  JOURNAL_HISTORY_REPLAYS?: Record<string, string>
}

const RULE = 'tables/no-foreign-table-sql'
const TEST_TREES = ['scripts/tests/**', 'tests/**']
const THE_REPORT_REPLAY = 'scripts/core/report.ts'
const THE_RATCHET = 'scripts/quality/foreign-table-sql-excepted.json'
const LINT_MS = 120_000

function sourceIgnores(): string[] {
  return FOREIGN_TABLE_SQL_POLICY.flatMap(block => (block.ignores ?? []).filter(ignored => !TEST_TREES.includes(ignored)))
}

async function ruleWithoutReplays(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, THE_REPORT_REPLAY)) as { languageOptions: { parser: Linter.Parser } }
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: config.languageOptions.parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } },
      ...FOREIGN_TABLE_SQL_POLICY.map(block => ({ ...block, ignores: TEST_TREES })),
    ],
  })
}

describe('no-foreign-table-sql holds on the whole tree with no ratchet', () => {
  it('the exception list is gone', () => {
    expect(existsSync(path.join(REPO_ROOT, THE_RATCHET))).toBe(false)
  })

  it('no source file is excepted but the named journal-history replays, each with its reason', () => {
    expect(sourceIgnores()).toEqual(Object.keys(JOURNAL_HISTORY_REPLAYS))
    expect(Object.keys(JOURNAL_HISTORY_REPLAYS)).toEqual([THE_REPORT_REPLAY])
    expect(Object.values(JOURNAL_HISTORY_REPLAYS).filter(reason => reason.trim() === '')).toEqual([])
  })

  it('the report replay still names a table of another owner, so its exception is live', async () => {
    const results = await (await ruleWithoutReplays()).lintFiles([THE_REPORT_REPLAY])
    expect(results).toHaveLength(1)
    expect(results.filter(result => !result.messages.some(message => message.ruleId === RULE)).map(result => path.relative(REPO_ROOT, result.filePath))).toEqual([])
  }, LINT_MS)
})
