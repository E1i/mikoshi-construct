import type { RatchetNumbers } from '../../contract/ratchet.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RATCHET_RECORD, renderRatchet, rowsGrownOverBase } from '../../contract/ratchet.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SUITE_ROOTS = ['tests', 'scripts/tests']
const TEST_FILE = /\.test\.ts$/
const EXCLUDED = ['tests/fixtures/']
const DEPENDENCIES = '/node_modules/'
const BRANCH_BASE_UNIT_TEST = 'tests/contract/ratchet-branch-base.test.ts'
const BASE_DOOR = 'branchBase'
const BASE_COMMAND = ['merge', 'base'].join('-')
const RECORD_NAMES = ['RATCHET_RECORD', RATCHET_RECORD]
const NAMED_IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from/gm
const GIT_IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture', '-c', 'commit.gpgsign=false']
const OUTSIDE_CI = { mainRefs: ['main'], env: {} }
const GROWN_LINES = 'lines:scripts/big.ts'
const BASE_NUMBERS: RatchetNumbers = { [GROWN_LINES]: 900, 'lines:scripts/other.ts': 850, 'boundary:app->ports': 0 }
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function suiteFiles(): string[] {
  return SUITE_ROOTS.flatMap(dir => readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && TEST_FILE.test(entry.name))
    .map(entry => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(file => !EXCLUDED.some(prefix => file.startsWith(prefix)) && !file.includes(DEPENDENCIES)))
}

function importedNames(source: string): string[] {
  return [...source.matchAll(NAMED_IMPORT)].flatMap(([, names]) => names!.split(',').map(name => name.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')))
}

function readsTheBranchBase(source: string): boolean {
  return importedNames(source).includes(BASE_DOOR) || (source.includes(BASE_COMMAND) && RECORD_NAMES.some(name => source.includes(name)))
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...GIT_IDENTITY, ...args], { stdio: 'ignore' })
}

function commitRecord(root: string, numbers: RatchetNumbers): void {
  writeFileSync(path.join(root, RATCHET_RECORD), renderRatchet(numbers))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'record')
}

function scratchOnMain(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'any-base-'))
  roots.push(root)
  mkdirSync(path.join(root, path.dirname(RATCHET_RECORD)), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commitRecord(root, BASE_NUMBERS)
  return root
}

describe('the permanent suite states only laws that hold on any base', () => {
  it('no permanent test reads the branch base except through rowsGrownOverBase', () => {
    const files = suiteFiles()
    expect(files).toContain(BRANCH_BASE_UNIT_TEST)
    expect(files.filter(file => file !== BRANCH_BASE_UNIT_TEST && readsTheBranchBase(readFileSync(path.join(ROOT, file), 'utf8')))).toEqual([])
  })

  it.each([
    ['imports the base door', `import { ${BASE_DOOR} } from './ratchet.js'\n`, true],
    ['runs the base command beside the record name', `git('${BASE_COMMAND}', 'HEAD', 'main')\nread(RATCHET_RECORD)\n`, true],
    ['runs the base command beside the record path', `git('${BASE_COMMAND}', 'HEAD', 'main')\nread('${RATCHET_RECORD}')\n`, true],
    ['names the record without the base command', `read(RATCHET_RECORD)\n`, false],
    ['runs the base command for other git work', `git('${BASE_COMMAND}', 'HEAD', 'main')\n`, false],
    ['imports a door of another name', `import { ${BASE_DOOR}Of } from './ratchet.js'\n`, false],
  ] as const)('the scan for a branch-base read judges a source that %s', (_case, source, reads) => {
    expect(readsTheBranchBase(source)).toBe(reads)
  })

  it('rowsGrownOverBase finds nothing grown when the base is the head', () => {
    const root = scratchOnMain()
    expect(rowsGrownOverBase(root, BASE_NUMBERS, () => true, OUTSIDE_CI)).toEqual([])
  })

  it('rowsGrownOverBase names a judged row that grew over the base', () => {
    const root = scratchOnMain()
    git(root, 'checkout', '-q', '-b', 'card')
    const head = { ...BASE_NUMBERS, [GROWN_LINES]: 901, 'lines:scripts/other.ts': 800 }
    commitRecord(root, head)
    expect(rowsGrownOverBase(root, head, key => key.startsWith('lines:'), OUTSIDE_CI)).toEqual([GROWN_LINES])
    expect(rowsGrownOverBase(root, head, key => key !== GROWN_LINES, OUTSIDE_CI)).toEqual([])
  })
})
