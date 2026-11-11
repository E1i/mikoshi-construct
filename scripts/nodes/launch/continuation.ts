import type { ContinueMode } from '../../../src/card/task-file.js'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { eddiesJournalPath } from '../../core/places.js'
import { reportRefusals } from '../../window/handoff-check.js'

export const MAX_RESTARTS = 3
export const HANDOFF_INVALID = 'handoff-invalid'
export const CONTINUE_PROMPT = 'Прочитай handoff задачи целиком и продолжай с места остановки'
export const QUESTION_LINE = /^question:/m
export const BOUNDARY_LINE = /^boundary:\s*\S/m

export type ExitReason = 'closed' | 'eddies-stop' | 'guard-refusal' | 'owner-question' | 'boundary' | 'eddies-warn' | 'ended'

export interface SessionEvidence {
  exit: number | null
  closed: boolean
  stopped: boolean
  refused: boolean
  question: boolean
  boundary: boolean
  warned: boolean
}

export const EXIT_REASON_TEXT: Record<ExitReason, string> = {
  'closed': 'task closed',
  'eddies-stop': 'eddies stop',
  'guard-refusal': 'guard refusal',
  'owner-question': 'question to the owner',
  'boundary': 'stopped at a boundary',
  'eddies-warn': 'eddies warn',
  'ended': 'ended on its own',
}

export function exitReason(evidence: SessionEvidence): ExitReason {
  if (evidence.closed)
    return 'closed'
  if (evidence.stopped)
    return 'eddies-stop'
  if (evidence.refused)
    return 'guard-refusal'
  if (evidence.question)
    return 'owner-question'
  if (evidence.boundary && evidence.exit === 0)
    return 'boundary'
  if (evidence.warned && evidence.exit === 0)
    return 'eddies-warn'
  return 'ended'
}

const CONTINUED_REASONS: ReadonlySet<ExitReason> = new Set(['boundary', 'eddies-warn'])

export function continues(mode: ContinueMode, reason: ExitReason, restarts: number, handoff: string): boolean {
  return mode === 'auto' && CONTINUED_REASONS.has(reason) && restarts < MAX_RESTARTS && continuationRefusal(handoff) === null
}

export function continuationRefusal(handoff: string): string | null {
  const refusals = reportRefusals(handoff)
  return refusals.length === 0 ? null : `${HANDOFF_INVALID}: ${refusals.join('; ')}`
}

interface EddiesEntry {
  event?: unknown
  hook?: unknown
  level?: unknown
  session_id?: unknown
}

export interface EddiesEvidence extends Pick<SessionEvidence, 'warned' | 'stopped' | 'refused'> {
  atContextLine: boolean
}

const CONTEXT_LEVEL = 'session-context'
const SPEND_LEVEL = 'session-spend'
const CONTEXT_LINE_EVENT = 'context-line'

function entriesOf(text: string): EddiesEntry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as EddiesEntry | null
      return entry !== null && typeof entry === 'object' ? [entry] : []
    }
    catch {
      return []
    }
  })
}

export function eddiesEvidence(journal: string, session: string): EddiesEvidence {
  const own = entriesOf(journal).filter(entry => entry.session_id === session)
  return {
    warned: own.some(entry => entry.event === 'budget-warn'),
    atContextLine: own.some(entry => entry.event === CONTEXT_LINE_EVENT || (entry.event === 'budget-warn' && entry.level === CONTEXT_LEVEL)),
    stopped: own.some(entry => entry.event === 'budget-stop'),
    refused: own.some(entry => entry.event === 'unread' && entry.hook === 'eddies-guard'),
  }
}

export function reachedContextLine(worktree: string, session: string): boolean {
  const journal = eddiesJournalPath(worktree)
  return existsSync(journal) && eddiesEvidence(readFileSync(journal, 'utf8'), session).atContextLine
}

export function stoppedOnSpend(worktree: string, session: string): boolean {
  const journal = eddiesJournalPath(worktree)
  return existsSync(journal) && entriesOf(readFileSync(journal, 'utf8')).some(entry => entry.session_id === session && entry.event === 'budget-stop' && entry.level === SPEND_LEVEL)
}

const QUESTION_WITH_ITS_LINES = /^question:[ \t]*(\S.*(?:\n(?!question:)[ \t]*\S.*)*)/gm
const STOP_REASON_TEXT = /^stop reason:[ \t]*(\S.*)$/m

export function reportedQuestions(report: string | null): string[] {
  return report === null ? [] : [...sessionWrittenPart(report).matchAll(QUESTION_WITH_ITS_LINES)].map(found => found[1].split('\n').map(line => line.trim()).join('\n'))
}

export function reportedStopReason(report: string | null): string | null {
  return report === null ? null : STOP_REASON_TEXT.exec(sessionWrittenPart(report))?.[1].trim() ?? null
}

export const BUILT_HANDOFF_HEADING = '## the handoff the bus built'

const SESSION_REPORT_BYTES = 800
const TREE_DIFF_BYTES = 2000
const CARD_BODY_BYTES = 1400
const LAST_STEPS_BYTES = 800
const ANY_LINE_BREAK = /\r\n?|[\n\p{Zl}\p{Zp}]/u

export interface SessionLeftovers {
  cardId: number
  session: string
  report: string | null
  diff: string
  body: string | null
  steps: readonly string[] | null
}

function clipped(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit)
    return text
  return `${bytes.subarray(0, limit).toString().replace(/�+$/, '')}\n> ... clipped at ${limit} of ${bytes.length} bytes`
}

function quoted(text: string, limit: number): string {
  return clipped(text.split(ANY_LINE_BREAK).map(line => `> ${line}`).join('\n'), limit)
}

export function sessionWrittenPart(report: string): string {
  const lines = report.split('\n')
  const built = lines.indexOf(BUILT_HANDOFF_HEADING)
  return built < 0 ? report : lines.slice(0, built).join('\n')
}

export function builtHandoff(left: SessionLeftovers): string {
  const own = left.report === null ? 'the session left no report' : sessionWrittenPart(left.report)
  const steps = left.steps === null ? 'the transcript of the session cannot be read' : left.steps.join('\n')
  return [
    `#${left.cardId}`,
    '## what the session itself reported',
    quoted(own, SESSION_REPORT_BYTES),
    BUILT_HANDOFF_HEADING,
    `current card: #${left.cardId}`,
    `queue: #${left.cardId}`,
    'done: not recorded by the session; the tree diff below is what it left',
    'not done: not recorded by the session; compare the card body with the tree diff',
    'delegation: none',
    'next task: compare the card body with the tree diff, finish what the card still asks, then write the shift report',
    'local decisions: not recorded by the session; read them from the diff',
    'owner waits: none recorded',
    'decisions: none',
    'intake tokens: none',
    `stop reason: session ${left.session} stopped at the context warn with no valid handoff, so the bus built this one`,
    'continue when: now, in this fresh session',
    '## tree diff',
    quoted(left.diff, TREE_DIFF_BYTES),
    '## card body',
    quoted(left.body ?? 'the bus holds no card body', CARD_BODY_BYTES),
    '## last steps of the session',
    quoted(steps, LAST_STEPS_BYTES),
    '',
  ].join('\n')
}
