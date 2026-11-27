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

const FILES_OF_MODULE: Record<string, readonly string[]> = {
  'node-witness': ['scripts/nodes/witness/witness-candidates.ts', 'scripts/nodes/witness/witness-executor.ts'],
  'node-merge': ['scripts/nodes/merge/merge-candidates.ts'],
  'node-update': ['scripts/nodes/update/update-candidates.ts', 'scripts/nodes/update/update-executor.ts'],
}
const READERS = Object.values(FILES_OF_MODULE).flat()

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

describe('the witness, merge and update nodes read the tables of other owners only through their contracts', () => {
  it('each file belongs to its node and none stays on the excepted list', () => {
    for (const [module, files] of Object.entries(FILES_OF_MODULE)) {
      for (const file of files)
        expect(MODULE_FILES[module]).toContain(file)
    }
    expect(EXCEPTED.filter(file => READERS.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in any of them', async () => {
    expect(await foreignTablesOf(READERS)).toEqual(Object.fromEntries(READERS.map(file => [file, []])))
  }, LINT_MS)
})
