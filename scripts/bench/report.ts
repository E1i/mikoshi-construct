import type { Capture } from './capture.js'
import { usability } from './usable.js'

export interface Summary {
  invocations: number
  usableDesigns: number
  parsedButUnusable: number
  didNotParse: number
  shortfalls: Record<string, number>
  failures: Record<string, number>
  stopReasons: Record<string, number>
  withControlCharacters: number
  byAttempt: Record<string, { usable: number, of: number }>
}

function tally(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {})
}

export function verdictOf(capture: Capture): { parses: boolean, usable: boolean, shortfalls: string[] } {
  if (!capture.facts.parses)
    return { parses: false, usable: false, shortfalls: [] }
  const verdict = usability(JSON.parse(capture.raw))
  return { parses: true, usable: verdict.usable, shortfalls: verdict.shortfalls }
}

export function summarize(captures: Capture[]): Summary {
  const verdicts = captures.map(capture => ({ capture, ...verdictOf(capture) }))
  const attempts = [...new Set(captures.map(capture => capture.attempt))].sort((left, right) => left - right)

  return {
    invocations: captures.length,
    usableDesigns: verdicts.filter(entry => entry.usable).length,
    parsedButUnusable: verdicts.filter(entry => entry.parses && !entry.usable).length,
    didNotParse: verdicts.filter(entry => !entry.parses).length,
    shortfalls: tally(verdicts.flatMap(entry => entry.shortfalls.map(shortfall => shortfall.split(' is ')[0].split(' names ')[0]))),
    failures: tally(verdicts.filter(entry => !entry.parses).map(entry => entry.capture.facts.failure ?? 'unnamed')),
    stopReasons: tally(captures.map(capture => capture.stopReason ?? 'unrecorded')),
    withControlCharacters: captures.filter(capture => capture.facts.controlCharacters.length > 0).length,
    byAttempt: Object.fromEntries(attempts.map(attempt => [
      String(attempt),
      {
        usable: verdicts.filter(entry => entry.capture.attempt === attempt && entry.usable).length,
        of: verdicts.filter(entry => entry.capture.attempt === attempt).length,
      },
    ])),
  }
}
