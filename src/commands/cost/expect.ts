import type { Lore } from '../../ui/lore.js'
import type { LedgerEntry } from './ledger.js'
import type { Band } from './sample.js'
import type { RunStep, Step } from './steps.js'
import { parseLedgerLine } from './ledger.js'
import { MINIMUM_SAMPLE, recentBand } from './sample.js'
import { STEPS } from './steps.js'

export const EFFORTS = ['low', 'medium', 'high']

const COUNTED_STATUS = 'done'
const SUBSAMPLED_STEP: Step = 'implement'

export interface SampleRow {
  run: string
  effort: string
  tokens: number
  minutes: number
}

export type Subsample = 'sketch' | 'no sketch'

export type StepExpect
  = | { kind: 'forecast', step: Step, effort: string, tokens: number, p25: number, p75: number, minutes: number, n: number, subsample?: Subsample }
    | { kind: 'none', step: Step, effort: string, n: number, subsample?: Subsample }

export interface ImplementSubsample {
  subsample: Subsample
  runs: Set<string>
}

export interface RoleBand {
  role: string
  band: Band
  missing: string | null
}

export interface SampleSource {
  source: string
  lines: string[] | null
}

export type ExpectHead
  = | { kind: 'forecast', tokens: number, p25: number, p75: number, minutes: number, effort: string, n: number }
    | { kind: 'none', reason: string }

export interface ExpectInput {
  ledgers: SampleSource[]
  effort?: string
  taskClass?: string
  runsOfClass?: Set<string> | null
  missing?: string | null
  extraSources?: string[]
  classNotes?: string[]
  runSteps?: Map<string, RunStep[]>
  implement?: (entries: LedgerEntry[]) => { sample: ImplementSubsample, notes: string[] } | null
  roles?: RoleBand[]
}

export interface ExpectResult {
  line: string
  head: ExpectHead
  sources: string[]
  notes: string[]
  rows: SampleRow[]
  steps: StepExpect[]
  contour: string | null
}

export function expectRefusal(expect: boolean, effort: string | undefined, lore: Lore): string | null {
  if (effort === undefined)
    return null
  if (!expect)
    return lore.costEffortNeedsExpect
  return EFFORTS.includes(effort) ? null : lore.costEffortUnknown(effort)
}

export function readLedgerEntries(ledger: SampleSource, notes: string[], lore: Lore): LedgerEntry[] {
  if (ledger.lines === null)
    return []
  const entries: LedgerEntry[] = []
  const rejected = new Map<string, number>()
  for (const text of ledger.lines) {
    const entry = parseLedgerLine(text)
    if (typeof entry === 'string')
      rejected.set(entry, (rejected.get(entry) ?? 0) + 1)
    else
      entries.push(entry)
  }
  if (rejected.size > 0) {
    const count = [...rejected.values()].reduce((sum, value) => sum + value, 0)
    const reasons = [...rejected].map(([reason, times]) => lore.expectRejectedReason(times, reason)).join(', ')
    notes.push(lore.expectRejected(count, ledger.source, reasons))
  }
  return entries
}

function oldestFirst(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => a.at.localeCompare(b.at))
}

function countedRows(entries: LedgerEntry[], effort: string | undefined, runsOfClass: Set<string> | null): SampleRow[] {
  const seen = new Set<string>()
  const rows: SampleRow[] = []
  for (const entry of entries) {
    if (entry.run === null || seen.has(entry.run) || (runsOfClass !== null && !runsOfClass.has(entry.run)))
      continue
    if (entry.status !== COUNTED_STATUS || entry.tokens === 'unknown')
      continue
    if (effort !== undefined && entry.effort !== effort)
      continue
    seen.add(entry.run)
    rows.push({ run: entry.run, effort: entry.effort, tokens: entry.tokens, minutes: entry.seconds / 60 })
  }
  return rows
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10)
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${oneDecimal(tokens / 1_000_000)}M`
  if (tokens >= 1_000)
    return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

function formatBand(band: { p25: number, p75: number }, lore: Lore): string {
  return lore.expectBand(formatTokens(band.p25), formatTokens(band.p75))
}

function headOf(rows: SampleRow[], label: string, effort: string | undefined, missing: string | null, lore: Lore): ExpectHead {
  if (missing !== null && rows.length === 0)
    return { kind: 'none', reason: missing }
  const tokens = recentBand(rows.map(row => row.tokens))
  if (tokens.kind === 'none')
    return { kind: 'none', reason: `${lore.expectNoneCount(tokens.n, label)}${lore.expectNoneRaisedBy(MINIMUM_SAMPLE - tokens.n, label)}` }
  const efforts = [...new Set(rows.map(row => row.effort))]
  const basis = effort ?? (efforts.length === 1 ? efforts[0] : undefined)
  if (basis === undefined)
    return { kind: 'none', reason: lore.expectMixed(label, efforts.sort().join(', ')) }
  const minutes = recentBand(rows.map(row => row.minutes))
  return { kind: 'forecast', tokens: tokens.median, p25: tokens.p25, p75: tokens.p75, minutes: minutes.kind === 'band' ? minutes.median : 0, effort: basis, n: tokens.n }
}

function formatHead(head: ExpectHead, lore: Lore): string {
  if (head.kind === 'forecast')
    return lore.expectForecastHead(formatTokens(head.tokens), oneDecimal(head.minutes), head.effort, head.n, formatBand(head, lore))
  return lore.expectNoneHead(head.reason)
}

export function stepExpects(entries: LedgerEntry[], runSteps: Map<string, RunStep[]>, effort: string, implement: ImplementSubsample | null = null): StepExpect[] {
  const counted = new Set<string>()
  const perStep = new Map<Step, { tokens: number, seconds: number }[]>(STEPS.map(step => [step, []]))
  for (const entry of oldestFirst(entries)) {
    if (entry.run === null || counted.has(entry.run) || entry.status !== COUNTED_STATUS || entry.effort !== effort)
      continue
    const steps = runSteps.get(entry.run)
    if (steps === undefined)
      continue
    counted.add(entry.run)
    for (const step of STEPS) {
      if (step === SUBSAMPLED_STEP && implement !== null && !implement.runs.has(entry.run))
        continue
      const records = steps.filter(record => record.step === step)
      if (records.length > 0)
        perStep.get(step)!.push({ tokens: records.reduce((sum, record) => sum + record.tokens, 0), seconds: records.reduce((sum, record) => sum + record.seconds, 0) })
    }
  }
  return STEPS.map((step) => {
    const samples = perStep.get(step)!
    const subsample = step === SUBSAMPLED_STEP && implement !== null ? { subsample: implement.subsample } : {}
    const tokens = recentBand(samples.map(sample => sample.tokens))
    const seconds = recentBand(samples.map(sample => sample.seconds))
    if (tokens.kind === 'none' || seconds.kind === 'none')
      return { kind: 'none', step, effort, n: tokens.n, ...subsample }
    return { kind: 'forecast', step, effort, tokens: tokens.median, p25: tokens.p25, p75: tokens.p75, minutes: Math.round(seconds.median / 6) / 10, n: tokens.n, ...subsample }
  })
}

function stepNoneReason(expected: StepExpect, lore: Lore): string {
  return lore.expectStepNoneReason(expected.n, expected.effort, expected.step, expected.subsample ?? null)
}

export function formatStepExpect(expected: StepExpect, lore: Lore): string {
  if (expected.kind === 'none')
    return lore.expectStepNone(expected.step, stepNoneReason(expected, lore))
  return lore.expectStepForecast(expected.step, expected.subsample ?? null, formatTokens(expected.tokens), String(expected.minutes), formatBand(expected, lore), expected.n)
}

function roleNoneReason(expected: RoleBand, lore: Lore): string {
  return expected.missing ?? lore.expectRoleNoneReason(expected.band.n, expected.role)
}

export function formatRoleExpect(expected: RoleBand, lore: Lore): string {
  if (expected.band.kind === 'none')
    return lore.expectRoleNone(expected.role, roleNoneReason(expected, lore))
  return lore.expectRoleForecast(expected.role, formatTokens(expected.band.median), formatBand(expected.band, lore), expected.band.n)
}

interface ContourPart {
  name: string
  band: Band
  reason: string
}

function contourParts(steps: StepExpect[], roles: RoleBand[], lore: Lore): ContourPart[] {
  return [
    ...steps.map(step => ({ name: step.step, band: step.kind === 'forecast' ? { kind: 'band' as const, median: step.tokens, p25: step.p25, p75: step.p75, n: step.n } : { kind: 'none' as const, n: step.n }, reason: stepNoneReason(step, lore) })),
    ...roles.map(role => ({ name: role.role, band: role.band, reason: roleNoneReason(role, lore) })),
  ]
}

export function formatContour(steps: StepExpect[], roles: RoleBand[], lore: Lore): string {
  const parts = contourParts(steps, roles, lore)
  const covered = parts.flatMap(part => part.band.kind === 'band' ? [{ name: part.name, band: part.band }] : [])
  const uncovered = parts.filter(part => part.band.kind === 'none').map(part => lore.expectUncovered(part.name, part.reason))
  const notCovered = uncovered.length === 0 ? '' : lore.expectNotCovered(uncovered.join(', '))
  if (covered.length === 0)
    return lore.expectContourNone(notCovered)
  const sum = (pick: (band: { median: number, p25: number, p75: number }) => number): number => covered.reduce((total, part) => total + pick(part.band), 0)
  return lore.expectContourForecast(formatTokens(sum(band => band.median)), formatBand({ p25: sum(band => band.p25), p75: sum(band => band.p75) }, lore), covered.map(part => part.name).join(', '), notCovered)
}

export function expectLines(result: ExpectResult, lore: Lore): string[] {
  return [result.line, ...result.steps.map(step => lore.expectStepLine(formatStepExpect(step, lore)))]
}

export function expectFor(input: ExpectInput, lore: Lore): ExpectResult {
  const notes: string[] = []
  const entries = input.ledgers.flatMap(ledger => readLedgerEntries(ledger, notes, lore))
  notes.push(...input.classNotes ?? [])
  const all = countedRows(oldestFirst(entries), input.effort, input.runsOfClass ?? null)
  const unrecorded = input.ledgers.filter(ledger => ledger.lines === null || ledger.lines.length === 0).map(ledger => ledger.source)
  const missing = input.missing ?? (entries.length === 0 && unrecorded.length > 0 ? lore.expectRunsNotRecorded(unrecorded.join(', ')) : null)
  const label = lore.expectSelection(input.taskClass ?? null, input.effort ?? null)
  const head = headOf(all, label, input.effort, missing, lore)
  const subsample = input.effort === undefined ? null : input.implement?.(entries) ?? null
  notes.push(...subsample?.notes ?? [])
  const sources = [lore.expectLedgerSource(input.ledgers.map(ledger => ledger.source).join(', ')), ...input.extraSources ?? []]
  const line = lore.expectLine(formatHead(head, lore), [...sources, ...notes])
  const steps = input.effort === undefined ? [] : stepExpects(entries, input.runSteps ?? new Map(), input.effort, subsample?.sample ?? null)
  const contour = input.effort === undefined || input.roles === undefined ? null : formatContour(steps, input.roles, lore)
  const shown = recentBand(all.map(row => row.tokens)).n
  return { line, head, sources, notes, rows: all.slice(all.length - shown), steps, contour }
}
