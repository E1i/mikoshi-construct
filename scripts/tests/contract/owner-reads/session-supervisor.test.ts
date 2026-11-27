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

const OWNER_OF: Record<string, string> = {
  'scripts/ports/bus-read.ts': 'bus',
  'scripts/supervisor/stalled-sessions.ts': 'session',
  'scripts/intake/witness-fields-backfill.ts': 'card-record',
  'scripts/supervisor/bus-heal.ts': 'session',
  'scripts/supervisor/heartbeat.ts': 'session',
  'scripts/window/window-heartbeat.ts': 'window',
  'scripts/supervisor/bus-snapshot.ts': 'session',
  'src/commands/liveness.ts': 'session',
  'scripts/supervisor/reducer-loop.ts': 'session',
  'scripts/supervisor/supervisor.ts': 'session',
  'scripts/window/eddies-measure.ts': 'window',
  'scripts/core/legacy-history.ts': 'session',
  'src/card/risk.ts': 'card-model',
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
    result.messages.filter(message => message.ruleId === RULE).map(message => `${NAMED_TABLE.exec(message.message)?.[1] ?? message.message}:${message.line}`),
  ]))
}

describe('the supervisor and session readers read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module and none stays on the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in any of them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(Object.fromEntries(FILES.map(file => [file, []])))
  }, LINT_MS)
})
