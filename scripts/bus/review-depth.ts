import type { Prediction } from '../morse/rules.js'
import type { Lease } from './lease.js'

export const REVIEW_DEPTHS = ['full', 'diff'] as const

export type ReviewDepth = typeof REVIEW_DEPTHS[number]

export const FULL_DEPTH_RULE = 'instructions'

export type ReviewPlan
  = | { depth: 'full', why: string, prediction: Prediction | null }
    | { depth: 'diff', why: string, since: string, findings: string[] }

export interface EarlierVerdict {
  head: string
  verdict: string
  findings: string[]
}

export interface DepthSources {
  base: (head: string) => string
  changed: (from: string, to: string) => string[]
  predict: (task: string, base: string, head: string) => Prediction
}

export type ReviewPlanner = (lease: Lease, earlier: EarlierVerdict | null) => ReviewPlan

export function fullReview(why: string, prediction: Prediction | null = null): ReviewPlan {
  return { depth: 'full', why, prediction }
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
  return { depth: 'diff', why, since: earlier.head, findings: earlier.findings }
}

function firstReview(lease: Lease, head: string, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const prediction = sources.predict(lease.taskKey, base, head)
  const rule = `MORSE predicts ${prediction.verdict} by rule ${prediction.rule}`
  if (prediction.rule === FULL_DEPTH_RULE)
    return fullReview(rule, prediction)
  return { depth: 'diff', why: `${rule}, and only the ${FULL_DEPTH_RULE} rule takes the full review`, since: base, findings: [] }
}

export function planReview(lease: Lease, earlier: EarlierVerdict | null, sources: DepthSources): ReviewPlan {
  if (lease.head === null)
    return fullReview('the lease names no head')
  return earlier === null ? firstReview(lease, lease.head, sources) : reReview(lease.head, earlier, sources)
}
