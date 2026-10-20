import { describe, expect, it } from 'vitest'
import { isTest as layersIsTest } from '../../scripts/ci/layers.js'
import { coveringTests, importersOf, isTest, PACKAGE_SCRIPT_READERS, SCANNED_TREES, TestCoverage, withinTouches } from '../../src/card/covering-tests.js'

const FILES: Record<string, string> = {
  'src/card/risk.ts': 'export const RISK = 1\n',
  'src/commands/intake/confirm.ts': 'import {\n  RISK,\n} from \'../../card/risk.js\'\n',
  'src/commands/intake/index.ts': 'export { confirm } from \'./confirm.js\'\n',
  'src/other.ts': 'export const OTHER = 1\n',
  'tests/intake.test.ts': 'import { runIntake } from \'../src/commands/intake/index.js\'\n',
  'tests/lazy.test.ts': 'const loaded = await import(\'../src/card/risk.js\')\n',
  'tests/other.test.ts': 'import { OTHER } from \'../src/other.js\'\n',
  'tests/helper.ts': 'import { RISK } from \'../src/card/risk.js\'\n',
  'tests/through-helper.test.ts': 'import \'./helper.js\'\n',
  'tests/contributing-scripts.test.ts': 'export {}\n',
  'tests/harness-membership.test.ts': 'export {}\n',
  'docs/guide.md': 'from \'../src/card/risk.js\'\n',
}

function covering(touches: string[]): string[] {
  const files = Object.keys(FILES)
  const read = (file: string): string | null => FILES[file] ?? null
  return coveringTests(touches, files, importersOf(files, read), read)
}

describe('the tests that cover a touched file', () => {
  it('a test reaches a touched file through any chain of imports, static, re-exported or dynamic', () => {
    expect(covering(['src/card/risk.ts'])).toEqual(['tests/intake.test.ts', 'tests/lazy.test.ts', 'tests/through-helper.test.ts'])
  })

  it('a test that imports nothing the touches reach does not cover them', () => {
    expect(covering(['src/other.ts'])).toEqual(['tests/other.test.ts'])
  })

  it('a mask covers every file under it', () => {
    expect(covering(['src/commands/**'])).toEqual(['tests/intake.test.ts'])
  })

  it('a test that scans a touched tree, or spawns a touched script by name, covers it', () => {
    const files: Record<string, string> = {
      'scripts/shift/tree-pr.ts': 'export {}\n',
      'tests/decisions-read-through-reader.test.ts': 'readdirSync(root)\n',
      'scripts/tests/shift/spawned.test.ts': 'spawnSync(\'tsx\', [\'scripts/shift/tree-pr.ts\'])\n',
      'scripts/tests/shift/unrelated.test.ts': 'export {}\n',
    }
    const read = (file: string): string | null => files[file] ?? null
    const list = Object.keys(files)
    expect(coveringTests(['scripts/shift/tree-pr.ts'], list, importersOf(list, read), read)).toEqual(['scripts/tests/shift/spawned.test.ts', 'tests/decisions-read-through-reader.test.ts'])
  })

  it('a test reaches a touched file through vi.mock, require or a re-export split over lines', () => {
    const files: Record<string, string> = {
      'src/x.ts': 'export const X = 1\n',
      'tests/mocked.test.ts': 'vi.mock(\'../src/x.js\')\n',
      'tests/required.test.ts': 'const x = require(\'../src/x.js\')\n',
      'tests/barrel.ts': 'export {\n  X,\n}\n  from \'../src/x.js\'\n',
      'tests/barrel.test.ts': 'import \'./barrel.js\'\n',
    }
    const read = (file: string): string | null => files[file] ?? null
    const list = Object.keys(files)
    expect(coveringTests(['src/x.ts'], list, importersOf(list, read), read)).toEqual(['tests/barrel.test.ts', 'tests/mocked.test.ts', 'tests/required.test.ts'])
  })

  it('package.json is covered by the readers of its scripts', () => {
    expect(covering(['package.json'])).toEqual(PACKAGE_SCRIPT_READERS)
  })

  it('a touched test helper is covered by the tests that import it, and a touched test starts no walk', () => {
    expect(covering(['tests/helper.ts'])).toEqual(['tests/through-helper.test.ts'])
    expect(covering(['tests/intake.test.ts'])).toEqual([])
  })

  it('only a .test.ts file under a test root is a test', () => {
    expect([isTest('tests/a.test.ts'), isTest('scripts/tests/a.test.ts'), isTest('tests/helper.ts'), isTest('src/a.test.ts')]).toEqual([true, true, false, false])
  })

  it('withinTouches reads exact paths and masks', () => {
    expect([withinTouches('tests/a/b.ts', ['tests/**']), withinTouches('tests.ts', ['tests/**']), withinTouches('README.md', ['README.md'])]).toEqual([true, false, true])
  })

  it('testCoverage lists and reads the repository once', () => {
    let lists = 0
    const coverage = new TestCoverage(() => {
      lists += 1
      return Object.keys(FILES)
    }, file => FILES[file] ?? null)
    coverage.of(['src/other.ts'])
    expect(coverage.of(['src/card/risk.ts'])).toHaveLength(3)
    expect(lists).toBe(1)
  })
})

describe('the tests that reach a touched file other than by a static import', () => {
  const reaching: Record<string, string> = {
    'scripts/shift/shift.ts': 'export function runShift() {}\n',
    'scripts/bus/review-worker.ts': 'export function runReviewWorker() {}\n',
    'scripts/bus/answer-executor.ts': 'export const A = 1\n',
    'scripts/bus/barrel.ts': 'export * from\n  \'./answer-executor.js\'\n',
    'tests/decisions-read-through-reader.test.ts': 'readdirSync(\'scripts\')\n',
    'scripts/tests/bus/spawns.test.ts': 'spawnSync(\'tsx\', [\'scripts/bus/review-worker.ts\'])\n',
    'scripts/tests/bus/mocks.test.ts': 'vi.mock(\'../../bus/answer-executor.js\')\n',
    'scripts/tests/bus/requires.test.ts': 'const worker = require(\'../../bus/review-worker.js\')\n',
    'scripts/tests/bus/actual.test.ts': 'await vi.importActual(\'../../bus/answer-executor.js\')\n',
    'scripts/tests/bus/through-barrel.test.ts': 'import { A } from \'../../bus/barrel.js\'\n',
  }

  function reached(touches: string[]): string[] {
    const files = Object.keys(reaching)
    const read = (file: string): string | null => reaching[file] ?? null
    return coveringTests(touches, files, importersOf(files, read), read)
  }

  it('a test that scans the tree of a touched file covers it (SCANNED_TREES)', () => {
    expect(reached(['scripts/shift/shift.ts'])).toEqual(['tests/decisions-read-through-reader.test.ts'])
    expect(SCANNED_TREES['scripts/shift/']).toContain('tests/decisions-read-through-reader.test.ts')
  })

  it('a test that spawns a touched script by its path, or loads it through require, covers it', () => {
    expect(reached(['scripts/bus/review-worker.ts'])).toEqual(['scripts/tests/bus/requires.test.ts', 'scripts/tests/bus/spawns.test.ts'])
  })

  it('vi.mock, vi.importActual and an export * split over lines reach a touched module', () => {
    expect(reached(['scripts/bus/answer-executor.ts'])).toEqual(['scripts/tests/bus/actual.test.ts', 'scripts/tests/bus/mocks.test.ts', 'scripts/tests/bus/through-barrel.test.ts'])
  })

  it('the CI layer selection reads what a test is from this rule, not from a copy of its own', () => {
    expect(layersIsTest).toBe(isTest)
  })
})
