import type { Prediction } from '../morse/rules.js'
import type { Lease } from './lease.js'
import { PREFIX_SUFFIX } from '../../src/card/task-file.js'

export const REVIEW_DEPTHS = ['cheap', 'full', 'diff'] as const

export type ReviewDepth = typeof REVIEW_DEPTHS[number]

export type ReviewPlan
  = | { depth: 'full', why: string, prediction: Prediction | null }
    | { depth: 'cheap', why: string, base: string }
    | { depth: 'diff', why: string, since: string, findings: string[] }

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
  touches: (cardId: number) => string[] | null
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
  if (outside.length > 0)
    return fullReview(`${range} changes ${outside.join(', ')}, which no finding of the earlier ${earlier.verdict} verdict names`)
  return { depth: 'diff', why: `${range} changes only files the earlier ${earlier.verdict} verdict's findings name`, since: earlier.head, findings: earlier.findings }
}

function firstReview(lease: Lease, head: string, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const { prediction, files } = sources.predict(lease.taskKey, base, head)
  const rule = `MORSE predicts ${prediction.verdict} by rule ${prediction.rule}`
  if (prediction.verdict === 'ladder')
    return fullReview(rule, prediction)
  const touches = sources.touches(lease.cardId)
  if (touches === null)
    return fullReview(`${rule}, but the touches of card #${lease.cardId} could not be read`, prediction)
  const outside = files.filter(file => !withinTouches(file, touches))
  if (outside.length > 0)
    return fullReview(`${rule}, but ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the card's touches`, prediction)
  return { depth: 'cheap', why: `${rule} and every changed file is inside the card's touches`, base }
}

export function planReview(lease: Lease, earlier: EarlierVerdict | null, sources: DepthSources): ReviewPlan {
  if (lease.head === null)
    return fullReview('the lease names no head')
  return earlier === null ? firstReview(lease, lease.head, sources) : reReview(lease.head, earlier, sources)
}
