import { describe, expect, it } from 'vitest'
import { parseMutationFile, parseMutationLine } from '../src/commands/mutate/lines.js'

describe('a mutation line', () => {
  it('reads the id, the file, the literal find and replace, the named test and the message', () => {
    expect(parseMutationLine('M1b | src/x.ts | find: `a | b` → `a || b` | red: tests/x.test.ts › outer › inner › title | `expected 1`')).toEqual({
      id: 'M1b',
      line: {
        id: 'M1b',
        file: 'src/x.ts',
        change: { kind: 'find', find: 'a | b', replace: 'a || b' },
        prediction: { kind: 'test', file: 'tests/x.test.ts', titles: ['outer', 'inner', 'title'] },
        message: 'expected 1',
      },
    })
  })

  it('takes a literal holding a backtick when a longer fence delimits it', () => {
    const parsed = parseMutationLine('M2 | src/x.ts | find: ``a `b` c`` → `d` | red: green')
    expect(parsed).toMatchObject({ line: { change: { find: 'a `b` c', replace: 'd' }, prediction: { kind: 'green' }, message: null } })
  })

  it('reads an edit: line as prose, which apply refuses', () => {
    expect(parseMutationLine('M3 | src/x.ts | edit: make it inclusive | red: green')).toMatchObject({ line: { change: { kind: 'edit', prose: 'make it inclusive' } } })
  })

  it('names what is wrong with a malformed line', () => {
    expect(parseMutationLine('M4 | src/x.ts | find: `a` | red: green')).toEqual({ id: 'M4', malformed: 'the find field is not `find: `old` → `new``' })
    expect(parseMutationLine('M5 | src/x.ts | find: `a` → `b` | red: tests/x.test.ts')).toMatchObject({ id: 'M5', malformed: expect.stringContaining('names no test') })
    expect(parseMutationLine('M6 | src/x.ts | find: `a → `b` | red: green')).toMatchObject({ id: 'M6', malformed: expect.any(String) })
  })

  it('reads only the lines that start with M', () => {
    expect(parseMutationFile('# Brief\n\n- M1 is prose\nM1 | a.ts | find: `a` → `b` | red: green\n').map(parsed => parsed.id)).toEqual(['M1'])
  })
})
