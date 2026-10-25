import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { SQLITE_EXPERIMENTAL_WARNING } from '../../core/sqlite.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const SCRIPTS = path.join(REPO_ROOT, 'scripts')
const LOADER = path.join(SCRIPTS, 'bus/sqlite.ts')
const DB_MODULE = path.join(SCRIPTS, 'bus/db.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const OTHER_WARNING = 'a warning that is not about SQLite'
const SQLITE_VALUE_IMPORT = /^import \{[^}]*\} from 'node:sqlite'|require\('node:sqlite'\)|getBuiltinModule\('node:sqlite'\)/m
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function runOpeningTheBus(): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-sqlite-'))
  roots.push(root)
  const script = path.join(root, 'open.ts')
  writeFileSync(script, [
    `import { openBus } from ${JSON.stringify(DB_MODULE)}`,
    `openBus(${JSON.stringify(path.join(root, 'bus.db'))}).close()`,
    `process.emitWarning(${JSON.stringify(OTHER_WARNING)})`,
  ].join('\n'))
  return spawnSync(process.execPath, [TSX_CLI, script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '' } })
}

function productSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'tests' ? [] : productSources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

describe('the bus loads node:sqlite without its experimental warning', () => {
  it('a process that opens the bus prints no SQLite warning and still prints any other warning', () => {
    const result = runOpeningTheBus()
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain(SQLITE_EXPERIMENTAL_WARNING)
    expect(result.stderr).toContain(OTHER_WARNING)
  })

  it('only the loader takes node:sqlite as a value under scripts/, so no other import can print the warning first', () => {
    const loaders = productSources(SCRIPTS).filter(file => SQLITE_VALUE_IMPORT.test(readFileSync(file, 'utf8')))
    expect(loaders).toEqual([LOADER])
  })
})
