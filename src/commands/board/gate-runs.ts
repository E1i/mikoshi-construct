export type GateRunsLine = (role: string, task: string, detail: string) => string

export const GATE_RUNS_SHOWN_HOURS = 24
export const SMALL_SAMPLE = 10
const HOUR_MS = 60 * 60_000
const PERCENT = 100
const GATE_RUNS_ROLE = 'gate-runs'
const ROUNDS_TASK = 'rounds'
const SMALL_SAMPLE_MARK = 'small sample'

export const BOARD_GATE_SOURCES = ['gate', 'prepush'] as const
export type BoardGateSource = typeof BOARD_GATE_SOURCES[number]

export interface GateRunRow {
  at: string
  source: BoardGateSource
  full: boolean
  seconds: number
  round: string
}

export interface GateStats {
  runs: number
  fullShare: number
  medianSeconds: number | null
  small: boolean
}

export interface RoundTotals {
  rounds: number
  medianSeconds: number | null
  maxSeconds: number | null
}

export interface BoardGateRuns {
  sources: Record<BoardGateSource, GateStats>
  rounds: RoundTotals
}

export interface GateComparison {
  before: GateStats
  after: GateStats
  confirmedSpeedup: boolean
}

function isSource(value: unknown): value is BoardGateSource {
  return BOARD_GATE_SOURCES.includes(value as BoardGateSource)
}

export interface GateRunEvent {
  ts: string | null
  payload: string
}

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function rowOf(row: GateRunEvent & { ts: string }): GateRunRow | null {
  const { source, mode, seconds, round } = payloadOf(row.payload)
  if (!isSource(source) || typeof seconds !== 'number' || (mode !== 'layered' && mode !== 'full'))
    return null
  return { at: row.ts, source, full: mode === 'full', seconds, round: typeof round === 'string' ? round : '' }
}

export function gateRunsShown(events: readonly GateRunEvent[], now: Date): GateRunRow[] {
  const from = now.getTime() - GATE_RUNS_SHOWN_HOURS * HOUR_MS
  return events.flatMap(({ ts, payload }) => {
    const at = ts === null ? Number.NaN : Date.parse(ts)
    const read = ts === null || !(at >= from && at < now.getTime()) ? null : rowOf({ ts, payload })
    return read === null ? [] : [read]
  })
}

function median(values: readonly number[]): number | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function gateStats(rows: readonly GateRunRow[]): GateStats {
  return {
    runs: rows.length,
    fullShare: rows.length === 0 ? 0 : rows.filter(row => row.full).length / rows.length,
    medianSeconds: median(rows.map(row => row.seconds)),
    small: rows.length < SMALL_SAMPLE,
  }
}

export function roundTotals(rows: readonly GateRunRow[]): RoundTotals {
  const totals = new Map<string, number>()
  for (const row of rows.filter(each => each.round !== ''))
    totals.set(row.round, (totals.get(row.round) ?? 0) + row.seconds)
  const values = [...totals.values()]
  return { rounds: values.length, medianSeconds: median(values), maxSeconds: values.length === 0 ? null : Math.max(...values) }
}

export function boardGateRuns(rows: readonly GateRunRow[]): BoardGateRuns {
  const sources = Object.fromEntries(BOARD_GATE_SOURCES.map(source => [source, gateStats(rows.filter(row => row.source === source))])) as Record<BoardGateSource, GateStats>
  return { sources, rounds: roundTotals(rows) }
}

export function compareGateRuns(rows: readonly GateRunRow[], cut: Date, hours: number = GATE_RUNS_SHOWN_HOURS): Record<BoardGateSource, GateComparison> {
  const from = cut.getTime() - hours * HOUR_MS
  const to = cut.getTime() + hours * HOUR_MS
  const at = (row: GateRunRow): number => Date.parse(row.at)
  return Object.fromEntries(BOARD_GATE_SOURCES.map((source) => {
    const own = rows.filter(row => row.source === source)
    const before = gateStats(own.filter(row => at(row) >= from && at(row) < cut.getTime()))
    const after = gateStats(own.filter(row => at(row) >= cut.getTime() && at(row) < to))
    const faster = before.medianSeconds !== null && after.medianSeconds !== null && after.medianSeconds < before.medianSeconds
    return [source, { before, after, confirmedSpeedup: faster && !before.small && !after.small }]
  })) as Record<BoardGateSource, GateComparison>
}

export function gateRunFacts(events: readonly GateRunEvent[], now: Date): { gateRuns?: GateRunRow[] } {
  const rows = gateRunsShown(events, now)
  return rows.length === 0 ? {} : { gateRuns: rows }
}

export function gateRunsOf(rows: readonly GateRunRow[] | undefined): BoardGateRuns | null {
  return rows === undefined || rows.length === 0 ? null : boardGateRuns(rows)
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} s`
}

function statsLine(stats: GateStats): string {
  const sample = stats.small ? ` · ${SMALL_SAMPLE_MARK}` : ''
  return `${stats.runs} runs in ${GATE_RUNS_SHOWN_HOURS} h · full ${Math.round(stats.fullShare * PERCENT)}% · median ${seconds(stats.medianSeconds)}${sample}`
}

export function gateRunsLines(line: GateRunsLine, runs: BoardGateRuns | null): string[] {
  if (runs === null)
    return []
  const { rounds } = runs
  return [
    ...BOARD_GATE_SOURCES.map(source => line(GATE_RUNS_ROLE, source, statsLine(runs.sources[source]))),
    line(GATE_RUNS_ROLE, ROUNDS_TASK, `${rounds.rounds} rounds · check time per round median ${seconds(rounds.medianSeconds)} · max ${seconds(rounds.maxSeconds)}`),
  ]
}
