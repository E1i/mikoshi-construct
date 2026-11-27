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

const BUS_READING_FILES = ['scripts/core/lease.ts', 'scripts/core/observations.ts', 'scripts/core/dependency-wait.ts', 'scripts/core/db.ts', 'scripts/core/bus-readings.ts']
const OWNERS_ABOVE_THE_BUS = ['card-record', 'pr-record']

function sourceOfImport(file: string, specifier: string): string {
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts')
}

function importsOf(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return [...text.matchAll(RELATIVE_IMPORT)].map(match => sourceOfImport(file, match[1]!))
}

describe('the bus reads prs and owner_waits only as values its composition passes', () => {
  async function ruleWithoutExceptions(): Promise<ESLint> {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, BUS_READING_FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
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

  it('lease, observations, dependency-wait, db and bus-readings are files of the bus and have left the excepted list', () => {
    expect(MODULE_FILES.bus).toEqual(expect.arrayContaining(BUS_READING_FILES))
    expect(EXCEPTED.filter(file => BUS_READING_FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(BUS_READING_FILES)).toEqual(Object.fromEntries(BUS_READING_FILES.map(file => [file, []])))
  }, LINT_MS)

  it('none of them imports a file of card-record or pr-record', () => {
    const above = new Set(OWNERS_ABOVE_THE_BUS.flatMap(owner => MODULE_FILES[owner] ?? []))
    expect(Object.fromEntries(BUS_READING_FILES.map(file => [file, importsOf(file).filter(imported => above.has(imported))]))).toEqual(Object.fromEntries(BUS_READING_FILES.map(file => [file, []])))
  })

  it('the open owner waits are read by card-record, not by the bus', () => {
    expect(MODULE_FILES['card-record']).toContain('scripts/core/card-readings.ts')
    expect(readFileSync(path.join(REPO_ROOT, 'scripts/core/bus-readings.ts'), 'utf8')).not.toContain('openOwnerWaits')
  })
})
