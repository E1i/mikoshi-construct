import type { Card } from '../../src/card/grammar.js'
import type { CheapForecast, CheapSession } from '../../src/commands/cost/cheap.js'
import type { SignalStyle } from '../../src/ui/signal.js'
import type { BusEvent } from '../bus/db.js'
import type { GhCall, GhCaller, GhRead } from '../core/gh.js'
import type { Decision } from '../decisions/decisions.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writtenBeforeHistoryEnds } from '../../src/card/closed.js'
import { parseCard, readBodyCard } from '../../src/card/grammar.js'
import { cheapClass, cheapForecastOf, defaultShiftRoot, sessionTokens } from '../../src/commands/cost/cheap.js'
import { claudeProjectsDir, projectKey } from '../../src/commands/cost/claude-code.js'
import { formatTokens } from '../../src/commands/cost/expect.js'
import { MUTATION_JUDGED_EVENT } from '../../src/commands/mutate/journal.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { NOT_A_BACKFILL } from '../bus/backfill-source.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, openBus } from '../bus/db.js'
import { legacyHistory } from '../bus/legacy-history.js'
import { closeWitnessDenial } from '../bus/policy.js'
import { openDatabase } from '../bus/sqlite.js'
import { CARD_VERIFIED } from '../core/events.js'
import { execGh, readGhJson } from '../core/gh.js'
import { VERIFICATION_WORDS } from '../core/verification.js'
import { parseDecisions } from '../decisions/decisions.js'
import { archiveOf, defaultDecisions } from '../decisions/read.js'
import { REPO } from '../shift/places.js'
import { ENTRY_EVENT, entryOf, startedEntryOf } from './entry.js'
import { ghostLines } from './journal.js'
import { cardStartedLines, prCardOf } from './tasks.js'

export const PREFIX = '[task:close] '
export const USAGE = 'usage: pnpm task:close <id> (--pr <N> | --report <path>) --verification <word> [--override-report <reason>] [--shared-by D-<N>]'
const FLAGS = ['--pr', '--report', '--verification', '--override-report', '--shared-by'] as const
const PR_NUMBER = /^[1-9]\d*$/
const DECISION_REFERENCE = /^D-[1-9]\d*$/
const CARD_MENTION = /(?<!PR )#([1-9]\d*)/g
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const CLOSER_SESSION_BY_HAND = 'by-hand'
const CARD_VERIFIED_ROWS = `SELECT id, ts, card_id, pr, payload FROM events WHERE type = '${CARD_VERIFIED}' AND legacy = 0 AND card_id IS NOT NULL ORDER BY id`
const REPORT_ROOTS = ['reports', 'probes'] as const
const REPORT_VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m
const SURVIVED = 'nothing-red'
const LADDER_CONTOUR = 'ladder'
const MS_PER_MINUTE = 60_000
const OPEN_ISSUE_LIMIT = 1000
const OUTCOME_OF_KIND: Record<Card['kind'], typeof FLAGS[number]> = { implement: '--pr', probe: '--report' }

type Flag = typeof FLAGS[number]

interface StartLine {
  event: 'path'
  task: string
  path: string
  started?: unknown
  worktree?: unknown
  session?: unknown
  forecast?: unknown
  card: Card
}

export interface Actual {
  tokens: number | null
  minutes: number | null
}

export interface TaskSession {
  id: string
  project?: string
}

export interface TaskCloseDeps {
  cwd: string
  read: (file: string) => string | null
  now: () => Date
  constructDir: string
  realpath: (file: string) => string
  busPath: string
  exists: (file: string) => boolean
  session: string | undefined
  projectsDir: string
  tokens?: (session: CheapSession) => number | null
  forecast?: (taskClass: string) => CheapForecast
  style?: SignalStyle
  prBody: (pr: number) => GhRead<string | null>
  prCard?: (pr: number) => number | null
  decisionsFile?: string
  openIssue?: (issue: number) => GhRead<OpenIssue | null>
  closeIssue?: (issue: number, comment: string) => GhCall
}

export interface OpenIssue {
  title: string
  body: string | null
}

export interface TaskCloseResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

function reportRootRefusal(deps: TaskCloseDeps, report: string): string | null {
  const roots = REPORT_ROOTS.map(name => path.join(deps.constructDir, name))
  const real = deps.realpath(report)
  const inside = roots.some((root) => {
    const relative = path.relative(deps.realpath(root), real)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  })
  return inside ? null : `--report ${report} is outside ${roots.join(' and ')}; a probe's report lives under one of them; nothing written`
}

function refuse(message: string): TaskCloseResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function readArgs(argv: string[]): { id: string, flags: Map<Flag, string> } | string {
  const flags = new Map<Flag, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (!(FLAGS as readonly string[]).includes(arg))
      return `unknown flag ${arg}`
    const value = argv[++index]
    if (value === undefined || value.startsWith('--'))
      return `${arg} needs a value`
    if (flags.has(arg as Flag))
      return `${arg} given twice`
    flags.set(arg as Flag, value)
  }
  return positional.length === 1 ? { id: positional[0]!, flags } : 'one task id is needed'
}

function journalLines(journal: string): Record<string, unknown>[] {
  return journal.split('\n').flatMap((text) => {
    try {
      const entry: unknown = JSON.parse(text)
      return typeof entry === 'object' && entry !== null ? [entry as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

export interface VerifiedClosing {
  task: string
  pr: number | null
  verification: unknown
  actual: unknown
  event: number
}

export function cardVerifiedClosings(busPath: string): VerifiedClosing[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(CARD_VERIFIED_ROWS).all() as unknown as { id: number, card_id: number, pr: number | null, payload: string }[]
    return rows.flatMap((row) => {
      const payload = journalLines(row.payload)[0]
      return payload === undefined ? [] : [{ task: String(row.card_id), pr: row.pr, verification: payload.verification, actual: payload.actual, event: row.id }]
    })
  }
  finally {
    db.close()
  }
}

export function closingHistoryLines(busPath: string): Record<string, unknown>[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(CARD_VERIFIED_ROWS).all() as unknown as { ts: string, card_id: number, payload: string }[]
    return rows
      .flatMap(row => journalLines(row.payload).map(payload => ({ event: 'path', task: String(row.card_id), ...payload, ts: row.ts })))
      .filter(line => writtenBeforeHistoryEnds(line))
  }
  finally {
    db.close()
  }
}

export function legacyLines(busPath: string): Record<string, unknown>[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return legacyHistory(db) as Record<string, unknown>[]
  }
  finally {
    db.close()
  }
}

export function closingVerificationOf(history: readonly Record<string, unknown>[], verified: readonly VerifiedClosing[], id: string, pr: number): string | null {
  const fromBus = verified.filter(closing => closing.task === id && closing.pr === pr && typeof closing.verification === 'string').at(-1)
  if (fromBus !== undefined)
    return fromBus.verification as string
  const closing = history.filter(line => line.event === 'path' && line.task === id && line.pr === pr && typeof line.verification === 'string').at(-1)
  return closing === undefined ? null : closing.verification as string
}

function witnessRefusal(busPath: string, id: string, pr: number): string | null {
  if (!existsSync(busPath))
    return null
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const head = (db.prepare('SELECT head FROM prs WHERE pr = ?').get(pr) as { head: string | null } | undefined)?.head ?? null
    const denial = closeWitnessDenial(db, Number(id), pr, head)
    return denial === null ? null : `#${id} closes PR #${pr} only on a green witness record, not on a reported verification: ${denial.detail}; nothing written`
  }
  finally {
    db.close()
  }
}

function hasCard(line: Record<string, unknown>): line is Record<string, unknown> & { card: Card } {
  return typeof line.card === 'object' && line.card !== null
}

function startLineOf(lines: Record<string, unknown>[], id: string): StartLine | undefined {
  return lines.filter((line): line is Record<string, unknown> & StartLine => line.event === 'path' && line.task === id && hasCard(line)).at(-1)
}

function ghostSessionOf(lines: Record<string, unknown>[], id: string): unknown {
  return lines.filter(line => line.event === 'task' && line.task === id).at(-1)?.session
}

function launchStartOf(lines: Record<string, unknown>[], id: string): StartLine | undefined {
  const entry = lines.filter(line => line.event === ENTRY_EVENT && line.task === id).filter(hasCard).at(-1)
  if (entry === undefined)
    return undefined
  const session = ghostSessionOf(lines, id)
  return { event: 'path', task: id, path: entry.card.contour, session, card: entry.card }
}

const LATEST_ADMITTED_WITH_A_CARD = `
  SELECT payload FROM events
  WHERE type = 'card.admitted' AND legacy = 0 AND card_id = ? AND ${NOT_A_BACKFILL} AND json_type(payload, '$.card') = 'text'
  ORDER BY id DESC LIMIT 1
`

function admittedCardOf(busPath: string, id: string): Card | undefined {
  if (!existsSync(busPath) || !PR_NUMBER.test(id))
    return undefined
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const row = db.prepare(LATEST_ADMITTED_WITH_A_CARD).get(Number(id)) as { payload: string } | undefined
    const line = row === undefined ? undefined : journalLines(row.payload)[0]?.card
    const parsed = typeof line === 'string' ? parseCard(line) : undefined
    return parsed?.kind === 'card' ? parsed.card : undefined
  }
  finally {
    db.close()
  }
}

function launchNodeStartOf(lines: Record<string, unknown>[], busPath: string, id: string): StartLine | undefined {
  const start = lines.filter(line => line.event === 'path' && line.task === id && !hasCard(line) && typeof line.session === 'string' && typeof line.worktree === 'string' && typeof line.pid === 'number').at(-1)
  const card = start === undefined ? undefined : admittedCardOf(busPath, id)
  return start === undefined || card === undefined ? undefined : { ...start, event: 'path', task: id, path: card.contour, started: start.ts, card }
}

const RERUN_SUFFIX = /(?<=\d)[a-z]+$/

function mutationOf(line: Record<string, unknown>): string {
  return String(line.id).replace(RERUN_SUFFIX, '')
}

function latestVerdictPerMutation(judged: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Map(judged.map(line => [mutationOf(line), line])).values()]
}

function mutationRefusal(lines: Record<string, unknown>[], id: string, journal: string): string | null {
  const judged = lines.filter(line => line.event === MUTATION_JUDGED_EVENT && line.card === id)
  if (judged.length === 0)
    return `--verification mutation needs a ${MUTATION_JUDGED_EVENT} line for #${id} in ${journal}, and there is none; nothing written`
  const survived = latestVerdictPerMutation(judged).filter(line => line.outcome === SURVIVED).map(line => String(line.id))
  if (survived.length > 0)
    return `--verification mutation refused: ${survived.join(', ')} of #${id} survived (outcome ${SURVIVED}) in ${journal}; nothing written`
  return null
}

function shiftReportOf(lines: Record<string, unknown>[], id: string): string | undefined {
  const shift = lines.filter(line => (line.event === 'stop' || line.event === 'path') && line.task === id && typeof line.shift === 'string').at(-1)?.shift
  return typeof shift === 'string' ? path.join(shift, `report-${id}.md`) : undefined
}

function reportRefusal(deps: TaskCloseDeps, lines: Record<string, unknown>[], id: string, verification: string): string | null {
  const report = shiftReportOf(lines, id)
  const word = report === undefined ? undefined : REPORT_VERIFICATION_LINE.exec(deps.read(report) ?? '')?.[1]
  if (word === undefined || word === verification)
    return null
  return `the shift report ${report} says verification: ${word}, the flag says ${verification}; close with --verification ${word}, or pass --override-report <reason> to keep ${verification}; nothing written`
}

function sessionDirs(deps: TaskCloseDeps, start: StartLine): string[] {
  return [...new Set([deps.cwd, ...(typeof start.worktree === 'string' ? [start.worktree] : [])])]
}

function placedSessions(deps: TaskCloseDeps, start: StartLine, candidates: unknown[]): TaskSession[] {
  const ids = [...new Set(candidates.filter((id): id is string => typeof id === 'string' && id !== ''))]
  const keys = sessionDirs(deps, start).map(projectKey)
  return ids.map((id) => {
    const project = keys.find(key => deps.exists(path.join(deps.projectsDir, key, `${id}.jsonl`)))
    return project === undefined ? { id } : { id, project }
  })
}

function taskSessions(deps: TaskCloseDeps, start: StartLine): TaskSession[] {
  return placedSessions(deps, start, [start.session, deps.session])
}

function actualTokens(deps: TaskCloseDeps, sessions: TaskSession[]): number | null {
  if (sessions.length === 0)
    return null
  const tokens = deps.tokens ?? (session => sessionTokens(deps.projectsDir, session))
  const counts = sessions.map(({ id, project }) => project === undefined ? null : tokens({ id, project }))
  return counts.includes(null) ? null : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

function actualMinutes(start: StartLine, ended: string): number | null {
  const minutes = typeof start.started === 'string' ? (Date.parse(ended) - Date.parse(start.started)) / MS_PER_MINUTE : Number.NaN
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null
}

function actualOf(deps: TaskCloseDeps, lines: Record<string, unknown>[], start: StartLine, sessions: TaskSession[], ended: string): Actual {
  const ghost = start.card.contour === LADDER_CONTOUR ? [ghostSessionOf(lines, start.task)] : []
  const counted = placedSessions(deps, start, [...sessions.map(session => session.id), ...ghost])
  return { tokens: actualTokens(deps, counted), minutes: actualMinutes(start, ended) }
}

function tenths(minutes: number): number {
  return Math.round(minutes * 10) / 10
}

function recordedForecastText(recorded: Record<string, unknown>): string | undefined {
  if (typeof recorded.tokens === 'number' && typeof recorded.minutes === 'number')
    return `forecast tokens ≈ ${formatTokens(recorded.tokens)}, minutes ≈ ${tenths(recorded.minutes)} (class ${String(recorded.class)}, n=${String(recorded.n)}, start line)`
  if (recorded.kind === 'none')
    return `forecast none: n=${String(recorded.n)} for ${String(recorded.class)} (start line)`
  return undefined
}

function computedForecastText(forecast: CheapForecast): string {
  return forecast.kind === 'none'
    ? `forecast none: n=${forecast.n} for ${forecast.taskClass}`
    : `forecast tokens ≈ ${formatTokens(forecast.tokens)}, minutes ≈ ${tenths(forecast.minutes)} (class ${forecast.taskClass}, n=${forecast.n}, median at close: the start line holds none)`
}

function forecastText(deps: TaskCloseDeps, start: StartLine): string {
  const recorded = typeof start.forecast === 'object' && start.forecast !== null ? recordedForecastText(start.forecast as Record<string, unknown>) : undefined
  if (recorded !== undefined)
    return recorded
  if (deps.forecast === undefined)
    return 'forecast not recorded on the start line'
  try {
    return computedForecastText(deps.forecast(cheapClass(start.card)))
  }
  catch (error) {
    return `forecast not recorded: the forecast read failed (${error instanceof Error ? error.message : String(error)})`
  }
}

function actualText(actual: Actual): string {
  const tokens = actual.tokens === null ? 'not recorded' : formatTokens(actual.tokens)
  const minutes = actual.minutes === null ? 'not recorded' : String(tenths(actual.minutes))
  return `actual tokens ${tokens}, minutes ${minutes}`
}

export function prBodyOf(gh: GhCaller): (pr: number) => GhRead<string | null> {
  return (pr) => {
    const read = readGhJson<{ body: string | null }>(gh, ['pr', 'view', String(pr), '-R', REPO, '--json', 'body'])
    return read.kind === 'read' ? { kind: 'read', value: read.value.body } : read
  }
}

interface Ownership {
  cardLine: number | null
  sharedBy?: string
}

function cardsNamedBy(decision: Decision): Set<number> {
  return new Set([...decision.cards, ...[...decision.body.matchAll(CARD_MENTION)].map(mention => Number(mention[1]))])
}

function sharingRefusal(deps: TaskCloseDeps, reference: string, cards: number[]): string | null {
  if (!DECISION_REFERENCE.test(reference))
    return `--shared-by '${reference}' is not an owner decision D-<N>; nothing written`
  if (deps.decisionsFile === undefined)
    return `--shared-by ${reference} is checked against the owner decisions, and no decisions file is given; nothing written`
  const files = [deps.decisionsFile, archiveOf(deps.decisionsFile)]
  const found = files.flatMap(file => parseDecisions(deps.read(file) ?? '').decisions).filter(decision => decision.number === Number(reference.slice(2)))
  const named = cards.map(card => `#${card}`).join(' and ')
  if (found.length === 0)
    return `--shared-by ${reference}: no decision ${reference} in ${files.join(' or ')}; nothing written`
  if (!found.some(decision => cards.every(card => cardsNamedBy(decision).has(card))))
    return `--shared-by ${reference} does not name ${named}, so it does not share the pull request between them; nothing written`
  return null
}

function ownershipOf(deps: TaskCloseDeps, id: string, pr: number, reference: string | undefined): Ownership | string {
  const read: GhRead<string | null> = typeof deps.prBody === 'function' ? deps.prBody(pr) : { kind: 'failed', reason: 'no reader of the PR body is given', cause: 'failed' }
  if (read.kind === 'failed')
    return `the body of PR #${pr} was not read, so whose result it is was not checked: ${firstLine(read.reason)}; nothing written`
  const body = read.value
  const parsed = readBodyCard(body ?? '')
  const cardLine = parsed.kind === 'card' ? parsed.card.id : null
  let busOwner: number | null = null
  try {
    busOwner = deps.prCard?.(pr) ?? null
  }
  catch (error) {
    return `the bus was not read, so whose result PR #${pr} is was not checked: ${firstLine(error)}; nothing written`
  }
  const owner = busOwner ?? cardLine
  if (reference === undefined) {
    if (busOwner !== null && busOwner !== Number(id))
      return `PR #${pr} belongs to #${busOwner} in the bus (prs.card_id), not #${id}: it is that card's result; a pull request an owner decision shares between both cards closes with --shared-by D-<N>; nothing written`
    if (cardLine !== null && cardLine !== Number(id))
      return `PR #${pr} opens with the card line of #${cardLine}, not #${id}: it is that card's result; a pull request an owner decision shares between both cards closes with --shared-by D-<N>; nothing written`
    if (deps.prCard !== undefined && owner === null)
      return `PR #${pr} has no prs row in the bus and its body opens with no card line, so whose result it is is not known; open the body with the card line of #${id} and let netwatch observe it, then close again; nothing written`
    return { cardLine }
  }
  if (owner === null && deps.prCard !== undefined)
    return `--shared-by ${reference}: PR #${pr} has no prs row in the bus and its body opens with no card line, so no card shares it with #${id}; nothing written`
  if (owner === null)
    return `--shared-by ${reference}: PR #${pr} opens with no card line, so no card shares it with #${id}; nothing written`
  const refusal = sharingRefusal(deps, reference, [...new Set([Number(id), owner])])
  return refusal ?? { cardLine, sharedBy: reference }
}

function cardLineNote(id: string, pr: number, ownership: Ownership): string[] {
  if (ownership.cardLine !== null)
    return []
  return [`${PREFIX}warning: the body of PR #${pr} does not open with the card line, so its merge is recorded for no card and #${id} stays unmerged for its depends; fix the body before the merge`]
}

function namesCard(issue: OpenIssue, card: Card): boolean {
  const slug = new RegExp(`(?<![a-z0-9-])${card.name}(?![a-z0-9-])`)
  const cardNumber = new RegExp(`\\bcard #${card.id}(?!\\d)`, 'i')
  return slug.test(issue.title) || cardNumber.test(issue.body ?? '')
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function issueLines(deps: TaskCloseDeps, card: Card, closedBy: string): string[] {
  if (deps.openIssue === undefined || deps.closeIssue === undefined)
    return []
  const read = deps.openIssue(card.id)
  if (read.kind === 'failed')
    return [`${PREFIX}issue #${card.id} not read, left as it is: ${firstLine(read.reason)}`]
  const issue = read.value
  if (issue === null)
    return []
  if (!namesCard(issue, card))
    return [`${PREFIX}issue #${card.id} '${issue.title}' is about another card, not ${card.name}; left open`]
  const closed = deps.closeIssue(card.id, `Closed by task:close #${card.id} ${card.name}: ${closedBy}.`)
  if (closed.kind === 'failed')
    return [`${PREFIX}issue #${card.id} not closed: ${firstLine(closed.reason)}; re-run task:close #${card.id} to close it`]
  return [`${PREFIX}issue #${card.id} closed with a comment naming ${closedBy}`]
}

function unplacedLine(deps: TaskCloseDeps, start: StartLine, sessions: TaskSession[]): string[] {
  const unplaced = sessions.filter(session => session.project === undefined).map(session => session.id)
  if (sessions.length === 0)
    return [`${PREFIX}#${start.task} sessions not recorded on the start line or in ${SESSION_VARIABLE}`]
  if (unplaced.length === 0)
    return []
  return [`${PREFIX}#${start.task} session ${unplaced.join(', ')} project not recorded: no session file under ${sessionDirs(deps, start).map(projectKey).join(' or ')} in ${deps.projectsDir}`]
}

export function runTaskClose(argv: string[], deps: TaskCloseDeps): TaskCloseResult {
  const args = readArgs(argv)
  if (typeof args === 'string')
    return refuse(`${args}; ${USAGE}`)
  const { id, flags } = args
  const verification = flags.get('--verification')
  if (verification === undefined)
    return refuse(`--verification is required: one of ${VERIFICATION_WORDS.join(', ')}; nothing written`)
  if (!(VERIFICATION_WORDS as readonly string[]).includes(verification))
    return refuse(`verification '${verification}' is not one of ${VERIFICATION_WORDS.join(', ')}; nothing written`)
  const lines = [...legacyLines(deps.busPath), ...ghostLines(deps.busPath), ...cardStartedLines(deps.busPath)]
  const start = startLineOf(lines, id) ?? launchStartOf(lines, id) ?? launchNodeStartOf(lines, deps.busPath, id)
  if (start === undefined)
    return refuse(`the journal lines in the bus ${deps.busPath} have no task:start line with a card for #${id}, no ghosts:launch entry line with one, and the bus ${deps.busPath} has no card.started with one; start the task with pnpm task:start <branch> --card "<card>"; nothing written`)
  const unproven = verification === 'mutation' ? mutationRefusal(lines, id, `the bus ${deps.busPath}`) : null
  if (unproven !== null)
    return refuse(unproven)
  const override = flags.get('--override-report')
  const contradicted = override === undefined ? reportRefusal(deps, lines, id, verification) : null
  if (contradicted !== null)
    return refuse(contradicted)
  const outcome = OUTCOME_OF_KIND[start.card.kind]
  const other = outcome === '--pr' ? '--report' : '--pr'
  if (flags.has(other) || !flags.has(outcome))
    return refuse(`#${id} is kind ${start.card.kind}, which closes with ${outcome} only; nothing written`)
  const value = flags.get(outcome)!
  if (outcome === '--pr' && !PR_NUMBER.test(value))
    return refuse(`--pr '${value}' is not a pull request number; nothing written`)
  const reference = flags.get('--shared-by')
  if (outcome === '--report' && reference !== undefined)
    return refuse(`--shared-by shares a pull request, and #${id} closes with --report; nothing written`)
  const ownership = outcome === '--pr' ? ownershipOf(deps, id, Number(value), reference) : { cardLine: null }
  if (typeof ownership === 'string')
    return refuse(ownership)
  const unwitnessed = outcome === '--pr' ? witnessRefusal(deps.busPath, id, Number(value)) : null
  if (unwitnessed !== null)
    return refuse(unwitnessed)
  const shared = ownership.sharedBy === undefined ? {} : { sharedBy: ownership.sharedBy }
  const report = path.resolve(deps.cwd, value)
  const outside = outcome === '--report' ? reportRootRefusal(deps, report) : null
  if (outside !== null)
    return refuse(outside)
  const closing = outcome === '--pr' ? { pr: Number(value) } : { report }
  const at = deps.now().toISOString()
  const sessions = taskSessions(deps, start)
  const actual = actualOf(deps, lines, start, sessions, at)
  const record = { path: start.path, ...closing, ...shared, verification, ...(override === undefined ? {} : { override }), ended: at, sessions, actual }
  const written = writeClosing(deps, id, record, at)
  if (written.kind === 'refused')
    return refuse(written.reason)
  const entry = startedEntryOf(lines, id) ?? entryOf(lines.map(line => JSON.stringify(line)).join('\n'), id)
  const searched = `the bus ${deps.busPath}`
  const closedBy = outcome === '--pr' ? `PR #${value}` : `report ${report}`
  const closed = `closed ${verification} · ${closedBy} · ${written.where} · ${forecastText(deps, start)} · ${actualText(actual)}`
  const card = renderSignal(`task:close #${id} ${start.card.name}`, {
    CONTRACT: entry?.CONTRACT ?? `contract not recorded in ${searched}: no entry line for #${id}`,
    EXPECT: entry?.EXPECT ?? `expect not recorded in ${searched}: no entry line for #${id}`,
    ACTION: `task:close #${id} ${outcome} ${value}${ownership.sharedBy === undefined ? '' : ` --shared-by ${ownership.sharedBy}`} --verification ${verification}${override === undefined ? '' : ` --override-report ${override}`}`,
    RESULT: closed,
  }, deps.style ?? PLAIN_STYLE)
  return { stdout: [...card, ...unplacedLine(deps, start, sessions), ...issueLines(deps, start.card, closedBy)], stderr: outcome === '--pr' ? cardLineNote(id, Number(value), ownership) : [], exitCode: 0 }
}

type ClosingWrite = { kind: 'written', where: string } | { kind: 'refused', reason: string }

function recordVerified(busPath: string, event: BusEvent): void {
  const db = openBus(busPath)
  try {
    appendEvent(db, event)
  }
  finally {
    db.close()
  }
}

function writeClosing(deps: TaskCloseDeps, id: string, record: Record<string, unknown> & { pr?: number }, at: string): ClosingWrite {
  const event: BusEvent = { ts: at, type: CARD_VERIFIED, actor: `worker:task-close:${deps.session ?? CLOSER_SESSION_BY_HAND}`, cardId: Number(id), pr: record.pr ?? null, head: null, dedupeKey: `${CARD_VERIFIED}:${id}:${at}`, payload: record, legacy: false }
  try {
    recordVerified(deps.busPath, event)
    return { kind: 'written', where: `${CARD_VERIFIED} written to ${deps.busPath}` }
  }
  catch (error) {
    return { kind: 'refused', reason: `${CARD_VERIFIED} could not be written to the bus ${deps.busPath}: ${firstLine(error)}; nothing written` }
  }
}

export function realpathOrSelf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

function realDeps(): TaskCloseDeps {
  return {
    cwd: process.cwd(),
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    now: () => new Date(),
    constructDir: path.join(os.homedir(), '.construct'),
    realpath: realpathOrSelf,
    busPath: defaultBusPath(),
    prCard: pr => prCardOf(defaultBusPath(), pr),
    exists: existsSync,
    session: process.env[SESSION_VARIABLE] === '' ? undefined : process.env[SESSION_VARIABLE],
    projectsDir: claudeProjectsDir(),
    forecast: taskClass => cheapForecastOf(defaultShiftRoot(), taskClass, claudeProjectsDir(), defaultBusPath()),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
    prBody: prBodyOf(execGh),
    decisionsFile: defaultDecisions(os.homedir()),
    openIssue: (issue) => {
      const open = readGhJson<(OpenIssue & { number: number })[]>(execGh, ['issue', 'list', '-R', REPO, '--state', 'open', '--limit', String(OPEN_ISSUE_LIMIT), '--json', 'number,title,body'])
      return open.kind === 'read' ? { kind: 'read', value: open.value.find(candidate => candidate.number === issue) ?? null } : open
    },
    closeIssue: (issue, comment) => execGh(['issue', 'close', String(issue), '-R', REPO, '--comment', comment]),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runTaskClose(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
