import { messageOf } from '../../core/errors.js'

export interface MainRun {
  databaseId: number
  headSha: string
}

export type LatestMainRuns
  = | { kind: 'read', value: MainRun[] }
    | { kind: 'failed', reason: string }

export type MeasuredDrift
  = | { kind: 'unread', why: string }
    | { kind: 'fresh', share: number, line: number }
    | { kind: 'stale', share: number, driftedSeconds: number, longestShardSeconds: number, drifted: number, table: string }

export interface RecomputeFigures {
  run: number
  head: string
  share: number
  driftedSeconds: number
  longestShardSeconds: number
  drifted: number
}

export interface RecomputeLedger {
  decided: (run: number) => boolean
  openCard: () => number | null
  admit: (figures: RecomputeFigures, table: string) => number
  unread: (run: number, why: string) => void
}

export interface WeightsDriftParts {
  latestRuns: () => LatestMainRuns
  measure: (run: MainRun) => MeasuredDrift
  ledger: RecomputeLedger
}

export type DriftOutcome
  = | { kind: 'admitted', run: number, card: number, share: number }
    | { kind: 'fresh', run: number, share: number, line: number }
    | { kind: 'held', run: number, card: number }
    | { kind: 'seen', run: number }
    | { kind: 'unread', run: number | null, why: string }
    | { kind: 'no-run' }

export interface DriftWatch {
  watch: () => DriftOutcome
}

const percent = (share: number, digits: number): string => (share * 100).toFixed(digits)

export function driftLine(outcome: DriftOutcome): string {
  switch (outcome.kind) {
    case 'admitted':
      return `test weights: run ${outcome.run} drifted ${percent(outcome.share, 1)}% of the longest shard; recompute card #${outcome.card} admitted`
    case 'fresh':
      return `test weights: run ${outcome.run} drifted ${percent(outcome.share, 1)}% of the longest shard, within the ${percent(outcome.line, 0)}% line`
    case 'held':
      return `test weights: run ${outcome.run} not measured while recompute card #${outcome.card} is unmerged`
    case 'seen':
      return `test weights: run ${outcome.run} was measured already`
    case 'unread':
      return `test weights: nothing admitted: ${outcome.why}`
    case 'no-run':
      return 'test weights: no successful CI run on main yet'
  }
}

export class WeightsDriftWatch implements DriftWatch {
  private readonly checked = new Set<number>()

  constructor(private readonly parts: WeightsDriftParts) {}

  watch(): DriftOutcome {
    const listed = this.parts.latestRuns()
    if (listed.kind === 'failed')
      return { kind: 'unread', run: null, why: `the successful CI runs on main could not be listed: ${listed.reason}` }
    const run = listed.value[0]
    if (run === undefined)
      return { kind: 'no-run' }
    if (this.checked.has(run.databaseId) || this.parts.ledger.decided(run.databaseId))
      return { kind: 'seen', run: run.databaseId }
    const open = this.parts.ledger.openCard()
    if (open !== null)
      return { kind: 'held', run: run.databaseId, card: open }
    const outcome = this.outcomeOf(run)
    if (outcome.kind === 'unread')
      this.parts.ledger.unread(run.databaseId, outcome.why)
    this.checked.add(run.databaseId)
    return outcome
  }

  private outcomeOf(run: MainRun): DriftOutcome {
    try {
      const drift = this.parts.measure(run)
      switch (drift.kind) {
        case 'unread':
          return { kind: 'unread', run: run.databaseId, why: drift.why }
        case 'fresh':
          return { kind: 'fresh', run: run.databaseId, share: drift.share, line: drift.line }
        case 'stale': {
          const card = this.parts.ledger.admit({ run: run.databaseId, head: run.headSha, share: drift.share, driftedSeconds: drift.driftedSeconds, longestShardSeconds: drift.longestShardSeconds, drifted: drift.drifted }, drift.table)
          return { kind: 'admitted', run: run.databaseId, card, share: drift.share }
        }
      }
    }
    catch (error) {
      return { kind: 'unread', run: run.databaseId, why: `the drift of run ${run.databaseId} was not admitted: ${messageOf(error)}` }
    }
  }
}
