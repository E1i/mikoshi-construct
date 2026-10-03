import type { Signal } from '../../src/ui/signal.js'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { renderSignal, SIGNAL_FIELDS, terminalStyle, themePainter, tonePainter } from '../../src/ui/signal.js'
import { resolveTheme } from '../../src/ui/theme.js'

const SIGNAL: Signal = {
  CONTRACT: 'implement · cheap · owner · law not recorded in the journal',
  EXPECT: 'expect none — n=2 for effort low',
  ACTION: 'task:start signal-blocks #135',
  RESULT: 'start line written to https://example.com/journal',
}

const COLOUR = { ascii: false, paint: tonePainter(true) }
const PLAIN = { ascii: true, paint: tonePainter(false) }

function label(line: string): string {
  return stripVTControlCharacters(line).split(/\s/)[0]!
}

describe('the signal block: CONTRACT, EXPECT, ACTION, RESULT', () => {
  it('prints a title rule and the four fields in that order, one line each', () => {
    const lines = renderSignal('#135 signal-blocks', SIGNAL, PLAIN)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('#135 signal-blocks')
    expect(lines.slice(1).map(label)).toEqual([...SIGNAL_FIELDS])
    expect(SIGNAL_FIELDS).toEqual(['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'])
  })

  it('aligns every value at one column, whatever the label', () => {
    const lines = renderSignal('t', SIGNAL, PLAIN).slice(1)
    const starts = lines.map((line, index) => line.indexOf(SIGNAL[SIGNAL_FIELDS[index]!]))
    expect(new Set(starts).size).toBe(1)
  })

  it('without colour keeps every field and every value, byte for byte the coloured block stripped of escapes, separators aside', () => {
    const coloured = renderSignal('t', SIGNAL, COLOUR, 'red').map(line => stripVTControlCharacters(line))
    const plain = renderSignal('t', SIGNAL, PLAIN, 'red')
    expect(plain.some(line => line.includes('\u001B'))).toBe(false)
    expect(renderSignal('t', SIGNAL, COLOUR, 'red').some(line => line.includes('\u001B'))).toBe(true)
    for (const field of SIGNAL_FIELDS) {
      expect(coloured.some(line => line.startsWith(field) && line.endsWith(SIGNAL[field]))).toBe(true)
      expect(plain.some(line => line.startsWith(field) && line.endsWith(SIGNAL[field]))).toBe(true)
    }
  })

  it('in its ASCII-safe form draws its own structure from ASCII only and leaves the values as they are', () => {
    const lines = renderSignal('t', SIGNAL, PLAIN)
    const structure = lines.map((line, index) => index === 0 ? line.replace('t', '') : line.replace(SIGNAL[SIGNAL_FIELDS[index - 1]!], ''))
    expect(structure.join('')).toMatch(/^[\x20-\x7E]*$/)
    expect(lines[2]!.endsWith(SIGNAL.EXPECT)).toBe(true)
  })

  it('carries an EXPECT none line through unchanged', () => {
    const none = { ...SIGNAL, EXPECT: 'expect none — n=3 for effort medium' }
    expect(renderSignal('t', none, PLAIN)[2]).toMatch(/^EXPECT +\| expect none — n=3 for effort medium$/)
  })

  it('colours only the RESULT value, and only when a tone is given', () => {
    const lines = renderSignal('t', SIGNAL, COLOUR, 'red')
    expect(lines.slice(0, 4).some(line => line.includes('\u001B'))).toBe(false)
    expect(lines[4]).toContain(tonePainter(true)('red', SIGNAL.RESULT))
    expect(renderSignal('t', SIGNAL, COLOUR).some(line => line.includes('\u001B'))).toBe(false)
  })
})

describe('the terminal style: colour only on a TTY with NO_COLOR unset, ASCII-safe otherwise', () => {
  it.each([
    { name: 'a TTY with NO_COLOR unset', isTTY: true, noColor: undefined, colour: true },
    { name: 'a TTY with NO_COLOR=1', isTTY: true, noColor: '1', colour: false },
    { name: 'a pipe', isTTY: undefined, noColor: undefined, colour: false },
    { name: 'a non-TTY stream', isTTY: false, noColor: undefined, colour: false },
  ])('$name', ({ isTTY, noColor, colour }) => {
    const style = terminalStyle(isTTY, noColor)
    expect(style.ascii).toBe(!colour)
    expect(style.paint('red', 'x') !== 'x').toBe(colour)
  })
})

describe('the theme painter: the product paints a tone from its theme', () => {
  it('paints nothing under the plain theme', () => {
    const paint = themePainter(resolveTheme({ plain: true }))
    for (const tone of ['red', 'yellow', 'grey', 'purple'] as const)
      expect(paint(tone, 'x')).toBe('x')
    expect(paint(undefined, 'x')).toBe('x')
  })
})
