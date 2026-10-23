import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SCANNED_ROOTS = ['src', 'scripts']
const THE_LADDER = 'scripts/ghosts/'
const THE_LEGACY_IMPORTER = 'scripts/bus/import.ts'
const TESTS = 'scripts/tests/'
const SOURCE_FILE = /\.[cm]?[jt]s$/
const JOURNAL_NAMES = /ghosts\.jsonl|GHOST_JOURNAL|journalPath\(|defaultWindowJournal|WINDOW_JOURNAL_FILE/

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function sourceFiles(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
      return sourceFiles(root, relative)
    return SOURCE_FILE.test(entry.name) ? [relative] : []
  })
}

function journalUsers(root: string): string[] {
  return SCANNED_ROOTS.flatMap(dir => sourceFiles(root, dir))
    .filter(file => !file.startsWith(THE_LADDER) && !file.startsWith(TESTS))
    .filter(file => JOURNAL_NAMES.test(readFileSync(path.join(root, file), 'utf8')))
    .sort()
}

function journalUsersOutsideTheLadder(root: string): string[] {
  return journalUsers(root).filter(file => file !== THE_LEGACY_IMPORTER)
}

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'journal-guard-'))
  roots.push(root)
  for (const dir of SCANNED_ROOTS)
    mkdirSync(path.join(root, dir), { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

describe('ghosts.jsonl is read and written only inside the ladder', () => {
  it('no writer or reader of ghosts.jsonl outside the ladder', () => {
    expect(journalUsersOutsideTheLadder(REPO_ROOT)).toEqual([])
  })

  it('scripts/bus/import.ts is allowed by name: pnpm bus:import is the one reader that copies the legacy journal into the bus', () => {
    expect(journalUsers(REPO_ROOT)).toContain(THE_LEGACY_IMPORTER)
  })

  it('a planted ghosts.jsonl read outside the ladder is found', () => {
    const planted = `import { readFileSync } from 'node:fs'\nexport const history = readFileSync('ghosts.jsonl', 'utf8')\n`
    const root = treeWith({
      'scripts/ghosts/launch.ts': planted,
      'scripts/tests/bus/fixture.test.ts': planted,
      'scripts/bus/planted.ts': planted,
      'src/commands/planted.ts': `export const at = journalPath()\n`,
      'scripts/bus/import.ts': planted,
      'scripts/bus/clean.ts': `export const bus = 'bus.db'\n`,
    })
    expect(journalUsersOutsideTheLadder(root)).toEqual(['scripts/bus/planted.ts', 'src/commands/planted.ts'])
  })
})
