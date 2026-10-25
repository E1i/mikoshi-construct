import type { Lease } from '../../core/lease.js'
import type { Prediction, RuleId } from '../../policy/morse/rules.js'
import { runsCover } from '../../../src/card/covering-tests.js'
import { PREFIX_SUFFIX } from '../../../src/card/task-file.js'

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

function touchFindings(cardId: number, files: readonly string[], sources: DepthSources): string[] {
  const scope = sources.scope(cardId)
  if (scope === null)
    return [`the touches of card #${cardId} could not be read, so no changed file is shown inside them`]
  const { touches, runs } = scope
  return files.filter(file => !withinTouches(file, touches) && !runsCover(file, runs)).map(file => `${file} is outside the touches of card #${cardId} (${touches.join(', ')})`)
}

function firstReview(lease: Lease, head: string, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const { prediction, files } = sources.predict(lease.taskKey, base, head)
  const rule = `MORSE predicts ${prediction.verdict} by rule ${prediction.rule}`
  if (prediction.rule === FULL_DEPTH_RULE)
    return fullReview(rule, prediction)
  return { depth: 'diff', round: 'first', why: `${rule}, and only the ${FULL_DEPTH_RULE} rule takes the full review`, since: base, touchFindings: touchFindings(lease.cardId, files, sources) }
}

export function planReview(lease: Lease, earlier: EarlierVerdict | null, sources: DepthSources): ReviewPlan {
  if (lease.head === null)
    return fullReview('the lease names no head')
  return earlier === null ? firstReview(lease, lease.head, sources) : reReview(lease.head, earlier, sources)
}
