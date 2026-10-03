import type { Theme } from './theme.js'
import { createColors } from 'picocolors'

export const SIGNAL_FIELDS = ['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'] as const

export type SignalField = typeof SIGNAL_FIELDS[number]

export type Signal = Record<SignalField, string>

export type Tone = 'red' | 'yellow' | 'grey' | 'purple'

export type Paint = (tone: Tone | undefined, text: string) => string

export interface SignalStyle {
  ascii: boolean
  paint: Paint
}

const TITLE_RULE_WIDTH = 64
const TITLE_LEAD = 4
const LABEL_WIDTH = Math.max(...SIGNAL_FIELDS.map(field => field.length))
const GLYPHS = {
  unicode: { rule: '─', separator: '│' },
  ascii: { rule: '-', separator: '|' },
} as const

export function colourFor(isTTY: boolean | undefined, noColor: string | undefined): boolean {
  return isTTY === true && (noColor === undefined || noColor === '')
}

export function tonePainter(colour: boolean): Paint {
  const colours = createColors(colour)
  const byTone: Record<Tone, (text: string) => string> = {
    red: colours.red,
    yellow: colours.yellow,
    grey: colours.gray,
    purple: colours.magenta,
  }
  return (tone, text) => tone === undefined ? text : byTone[tone](text)
}

export function themePainter(theme: Theme): Paint {
  const byTone: Record<Tone, (text: string) => string> = {
    red: theme.primary,
    yellow: theme.warn,
    grey: theme.dim,
    purple: theme.detected,
  }
  return (tone, text) => tone === undefined ? text : byTone[tone](text)
}

export function styleFor(colour: boolean): SignalStyle {
  return { ascii: !colour, paint: tonePainter(colour) }
}

export function terminalStyle(isTTY: boolean | undefined, noColor: string | undefined): SignalStyle {
  return styleFor(colourFor(isTTY, noColor))
}

export const PLAIN_STYLE = styleFor(false)

export function renderSignal(title: string, signal: Signal, style: SignalStyle, tone?: Tone): string[] {
  const { rule, separator } = style.ascii ? GLYPHS.ascii : GLYPHS.unicode
  const tail = Math.max(TITLE_LEAD, TITLE_RULE_WIDTH - title.length - TITLE_LEAD - 2)
  return [
    `${rule.repeat(TITLE_LEAD)} ${title} ${rule.repeat(tail)}`,
    ...SIGNAL_FIELDS.map(field => `${field.padEnd(LABEL_WIDTH)} ${separator} ${field === 'RESULT' ? style.paint(tone, signal[field]) : signal[field]}`),
  ]
}
