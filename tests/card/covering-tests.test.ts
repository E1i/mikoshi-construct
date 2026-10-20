import { describe, expect, it } from 'vitest'
import { coveringTests, importersOf, isTest, PACKAGE_SCRIPT_READERS, TestCoverage, withinTouches } from '../../src/card/covering-tests.js'

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
  return coveringTests(touches, files, importersOf(files, file => FILES[file] ?? null))
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
