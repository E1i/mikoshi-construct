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
const RELATIVE_IMPORT = /from '(\.{1,2}\/[^']+)'/g

const DECISIONS_FILES = ['scripts/core/inbox.ts', 'scripts/core/card-decisions.ts']
const OWNERS_ABOVE_DECISIONS = ['pr-record']

function sourceOfImport(file: string, specifier: string): string {
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts')
}

function importsOf(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return [...text.matchAll(RELATIVE_IMPORT)].map(match => sourceOfImport(file, match[1]!))
}

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, DECISIONS_FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
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

describe('inbox and card-decisions read the tables of other owners only through their contracts', () => {
  it('inbox and card-decisions are files of decisions and have left the excepted list', () => {
    expect(MODULE_FILES.decisions).toEqual(expect.arrayContaining(DECISIONS_FILES))
    expect(EXCEPTED.filter(file => DECISIONS_FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(DECISIONS_FILES)).toEqual(Object.fromEntries(DECISIONS_FILES.map(file => [file, []])))
  }, LINT_MS)

  it('neither imports a file of pr-record: the values of pull requests come in from the composition', () => {
    const above = new Set(OWNERS_ABOVE_DECISIONS.flatMap(owner => MODULE_FILES[owner] ?? []))
    expect(Object.fromEntries(DECISIONS_FILES.map(file => [file, importsOf(file).filter(imported => above.has(imported))]))).toEqual(Object.fromEntries(DECISIONS_FILES.map(file => [file, []])))
  })
})
