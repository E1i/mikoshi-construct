import type { Tone } from '../../src/ui/signal.js'
import type { Situation } from './next.js'
import type { Row } from './row.js'

export const TONES: Record<Tone, string> = {
  red: 'waits for Eli or the window',
  yellow: 'a Ghost or a hand-started ladder is running',
  grey: 'merged',
  purple: 'a brief or a subagent',
}

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
  'window-closed': 'red',
  'window-handoff': 'red',
}

export function toneOf(row: Row): Tone | undefined {
  if (row.path === 'cheap' && row.next.situation === 'pr')
    return 'purple'
  return TONE_BY_SITUATION[row.next.situation]
}

export function legendLines(): string[] {
  const width = Math.max(...Object.keys(TONES).map(tone => tone.length))
  return [
    'colours, on the STAGE and NEXT cells only, when stdout is a TTY and NO_COLOR is unset:',
    ...Object.entries(TONES).map(([tone, meaning]) => `  ${tone.padEnd(width)}  ${meaning}`),
  ]
}
