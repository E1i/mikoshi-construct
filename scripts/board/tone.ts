import type { Situation } from './next.js'
import type { Row } from './row.js'
import { createColors } from 'picocolors'

export const TONES = {
  red: 'waits for Eli or the window',
  yellow: 'a Ghost or a hand-started ladder is running',
  grey: 'merged',
  purple: 'a brief or a subagent',
} as const

export type Tone = keyof typeof TONES

export type Paint = (tone: Tone | undefined, text: string) => string

const TONE_BY_SITUATION: Record<Situation, Tone | undefined> = {
  'brief': 'purple',
  'approval': 'red',
  'launch': 'red',
  'ghost-running': 'yellow',
  'hand-ladder-running': 'yellow',
  'verdict': 'red',
  'new-attempt': 'red',
  'pr': 'red',
  'pr-unknown': undefined,
  'pr-closed': 'red',
  'ci': undefined,
  'ci-red': 'red',
  'ci-unknown': undefined,
  'owner-merge': 'red',
  'auto-merge': 'red',
  'merge-unknown': 'red',
  'merged': 'grey',
  'report': undefined,
  'superseded': undefined,
}

export function toneOf(row: Row): Tone | undefined {
  if (row.path === 'cheap' && row.next.situation === 'pr')
    return 'purple'
  return TONE_BY_SITUATION[row.next.situation]
}

export function colourFor(isTTY: boolean | undefined, noColor: string | undefined): boolean {
  return isTTY === true && (noColor === undefined || noColor === '')
}

export function painter(colour: boolean): Paint {
  const colours = createColors(colour)
  const byTone: Record<Tone, (text: string) => string> = {
    red: colours.red,
    yellow: colours.yellow,
    grey: colours.gray,
    purple: colours.magenta,
  }
  return (tone, text) => tone === undefined ? text : byTone[tone](text)
}

export function legendLines(): string[] {
  const width = Math.max(...Object.keys(TONES).map(tone => tone.length))
  return [
    'colours, on the STAGE and NEXT cells only, when stdout is a TTY and NO_COLOR is unset:',
    ...Object.entries(TONES).map(([tone, meaning]) => `  ${tone.padEnd(width)}  ${meaning}`),
  ]
}
