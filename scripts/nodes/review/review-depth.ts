import type { CompositionRecord } from '../../../src/commands/intake/check.js'
import type { CheckCatalog } from '../../ci/card-runs.js'
import type { Lease } from '../../core/lease.js'
import type { Prediction, RuleId } from '../../policy/morse/rules.js'
import path from 'node:path'
import process from 'node:process'
import { runsCover } from '../../../src/card/covering-tests.js'
import { PREFIX_SUFFIX } from '../../../src/card/task-file.js'
import { COMPOSITION_ROOT, followsTouches } from '../../../src/commands/intake/check.js'
import { cardRunsOf } from '../../ci/card-runs.js'
import { loadCompositionModels } from '../../composition/files.js'

export const REVIEW_DEPTHS = ['full', 'diff'] as const

export type ReviewDepth = typeof REVIEW_DEPTHS[number]

export const FULL_DEPTH_RULE: RuleId = 'instructions'

export type ReviewPlan
  = | { depth: 'full', why: string, prediction: Prediction | null }
    | { depth: 'diff', round: 'first', why: string, since: string, touchFindings: string[] }
    | { depth: 'diff', round: 'again', why: string, since: string, findings: string[] }

export interface EarlierVerdict {
  head: string
  verdict: string
  findings: string[]
}

export interface Predicted {
  prediction: Prediction
  files: string[]
  added: string[]
}

export interface DepthSources {
  base: (head: string) => string
  changed: (from: string, to: string) => string[]
  predict: (task: string, base: string, head: string) => Predicted
  scope: (cardId: number) => CardScope | null
}

export interface CardScope {
  touches: string[]
  runs: string[]
  fullReading?: string
}

export function cardScopeOf(touches: string[], named: string[], masks: string[], catalog: CheckCatalog): CardScope {
  const reading = cardRunsOf({ touches, runs: named, masks }, catalog)
  return 'full' in reading
    ? { touches, runs: named, fullReading: reading.why }
    : { touches, runs: [...new Set([...named, ...reading.tests])] }
}

function fullReadingLine(why: string): string {
  return `Runs read in full: ${why}, so only the paths the card names count as its runs`
}

export type ReviewPlanner = (lease: Lease, earlier: EarlierVerdict | null) => ReviewPlan

export function fullReview(why: string, prediction: Prediction | null = null): ReviewPlan {
  return { depth: 'full', why, prediction }
}

export function withinTouches(file: string, touches: readonly string[]): boolean {
  return touches.some(entry => entry.endsWith(PREFIX_SUFFIX)
    ? file.startsWith(`${entry.slice(0, -PREFIX_SUFFIX.length)}/`)
    : file === entry)
}

function namedByFindings(file: string, findings: readonly string[]): boolean {
  return findings.some(finding => finding.includes(file))
}

function reReview(head: string, earlier: EarlierVerdict, sources: DepthSources): ReviewPlan {
  const range = `${earlier.head}..${head}`
  const outside = sources.changed(earlier.head, head).filter(file => !namedByFindings(file, earlier.findings))
  const why = outside.length > 0
    ? `${range} also changes ${outside.join(', ')}, which no finding of the earlier ${earlier.verdict} verdict names`
    : `${range} changes only files the earlier ${earlier.verdict} verdict's findings name`
  return { depth: 'diff', round: 'again', why, since: earlier.head, findings: earlier.findings }
}

function compositionRecords(): CompositionRecord[] {
  try {
    return loadCompositionModels(path.join(process.cwd(), COMPOSITION_ROOT)).map(loaded => loaded.model)
  }
  catch {
    return []
  }
}

function touchFindings(cardId: number, { files, added }: Predicted, sources: DepthSources): string[] {
  const scope = sources.scope(cardId)
  if (scope === null)
    return [`the touches of card #${cardId} could not be read, so no changed file is shown inside them`]
  const { touches, runs, fullReading } = scope
  const reach = { touches, added: new Set(added), compositionRecords: compositionRecords() }
  const readingNote = fullReading === undefined ? '' : `; ${fullReadingLine(fullReading)}`
  return files.filter(file => !withinTouches(file, touches) && !runsCover(file, runs) && !followsTouches(file, reach)).map(file => `${file} is outside the touches of card #${cardId} (${touches.join(', ')})${readingNote}`)
}

function firstReview(lease: Lease, head: string, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const predicted = sources.predict(lease.taskKey, base, head)
  const { prediction } = predicted
  const rule = `MORSE predicts ${prediction.verdict} by rule ${prediction.rule}`
  if (prediction.rule === FULL_DEPTH_RULE)
    return fullReview(rule, prediction)
  return { depth: 'diff', round: 'first', why: `${rule}, and only the ${FULL_DEPTH_RULE} rule takes the full review`, since: base, touchFindings: touchFindings(lease.cardId, predicted, sources) }
}

export function planReview(lease: Lease, earlier: EarlierVerdict | null, sources: DepthSources): ReviewPlan {
  if (lease.head === null)
    return fullReview('the lease names no head')
  return earlier === null ? firstReview(lease, lease.head, sources) : reReview(lease.head, earlier, sources)
}
