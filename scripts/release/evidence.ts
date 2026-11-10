import type { Card } from '../../src/card/grammar.js'
import type { IntakeAdmission } from '../intake/intake.js'
import type { JournalEvent } from '../ladder/approval.js'
import type { VerifiedClosing } from '../nodes/close/task-close.js'
import type { BusMerge } from '../nodes/close/task-merged.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { JOURNAL_HISTORY_ENDS, writtenBeforeHistoryEnds } from '../../src/card/closed.js'
import { parseCard } from '../../src/card/grammar.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { INTAKE_EVENT, PR_CLOSED, WITNESS_RECORDED } from '../core/events.js'
import { busHistory } from '../core/journal.js'
import { SHIFT_JOURNAL } from '../core/places.js'
import { openDatabase } from '../core/sqlite.js'
import { busIntakeAdmissions } from '../intake/intake.js'
import { cardVerifiedClosings } from '../nodes/close/task-close.js'
import { busMerges } from '../nodes/close/task-merged.js'
import { GREEN } from '../policy/policy.js'
import { processGit } from '../ports/git.js'

export const PREFIX = '[release:evidence] '
export const USAGE = 'usage: pnpm release:evidence <from> <to>'
export const UNKNOWN = 'unknown'
export const GAP = 'gap'
const BUDGET_SOURCE = 'no budget is recorded apart from the forecast'
const SHIFT_MERGE_LINE_PREFIX = '[shift:merge] '
const VERIFIED_BY_RUNNING_WITNESSES = 'run'

const GREEN_WITNESSES_ON_THE_LAST_HEAD = `
  SELECT witness.id, witness.card_id, witness.pr
  FROM events AS witness
  JOIN prs ON prs.pr = witness.pr AND prs.head = witness.head
  WHERE witness.id IN (SELECT max(id) FROM events WHERE type = '${WITNESS_RECORDED}' AND legacy = 0 AND card_id IS NOT NULL AND pr IS NOT NULL GROUP BY card_id, pr)
    AND json_extract(witness.payload, '$.verdict') = '${GREEN}'
  ORDER BY witness.id
`

const MERGES_LINKED_ONLY_THROUGH_THE_PR = `
  SELECT closed.id, prs.card_id, closed.pr, json_extract(closed.payload, '$.merged_by') AS by, json_extract(closed.payload, '$.commit') AS commit_sha, json_extract(closed.payload, '$.merged_at') AS merged
  FROM events AS closed
  JOIN prs ON prs.pr = closed.pr
  WHERE closed.type = '${PR_CLOSED}' AND closed.legacy = 0 AND json_extract(closed.payload, '$.merged') = 1 AND closed.card_id IS NULL AND prs.card_id IS NOT NULL AND closed.ts >= ?
  ORDER BY closed.id
`

export interface Line {
  entry: Record<string, unknown>
  source: string
}

export interface EvidenceDeps {
  bus: string
  read: (file: string) => string | null
  history: () => JournalEvent[]
  commits: (from: string, to: string) => Set<string>
  busMerges: () => BusMerge[]
  verified: () => VerifiedClosing[]
  witnessed: () => GreenWitness[]
  admissions: () => IntakeAdmission[]
}

export interface GreenWitness {
  task: string
  pr: number
  event: number
}

export interface EvidenceResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

interface Field {
  name: string
  value: string
  source: string
}

function linesOf(text: string | null, file: string): Line[] {
  return (text ?? '').split('\n').flatMap((row, index) => {
    try {
      const entry: unknown = JSON.parse(row)
      return typeof entry === 'object' && entry !== null ? [{ entry: entry as Record<string, unknown>, source: `${file}:${index + 1}` }] : []
    }
    catch {
      return []
    }
  })
}

function historyLines(deps: Pick<EvidenceDeps, 'bus' | 'history'>): Line[] {
  return deps.history().map((entry, index) => ({ entry: entry as Record<string, unknown>, source: `${deps.bus} legacy line ${index + 1}` }))
}

function lastOf(lines: Line[], task: string, test: (entry: Record<string, unknown>) => boolean): Line | undefined {
  return lines.filter(line => line.entry.task === task && test(line.entry)).at(-1)
}

function known(name: string, value: unknown, line: Pick<Line, 'source'> | undefined, missing: string): Field {
  return line === undefined || value === undefined || value === null
    ? { name, value: UNKNOWN, source: missing }
    : { name, value: String(value), source: line.source }
}

function cardOf(start: Line | undefined, intake: Line | undefined): { card: Card, source: string } | undefined {
  if (start !== undefined && typeof start.entry.card === 'object' && start.entry.card !== null)
    return { card: start.entry.card as Card, source: start.source }
  const parsed = typeof intake?.entry.card === 'string' ? parseCard(intake.entry.card) : undefined
  return parsed?.kind === 'card' ? { card: parsed.card, source: intake!.source } : undefined
}

function forecastText(forecast: unknown): string | undefined {
  if (typeof forecast !== 'object' || forecast === null)
    return undefined
  const recorded = forecast as Record<string, unknown>
  const sample = `class ${String(recorded.class)}, n=${String(recorded.n)}`
  return recorded.kind === 'none' ? `none — ${sample}` : `tokens ≈ ${String(recorded.tokens)}, minutes ≈ ${String(recorded.minutes)} — ${sample}`
}

function actualText(actual: unknown): string | undefined {
  if (typeof actual !== 'object' || actual === null)
    return undefined
  const recorded = actual as Record<string, unknown>
  const part = (value: unknown): string => typeof value === 'number' ? String(value) : UNKNOWN
  return `tokens ${part(recorded.tokens)}, minutes ${part(recorded.minutes)}`
}

function riskText(risk: unknown): string | undefined {
  return typeof risk === 'object' && risk !== null && typeof (risk as Record<string, unknown>).text === 'string' ? (risk as { text: string }).text : undefined
}

function shiftMergeField(deps: EvidenceDeps, task: string, shift: unknown): Field {
  const name = 'merge.shift'
  if (typeof shift !== 'string')
    return { name, value: UNKNOWN, source: `no shift recorded on the start line in ${deps.bus}` }
  const file = path.join(shift, SHIFT_JOURNAL)
  const text = deps.read(file)
  if (text === null)
    return { name, value: UNKNOWN, source: `${file} cannot be read` }
  const line = lastOf(linesOf(text, file), task, entry => entry.event === 'task')
  const recorded = line?.entry.merge
  const merges = Array.isArray(recorded) ? recorded.filter((row): row is string => typeof row === 'string' && row.startsWith(SHIFT_MERGE_LINE_PREFIX)) : []
  return merges.length === 0
    ? { name, value: UNKNOWN, source: `no ${SHIFT_MERGE_LINE_PREFIX.trim()} line for #${task} in ${file}` }
    : { name, value: merges.join(' | '), source: line!.source }
}

export function greenWitnesses(busPath: string): GreenWitness[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(GREEN_WITNESSES_ON_THE_LAST_HEAD).all() as unknown as { id: number, card_id: number, pr: number }[]
    return rows.map(row => ({ task: String(row.card_id), pr: row.pr, event: row.id }))
  }
  finally {
    db.close()
  }
}

export function mergesLinkedOnlyThroughThePr(busPath: string): BusMerge[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(MERGES_LINKED_ONLY_THROUGH_THE_PR).all(JOURNAL_HISTORY_ENDS) as unknown as { id: number, card_id: number, pr: number, by: string | null, commit_sha: string | null, merged: string | null }[]
    return rows.map(row => ({ task: String(row.card_id), pr: row.pr, by: row.by, commit: row.commit_sha, merged: row.merged, event: row.id }))
  }
  finally {
    db.close()
  }
}

function witnessedClosingOf(deps: EvidenceDeps, witnessed: readonly GreenWitness[], merge: Line): Line | undefined {
  const witness = witnessed.find(green => green.task === String(merge.entry.task) && green.pr === merge.entry.pr)
  return witness === undefined ? undefined : { entry: { verification: VERIFIED_BY_RUNNING_WITNESSES }, source: `${deps.bus} event ${witness.event}` }
}

function closingOf(deps: EvidenceDeps, lines: Line[], verified: readonly VerifiedClosing[], witnessed: readonly GreenWitness[], merge: Line): Line | undefined {
  const task = String(merge.entry.task)
  const fromBus = verified.filter(closing => closing.task === task && typeof closing.verification === 'string').at(-1)
  if (fromBus !== undefined)
    return { entry: { verification: fromBus.verification, actual: fromBus.actual }, source: `${deps.bus} event ${fromBus.event}` }
  return lastOf(lines, task, entry => entry.event === 'path' && typeof entry.verification === 'string' && writtenBeforeHistoryEnds(entry)) ?? witnessedClosingOf(deps, witnessed, merge)
}

function intakeOf(deps: EvidenceDeps, lines: Line[], admissions: readonly IntakeAdmission[], task: string): Line | undefined {
  const fromBus = admissions.filter(admission => admission.task === task).at(-1)
  if (fromBus !== undefined)
    return { entry: { card: fromBus.card, confirmation: fromBus.confirmation, corrections: fromBus.corrections }, source: `${deps.bus} event ${fromBus.event}` }
  return lastOf(lines, task, entry => entry.event === INTAKE_EVENT && writtenBeforeHistoryEnds(entry))
}

function profile(deps: EvidenceDeps, lines: Line[], verified: readonly VerifiedClosing[], witnessed: readonly GreenWitness[], admissions: readonly IntakeAdmission[], merge: Line): Field[] {
  const task = String(merge.entry.task)
  const missing = (what: string): string => `no ${what} for #${task} in ${deps.bus}`
  const start = lastOf(lines, task, entry => entry.event === 'path' && typeof entry.card === 'object' && entry.card !== null)
  const close = closingOf(deps, lines, verified, witnessed, merge)
  const intake = intakeOf(deps, lines, admissions, task)
  const stop = lastOf(lines, task, entry => entry.event === 'stop')
  const review = lastOf(lines, task, entry => entry.event === 'review')
  const card = cardOf(start, intake)
  const confirmation = intake === undefined ? undefined : `${String(intake.entry.confirmation)} · corrections ${JSON.stringify(intake.entry.corrections ?? null)}`
  return [
    known('who', start?.entry.who, start, missing('who on a start line')),
    known('confirmation', confirmation, intake, missing('intake line')),
    known('risk', riskText(start?.entry.risk), start, missing('risk on a start line')),
    known('size', card?.card.size, card, missing('card')),
    known('contour', card?.card.contour, card, missing('card')),
    known('merge.decision', card?.card.decision, card, missing('card')),
    shiftMergeField(deps, task, start?.entry.shift),
    known('forecast', forecastText(start?.entry.forecast), start, missing('forecast on a start line')),
    { name: 'budget', value: GAP, source: BUDGET_SOURCE },
    known('actual', actualText(close?.entry.actual), close, missing('actual on an end line')),
    known('result.verification', close?.entry.verification, close, missing('card.verified, end line or green witness on the last head')),
    known('result.stop', stop?.entry.at, stop, missing('stop line')),
    known('result.review', review?.entry.verdict, review, missing('review line')),
    known('result.merge', `PR #${String(merge.entry.pr)} by ${String(merge.entry.by)} at ${String(merge.entry.merged)}`, merge, missing('merge line')),
  ]
}

function journalMerges(lines: Line[], commits: Set<string>): Line[] {
  return lines.filter(({ entry }) => entry.event === 'merge' && writtenBeforeHistoryEnds(entry) && typeof entry.commit === 'string' && commits.has(entry.commit))
}

function mergesInBus(deps: Pick<EvidenceDeps, 'bus' | 'busMerges'>, commits: Set<string>): Line[] {
  return deps.busMerges().filter(merge => merge.commit !== null && commits.has(merge.commit)).map(merge => ({
    entry: { event: 'merge', task: merge.task, pr: merge.pr, by: merge.by, commit: merge.commit, merged: merge.merged },
    source: `${deps.bus} event ${merge.event}`,
  }))
}

export function busMergeSet(deps: Pick<EvidenceDeps, 'bus' | 'history' | 'busMerges'>, commits: Set<string>): Line[] {
  return [...journalMerges(historyLines(deps), commits), ...mergesInBus(deps, commits)]
}

function header({ entry }: Line): string {
  return `#${String(entry.task)} · PR #${String(entry.pr)} · commit ${String(entry.commit).slice(0, 7)}`
}

export function runEvidence(argv: string[], deps: EvidenceDeps): EvidenceResult {
  if (argv.length !== 2)
    return { stdout: [], stderr: [`${PREFIX}${USAGE}`], exitCode: 1 }
  const [from, to] = argv as [string, string]
  let commits: Set<string>
  try {
    commits = deps.commits(from, to)
  }
  catch (error) {
    return { stdout: [], stderr: [`${PREFIX}${from}..${to} not read: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`], exitCode: 1 }
  }
  const lines = historyLines(deps)
  const merges = busMergeSet(deps, commits)
  const verified = deps.verified()
  const witnessed = deps.witnessed()
  const admissions = deps.admissions()
  const stdout = merges.flatMap(merge => [header(merge), ...profile(deps, lines, verified, witnessed, admissions, merge).map(field => `  ${field.name}: ${field.value} — ${field.source}`)])
  return { stdout: stdout.length === 0 ? [`no merge line in ${deps.bus} legacy history and no merged pr.closed in ${deps.bus} has a commit in ${from}..${to}`] : stdout, stderr: [], exitCode: 0 }
}

function realDeps(): EvidenceDeps {
  const bus = defaultBusPath()
  return {
    bus,
    history: () => busHistory(bus),
    busMerges: () => [...busMerges(bus), ...mergesLinkedOnlyThroughThePr(bus)].sort((left, right) => left.event - right.event),
    verified: () => cardVerifiedClosings(bus),
    witnessed: () => greenWitnesses(bus),
    admissions: () => busIntakeAdmissions(bus),
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    commits: (from, to) => new Set(processGit.read(process.cwd(), ['rev-list', `${from}..${to}`]).split('\n').filter(sha => sha !== '')),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runEvidence(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
