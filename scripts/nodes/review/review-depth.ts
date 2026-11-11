import type { Lease } from '../../core/lease.js'
import type { Prediction, RuleId } from '../../policy/morse/rules.js'
import type { CompositionRecord, FollowingReach } from '../../policy/touch-scope.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { TestCoverage } from '../../../src/card/covering-tests.js'
import { loadCompositionModels } from '../../composition/files.js'
import { COMPOSITION_ROOT, followsTouches, isTestOrGenerated, neverFollows, runsCover, withinTouches } from '../../policy/touch-scope.js'
import { gitIn } from '../../ports/worktree.js'

export { cardRiskOf } from '../../../src/commands/intake/check.js'

export const REVIEW_DEPTHS = ['full', 'diff'] as const

export type ReviewDepth = typeof REVIEW_DEPTHS[number]

export const FULL_DEPTH_RULE: RuleId = 'instructions'

export type ReviewPlan
  = | { depth: 'full', why: string, prediction: Prediction | null }
    | { depth: 'diff', round: 'first', why: string, since: string, touchFindings: string[], touchNotes: string[] }
    | { depth: 'diff', round: 'again', why: string, since: string, reviewed: string, findings: string[] }

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
  creates: string[]
  runs: string[]
  fullReading?: string
}

function fullReadingLine(why: string): string {
  return `Runs read in full: ${why}, so only the paths the card names count as its runs`
}

export type ReviewPlanner = (lease: Lease, earlier: EarlierVerdict | null) => ReviewPlan

export function fullReview(why: string, prediction: Prediction | null = null): ReviewPlan {
  return { depth: 'full', why, prediction }
}

function namedByFindings(file: string, findings: readonly string[]): boolean {
  return findings.some(finding => finding.includes(file))
}

function reReview(head: string, earlier: EarlierVerdict, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const range = `${earlier.head}..${head}`
  const ofTheCard = new Set(sources.changed(base, head))
  const outside = sources.changed(earlier.head, head).filter(file => ofTheCard.has(file) && !namedByFindings(file, earlier.findings))
  const why = outside.length > 0
    ? `${range} also changes ${outside.join(', ')}, which no finding of the earlier ${earlier.verdict} verdict names`
    : `${range} changes only files the earlier ${earlier.verdict} verdict's findings name`
  return { depth: 'diff', round: 'again', why, since: base, reviewed: earlier.head, findings: earlier.findings }
}

function compositionRecords(): CompositionRecord[] {
  try {
    return loadCompositionModels(path.join(process.cwd(), COMPOSITION_ROOT)).map(loaded => loaded.model)
  }
  catch {
    return []
  }
}

function orNull(read: () => string): string | null {
  try {
    return read()
  }
  catch {
    return null
  }
}

function coverageAt(head: string, changed: readonly string[]): TestCoverage {
  const repository = process.cwd()
  const listed = (): string => orNull(() => gitIn(repository, ['ls-tree', '-r', '--name-only', '-z', head])) ?? ''
  return new TestCoverage(
    () => listed().split('\0').filter(file => file !== ''),
    file => orNull(() => changed.includes(file) ? gitIn(repository, ['show', `${head}:${file}`]) : readFileSync(path.join(repository, file), 'utf8')),
  )
}

function stillOutside(files: readonly string[], reach: FollowingReach, coverage: TestCoverage): string[] {
  if (files.length === 0)
    return []
  const covering = new Set(coverage.of(reach.touches))
  return files.filter(file => neverFollows(file, reach) || !(covering.has(file) || followsTouches(file, reach)))
}

type TouchReading = Pick<Extract<ReviewPlan, { round: 'first' }>, 'touchFindings' | 'touchNotes'>

function touchReading(cardId: number, head: string, { files, added }: Predicted, sources: DepthSources): TouchReading {
  const scope = sources.scope(cardId)
  if (scope === null)
    return { touchFindings: [`the touches of card #${cardId} could not be read, so no changed file is shown inside them`], touchNotes: [] }
  const { touches, creates, runs, fullReading } = scope
  const reach = { touches, added: new Set(added), compositionRecords: compositionRecords() }
  const readingNote = fullReading === undefined ? '' : `; ${fullReadingLine(fullReading)}`
  const named = files.filter(file => !withinTouches(file, touches) && !creates.includes(file) && !runsCover(file, runs))
  const outside = stillOutside(named, reach, coverageAt(head, files))
  const line = (file: string): string => `${file} is outside the touches of card #${cardId} (${touches.join(', ')})${readingNote}`
  return { touchFindings: outside.map(line), touchNotes: named.filter(file => !outside.includes(file) && isTestOrGenerated(file)).map(line) }
}

function firstReview(lease: Lease, head: string, sources: DepthSources): ReviewPlan {
  const base = sources.base(head)
  const predicted = sources.predict(lease.taskKey, base, head)
  const { prediction } = predicted
  const rule = `MORSE predicts ${prediction.verdict} by rule ${prediction.rule}`
  if (prediction.rule === FULL_DEPTH_RULE)
    return fullReview(rule, prediction)
  return { depth: 'diff', round: 'first', why: `${rule}, and only the ${FULL_DEPTH_RULE} rule takes the full review`, since: base, ...touchReading(lease.cardId, head, predicted, sources) }
}

export function planReview(lease: Lease, earlier: EarlierVerdict | null, sources: DepthSources): ReviewPlan {
  if (lease.head === null)
    return fullReview('the lease names no head')
  return earlier === null ? firstReview(lease, lease.head, sources) : reReview(lease.head, earlier, sources)
}
