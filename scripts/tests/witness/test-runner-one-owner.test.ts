import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unfitOnTheBase } from '../../../src/commands/intake/admit.js'
import { findsNoTest, namedPaths, testRunnerOf, withinScope } from '../../../src/commands/test-runner.js'
import { namedOutsideTheCard } from '../../ports/witnesses.js'

const CARD_TEST = 'tests/y/a.test.ts'
const CARD = { touches: [CARD_TEST], creates: [] }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function emptyBase(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'test-runner-one-owner-'))
  roots.push(root)
  return root
}

const READINGS = [
  { command: `pnpm exec vitest run ${CARD_TEST} -t a/b`, outside: [] },
  { command: `pnpm exec vitest run ${CARD_TEST} --dir=foo/bar`, outside: ['foo/bar'] },
]

describe('intake and the witness node read one witness command alike', () => {
  it.each(READINGS)('$command names $outside outside the card for both', ({ command, outside }) => {
    const base = emptyBase()
    const byNode = namedOutsideTheCard(base, { criterion: 'W1', command }, CARD, [])
    const byIntake = unfitOnTheBase(command, { dir: base, card: CARD, createdAreTheChange: false })
    expect(byNode).toEqual(outside)
    expect(byIntake).toBe(outside.length > 0)
  })

  it('the one owner reads a -t name as no path and a --flag=value as the path it holds', () => {
    expect(namedPaths(`pnpm exec vitest run ${CARD_TEST} -t a/b`)).toEqual([CARD_TEST])
    expect(namedPaths(`pnpm exec vitest run ./${CARD_TEST} --dir=foo/bar/ > out/log.txt`)).toEqual([CARD_TEST, 'foo/bar'])
    expect(namedPaths(`! pnpm exec vitest run ${CARD_TEST} ~/x/y /abs/z $HOME/w`)).toEqual([CARD_TEST])
  })

  it('a vitest run that names only absent paths and no test file finds no test', () => {
    expect(findsNoTest('pnpm exec vitest run tests/newdir', () => true)).toBe(true)
    expect(findsNoTest(`pnpm exec vitest run ${CARD_TEST}`, () => true)).toBe(false)
    expect(findsNoTest('test -d tests/newdir', () => true)).toBe(false)
    expect(testRunnerOf('pnpm exec vitest run tests/y')?.retargeted(`! pnpm exec vitest run tests/y -t x`, [CARD_TEST])).toBe(`pnpm exec vitest run ${CARD_TEST}`)
  })

  it('a path is within a scope entry, its glob root or a directory above it', () => {
    expect(withinScope(CARD_TEST, ['tests/y/**'])).toBe(true)
    expect(withinScope('tests/y', [CARD_TEST])).toBe(true)
    expect(withinScope('tests/yz/a.test.ts', ['tests/y/'])).toBe(false)
  })
})
