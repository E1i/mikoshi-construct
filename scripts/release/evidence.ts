import type { Card } from '../../src/card/grammar.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../../src/card/grammar.js'
import { INTAKE_EVENT } from '../../src/commands/intake/confirm.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { PREFIX as MERGE_PREFIX } from '../shift/merge.js'
import { GHOST_JOURNAL, SHIFT_JOURNAL } from '../shift/places.js'

export const PREFIX = '[release:evidence] '
export const USAGE = 'usage: pnpm release:evidence <from> <to>'
export const UNKNOWN = 'unknown'
export const GAP = 'gap'
const BUDGET_SOURCE = 'no budget is recorded apart from the forecast'

interface Line {
  entry: Record<string, unknown>
  source: string
}

export interface EvidenceDeps {
  journal: string
  read: (file: string) => string | null
  commits: (from: string, to: string) => Set<string>
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
    return { name, value: UNKNOWN, source: `no shift recorded on the start line in ${deps.journal}` }
  const file = path.join(shift, SHIFT_JOURNAL)
  const text = deps.read(file)
  if (text === null)
    return { name, value: UNKNOWN, source: `${file} cannot be read` }
  const line = lastOf(linesOf(text, file), task, entry => entry.event === 'task')
  const recorded = line?.entry.merge
  const merges = Array.isArray(recorded) ? recorded.filter((row): row is string => typeof row === 'string' && row.startsWith(MERGE_PREFIX)) : []
  return merges.length === 0
    ? { name, value: UNKNOWN, source: `no ${MERGE_PREFIX.trim()} line for #${task} in ${file}` }
    : { name, value: merges.join(' | '), source: line!.source }
}

function profile(deps: EvidenceDeps, lines: Line[], merge: Line): Field[] {
  const task = String(merge.entry.task)
  const missing = (what: string): string => `no ${what} for #${task} in ${deps.journal}`
  const start = lastOf(lines, task, entry => entry.event === 'path' && typeof entry.card === 'object' && entry.card !== null)
  const close = lastOf(lines, task, entry => entry.event === 'path' && typeof entry.verification === 'string')
  const intake = lastOf(lines, task, entry => entry.event === INTAKE_EVENT)
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
    known('result.verification', close?.entry.verification, close, missing('end line')),
    known('result.stop', stop?.entry.at, stop, missing('stop line')),
    known('result.review', review?.entry.verdict, review, missing('review line')),
    known('result.merge', `PR #${String(merge.entry.pr)} by ${String(merge.entry.by)} at ${String(merge.entry.merged)}`, merge, missing('merge line')),
  ]
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
  const text = deps.read(deps.journal)
  if (text === null)
    return { stdout: [], stderr: [`${PREFIX}${deps.journal} cannot be read`], exitCode: 1 }
  const lines = linesOf(text, deps.journal)
  const merges = lines.filter(({ entry }) => entry.event === 'merge' && typeof entry.commit === 'string' && commits.has(entry.commit))
  const stdout = merges.flatMap(merge => [header(merge), ...profile(deps, lines, merge).map(field => `  ${field.name}: ${field.value} — ${field.source}`)])
  return { stdout: stdout.length === 0 ? [`no merge line in ${deps.journal} has a commit in ${from}..${to}`] : stdout, stderr: [], exitCode: 0 }
}

function realDeps(): EvidenceDeps {
  return {
    journal: path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL),
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    commits: (from, to) => new Set(execFileSync('git', ['rev-list', `${from}..${to}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(sha => sha !== '')),
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
