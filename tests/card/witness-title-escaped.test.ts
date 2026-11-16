import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fieldCommand } from '../../src/card/witness-fields.js'

const RUN = 'pnpm exec vitest run tests/a.test.ts'

function patternOf(title: string): string {
  const command = fieldCommand({ run: RUN, test: title })
  const argument = command.slice(`${RUN} -t `.length)
  const echoed = spawnSync('bash', ['-c', `printf %s ${argument}`], { encoding: 'utf8' })
  expect(echoed.status).toBe(0)
  return echoed.stdout
}

const TITLES = [
  'the bus restart waits [needs ps]',
  'a fold (with parentheses) holds',
  'one.dot and one+plus',
  'is it there?',
  'it\'s the owner\'s word',
  'a ^caret, $dollar, *star, {brace}, |pipe and \\backslash',
]

const NEIGHBOURS: Record<string, string> = {
  'the bus restart waits [needs ps]': 'the bus restart waits n',
  'a fold (with parentheses) holds': 'a fold with parentheses holds',
  'one.dot and one+plus': 'oneXdot and oneeplus',
  'is it there?': 'is it ther',
  'it\'s the owner\'s word': 'its the owners word',
  'a ^caret, $dollar, *star, {brace}, |pipe and \\backslash': 'a caret, dollar, star, brace, pipe and backslash',
}

describe('fieldCommand hands vitest -t a pattern that matches the title literally', () => {
  it.each(TITLES)('%s', (title) => {
    const pattern = new RegExp(patternOf(title))
    expect(pattern.test(title)).toBe(true)
    expect(pattern.test(NEIGHBOURS[title]!)).toBe(false)
  })

  it('a title with no metacharacter passes through as it is, and a null title adds no -t', () => {
    expect(fieldCommand({ run: RUN, test: 'the thing' })).toBe(`${RUN} -t 'the thing'`)
    expect(fieldCommand({ run: RUN, test: null })).toBe(RUN)
  })

  it('the [needs ps] title is no character class', () => {
    expect(fieldCommand({ run: RUN, test: 'waits [needs ps]' })).toBe(`${RUN} -t 'waits \\[needs ps\\]'`)
    expect(new RegExp(patternOf('waits [needs ps]')).test('waits s')).toBe(false)
  })
})
