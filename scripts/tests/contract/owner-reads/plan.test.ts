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

const PLAN_DOMAIN_FILES = ['scripts/window/plan-folds.ts']

describe('the plan domain reads the tables of other owners only through their contracts', () => {
  async function ruleWithoutExceptions(): Promise<ESLint> {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, PLAN_DOMAIN_FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
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

  describe('the plan domain names no table of another owner', () => {
    it('plan-folds is a file of plan and has left the excepted list', () => {
      expect(MODULE_FILES.plan).toEqual(expect.arrayContaining(PLAN_DOMAIN_FILES))
      expect(EXCEPTED.filter(file => PLAN_DOMAIN_FILES.includes(file))).toEqual([])
    })

    it('the rule without exceptions finds no foreign table in plan-folds', async () => {
      expect(await foreignTablesOf(PLAN_DOMAIN_FILES)).toEqual(Object.fromEntries(PLAN_DOMAIN_FILES.map(file => [file, []])))
    }, LINT_MS)
  })
})
