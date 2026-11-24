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
const RELATIVE_IMPORT = /from '(\.{1,2}\/[^']+)'/g

const DECISIONS_INDEX = 'scripts/policy/decisions/index.ts'
const ANSWER_SOURCE = 'scripts/nodes/answer/answer-source.ts'
const SHARDS = 'scripts/policy/shards.ts'
const FILES = [DECISIONS_INDEX, ANSWER_SOURCE, SHARDS]
const OWNER_OF = { [DECISIONS_INDEX]: 'decisions', [ANSWER_SOURCE]: 'node-answer', [SHARDS]: 'rules' }
const UNDECIDED_READERS = [DECISIONS_INDEX, SHARDS]
const OWNERS_ABOVE_THE_UNDECIDED = ['pr-record']

function sourceOfImport(file: string, specifier: string): string {
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts')
}

function importsOf(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return [...text.matchAll(RELATIVE_IMPORT)].map(match => sourceOfImport(file, match[1]!))
}

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

describe('decisions index, answer-source and shards read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module and has left the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(noneOf(FILES))
  }, LINT_MS)

  it('neither decisions index nor shards imports a file of pr-record', () => {
    const above = new Set(OWNERS_ABOVE_THE_UNDECIDED.flatMap(owner => MODULE_FILES[owner] ?? []))
    expect(Object.fromEntries(UNDECIDED_READERS.map(file => [file, importsOf(file).filter(imported => above.has(imported))]))).toEqual(noneOf(UNDECIDED_READERS))
  })

  it('the shard fragments composition binds into merge candidates are the bus\'s, not the rules\'', () => {
    const shards = readFileSync(path.join(REPO_ROOT, SHARDS), 'utf8')
    expect(shards).not.toMatch(/export (?:const|function) (?:WINDOW_SHARDS_LIVE_AT|unspentShardsOf)\b/)
    expect(importsOf('scripts/supervisor/composition.ts')).toContain('scripts/core/events-query.ts')
  })
})
