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
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const CARD_RUNS = 'scripts/ci/card-runs.ts'
const CHECK_CATALOG = 'scripts/cli/check-catalog.ts'
const INTAKE = 'scripts/intake/intake.ts'
const FILES = [CARD_RUNS, CHECK_CATALOG, INTAKE]
const OWNER_OF = { [CARD_RUNS]: 'quality', [CHECK_CATALOG]: 'quality', [INTAKE]: 'intake' }

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

function noneOf(files: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(files.map(file => [file, []]))
}

describe('card-runs, check-catalog and intake read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module and has left the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(noneOf(FILES))
  }, LINT_MS)
})
