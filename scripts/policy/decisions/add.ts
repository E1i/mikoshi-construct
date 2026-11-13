import type { DatabaseSync } from 'node:sqlite'
import type { Decision } from './decisions.js'
import type { OwnerDecision } from './index.js'
import { closeSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../../core/db.js'
import { REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { ownerChannelOfBus, sayToOwnerChannel } from '../../owner/channel.js'
import { runRequest, SESSION_VARIABLE } from './window-door.js'
import { continueFixesDecisionOf, namesPrAtHead, observedHeadsOf } from '../round-limit-decision.js'
import { boundText, calendarTerm, cardTail, decisionsRefusals, outOfForceLines, OWNER_SOURCE, parseDecisions, PREFIX, settleSupersedes, stampOf, untilTail, WRITER_MARKER } from './decisions.js'
import { archiveOf } from './read.js'

const ADD_COMMAND = pnpmCommand('decisions:add')
export const USAGE = `usage: ${ADD_COMMAND} [--file <owner-decisions.md>] [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] [--settled #N]... "[owner] <decision>"`
export const OWNER_SHELL_USAGE = `usage: ${ADD_COMMAND} [--supersedes D-M]... [--card #N]... [--creates <path>]... [--until <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>"`
export const ARCHIVE_HEADER = `# Owner decisions archive\n\nSuperseded decisions, moved here from the decisions file by ${ADD_COMMAND}.\n\n`

const SOURCE_TAG = /^\[[^\]]*\]/
const DECISION_REFERENCE = /^D-([1-9]\d*)$/
const CARD_REFERENCE = /^#?([1-9]\d*)$/
const UNTIL_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/
const OWNER_SHELL_SESSION = 'owner-shell'
const CREATES_FLAG = '--creates'
const PR_AT_A_SHA = new RegExp(`^(?:${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} )?\\S+ PR #([1-9]\\d*) at ([0-9a-f]+)(?![0-9a-f])`, 'i')
const ANY_FULL_HEAD = '0'.repeat(40)

export interface DecisionsAddDeps {
  decisions: string
  now: () => Date
  exists: (file: string) => boolean
  read: (file: string) => string
  write: (file: string, text: string) => void
  remove: (file: string) => void
  lock?: (file: string) => (() => void) | string
  record: (decision: OwnerDecision) => void
  held?: () => readonly number[]
  settled: (card: number) => boolean
  out: (line: string) => void
  err: (line: string) => void
}

export interface AddArgs {
  file: string | null
  supersedes: number[]
  cards: number[]
  until: string | null
  settled?: number[]
  text: string
}

export interface AddPlan {
  number: number
  line: string
  file: string
  archive: string
  archived: number[]
}

function parseArgs(args: readonly string[]): Required<AddArgs> | null {
  const parsed: Required<AddArgs> = { file: null, supersedes: [], cards: [], until: null, settled: [], text: '' }
  const texts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = args[index + 1]
    if (arg === '--file' && value !== undefined && parsed.file === null) {
      parsed.file = value
      index += 1
    }
    else if (arg === '--supersedes' && value !== undefined && DECISION_REFERENCE.test(value)) {
      parsed.supersedes.push(Number(DECISION_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === '--card' && value !== undefined && CARD_REFERENCE.test(value)) {
      parsed.cards.push(Number(CARD_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === '--settled' && value !== undefined && CARD_REFERENCE.test(value)) {
      parsed.settled.push(Number(CARD_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === '--until' && value !== undefined && parsed.until === null && UNTIL_VALUE.test(value) && calendarTerm(value)) {
      parsed.until = value
      index += 1
    }
    else if (arg.startsWith('--')) {
      return null
    }
    else {
      texts.push(arg)
    }
  }
  if (texts.length !== 1)
    return null
  parsed.text = texts[0]!.trim()
  return parsed
}

export function sourceRefusal(text: string): string | null {
  if (text.startsWith(`${OWNER_SOURCE} `) && text.slice(OWNER_SOURCE.length).trim() !== '')
    return null
  const tag = SOURCE_TAG.exec(text)?.[0]
  const source = tag === undefined ? 'no source' : tag === OWNER_SOURCE ? 'an empty record' : `the source ${tag}`
  return `${PREFIX}${source}: decisions:add writes only the owner's own words, a record that starts with ${OWNER_SOURCE}; nothing written`
}

function wholeNumbersLeaving(decisions: readonly Decision[], outOfForce: ReadonlySet<number>): Decision[] {
  const leaving = decisions.filter(decision => decision.supersededBy !== null || outOfForce.has(decision.line))
  const staying = new Set(decisions.filter(decision => !leaving.includes(decision)).map(decision => decision.number))
  return leaving.filter(decision => !staying.has(decision.number))
}

export function planAdd(read: string, archive: string, { text: record, supersedes, cards, until }: AddArgs, now: Date, settled: (card: number) => boolean = () => false, held: readonly number[] = []): AddPlan | string {
  const text = settleSupersedes(read, archive)
  const { decisions } = parseDecisions(text)
  const outOfForce = outOfForceLines(decisions, now, settled)
  const archivedNumbers = parseDecisions(archive).decisions.map(decision => decision.number)
  const number = Math.max(0, ...decisions.map(decision => decision.number), ...archivedNumbers, ...held) + 1
  const lines = text.split('\n')
  for (const target of supersedes) {
    const records = decisions.filter(candidate => candidate.number === target)
    if (records.length === 0)
      return `${PREFIX}--supersedes D-${target}: not a decision in the file; nothing written`
    for (const decision of records.filter(record => record.supersededBy === null))
      lines[decision.line - 1] = `${lines[decision.line - 1]!.trimEnd()} · superseded-by D-${number}`
  }
  const marked = wholeNumbersLeaving(parseDecisions(lines.join('\n')).decisions, outOfForce)
  const movedLines = new Set(marked.map(decision => decision.line))
  const kept = lines.filter((_, index) => !movedLines.has(index + 1))
  const line = `- D-${number} · ${stampOf(now)} — ${record}${cardTail(cards)}${untilTail(until)} · ${WRITER_MARKER}`
  const moved = marked.map(decision => `${decision.text}\n`).join('')
  return {
    number,
    line,
    file: `${kept.join('\n').trimEnd()}\n${line}\n`,
    archive: moved === '' ? archive : `${archive === '' ? ARCHIVE_HEADER : archive.replace(/\n*$/, '\n')}${moved}`,
    archived: marked.map(decision => decision.number),
  }
}

const LOCK_ATTEMPTS = 50
const LOCK_PAUSE_MS = 100

export function lockFileOf(file: string): string {
  return `${file}.lock`
}

function holderOf(lockFile: string): string {
  try {
    return readFileSync(lockFile, 'utf8').trim()
  }
  catch {
    return ''
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockRefusal(lockFile: string): string {
  const holder = holderOf(lockFile)
  const named = /^[1-9]\d*$/.test(holder) ? `process ${holder}` : 'another decisions:add'
  return `${PREFIX}${lockFile} is held by ${named}; nothing written. Run decisions:add again; if no decisions:add is running, remove ${lockFile} first`
}

export function takeFileLock(lockFile: string, attempts = LOCK_ATTEMPTS, pauseMs = LOCK_PAUSE_MS): (() => void) | string {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const descriptor = openSync(lockFile, 'wx')
      writeSync(descriptor, String(process.pid))
      closeSync(descriptor)
      return () => rmSync(lockFile, { force: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      if (attempt + 1 < attempts)
        pause(pauseMs)
    }
  }
  return lockRefusal(lockFile)
}

function recordFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function runDecisionsAdd(args: string[], deps: DecisionsAddDeps): number {
  const parsed = parseArgs(args)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const source = sourceRefusal(parsed.text)
  if (source !== null) {
    deps.err(source)
    return 1
  }
  const file = parsed.file ?? deps.decisions
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no decisions at ${file}`)
    return 1
  }
  const release = (deps.lock ?? (target => takeFileLock(lockFileOf(target))))(file)
  if (typeof release === 'string') {
    deps.err(release)
    return 1
  }
  try {
    return addUnderLock(file, parsed, deps)
  }
  finally {
    release()
  }
}

function addUnderLock(file: string, parsed: Required<AddArgs>, deps: DecisionsAddDeps): number {
  const archiveFile = archiveOf(file)
  const original = deps.read(file)
  const archiveExisted = deps.exists(archiveFile)
  const originalArchive = archiveExisted ? deps.read(archiveFile) : ''
  const now = deps.now()
  const plan = planAdd(original, originalArchive, parsed, now, card => parsed.settled.includes(card) || deps.settled(card), deps.held?.() ?? [])
  if (typeof plan === 'string') {
    deps.err(plan)
    return 1
  }
  const holds = (target: string, text: string): boolean => deps.exists(target) && deps.read(target) === text
  const restore = (): void => {
    if (holds(file, plan.file))
      deps.write(file, original)
    if (plan.archive === originalArchive || !holds(archiveFile, plan.archive))
      return
    if (archiveExisted)
      deps.write(archiveFile, originalArchive)
    else
      deps.remove(archiveFile)
  }
  try {
    if (plan.archive !== originalArchive)
      deps.write(archiveFile, plan.archive)
    deps.write(file, plan.file)
  }
  catch (error) {
    restore()
    deps.err(`${PREFIX}D-${plan.number} not written: ${recordFailure(error)}; ${file} restored as it was`)
    return 1
  }
  const refusals = decisionsRefusals(deps.read(file), deps.exists(archiveFile) ? deps.read(archiveFile) : '')
  if (refusals.length > 0) {
    restore()
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}D-${plan.number} refused: ${refusals.length} refusals, ${file} restored as it was`)
    return 1
  }
  const written = parseDecisions(plan.line).decisions[0]!
  const supersedes = [...new Set([...parsed.supersedes, ...written.supersedes])]
  try {
    deps.record({ ts: now.toISOString(), decisionId: plan.number, text: boundText(written).slice(OWNER_SOURCE.length).trim(), cards: written.cards, ...(supersedes.length === 0 ? {} : { supersedes }) })
  }
  catch (error) {
    restore()
    deps.err(`${PREFIX}D-${plan.number} not recorded in the bus: ${recordFailure(error)}; ${file} restored as it was`)
    return 1
  }
  deps.out(plan.line)
  for (const number of plan.archived)
    deps.out(`${PREFIX}D-${number} moved to ${archiveFile}`)
  return 0
}

export function splitCreates(args: readonly string[]): { creates: string[], rest: string[] } {
  const creates: string[] = []
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1]
    if (args[index] === CREATES_FLAG && value !== undefined && !value.startsWith('--')) {
      creates.push(value)
      index += 1
    }
    else {
      rest.push(args[index]!)
    }
  }
  return { creates, rest }
}

function cardsNamed(args: readonly string[]): number[] {
  return args.flatMap((arg, index) => {
    const value = args[index + 1]
    return arg === '--card' && value !== undefined && CARD_REFERENCE.test(value) ? [Number(CARD_REFERENCE.exec(value)![1])] : []
  })
}

function decidesAtHead(text: string, pr: number, head: string): boolean {
  return namesPrAtHead(text, pr, head) || continueFixesDecisionOf([{ decisionId: 0, text, cards: [] }], pr, head, []) !== null
}

function closestHeadHint(sha: string, pr: number, heads: readonly string[], atHead: (head: string) => string): string {
  const extending = [...new Set(heads.filter(head => head.startsWith(sha.toLowerCase())))]
  if (extending.length === 1)
    return `the full head is ${extending[0]}: write "${atHead(extending[0]!)}"`
  if (extending.length > 1)
    return `${extending.length} observed heads of PR #${pr} start with ${sha}; name the full one`
  return heads.length === 0 ? `the bus observed no head of PR #${pr}` : `the latest observed head of PR #${pr} is ${heads.at(-1)}`
}

export function roundLimitHeadRefusal(text: string, observedHeads: (pr: number) => readonly string[]): string | null {
  const named = PR_AT_A_SHA.exec(text)
  if (named === null)
    return null
  const pr = Number(named[1])
  const sha = named[2]!
  const shaAt = named[0].length - sha.length
  const atHead = (head: string): string => `${text.slice(0, shaAt)}${head}${text.slice(named[0].length)}`
  if (!decidesAtHead(atHead(ANY_FULL_HEAD), pr, ANY_FULL_HEAD))
    return null
  const heads = observedHeads(pr)
  if (heads.includes(sha))
    return null
  return `${PREFIX}${sha} is not a full observed head of PR #${pr}: the bus reads an allow-merge or continue-fixes record only at a full 40-hex head it observed, so this one would never be answered; ${closestHeadHint(sha, pr, heads, atHead)}; nothing requested`
}

function headRefusalIn(args: readonly string[], db: DatabaseSync): string | null {
  return args.filter(arg => !arg.startsWith('--')).map(arg => roundLimitHeadRefusal(arg.trim(), pr => observedHeadsOf(db, pr))).find(refusal => refusal !== null) ?? null
}

function requestWidening(db: DatabaseSync, cards: readonly number[], creates: readonly string[], now: Date, session: string, out: (line: string) => void): boolean {
  const change = creates.map(file => `+${file}`).join(',')
  return cards.every(card => runRequest(['amend', '--card', String(card), '--touches', change, '--auto-confirm'], db, now, session, out) === 0)
}

export function requestDecision(args: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void): number {
  const { creates, rest } = splitCreates(args)
  const headRefusal = headRefusalIn(rest, db)
  if (headRefusal !== null) {
    out(headRefusal)
    return 1
  }
  if (creates.length > 0) {
    const cards = cardsNamed(rest)
    if (cards.length === 0) {
      out(`${PREFIX}${CREATES_FLAG} names a file a card's decision requires and needs --card; nothing requested`)
      return 2
    }
    if (!requestWidening(db, cards, creates, now, session, out))
      return 1
  }
  const lines: string[] = []
  const code = runRequest(['decisions:add', ...rest], db, now, session, line => lines.push(line))
  for (const line of lines)
    out(line)
  if (code === 0)
    out(`${PREFIX}not written yet: ${lines[0]?.match(/window\.request \d+/)?.[0] ?? 'the request'} waits for bus:run, which records it in the bus, rebuilds owner-decisions.md from the bus and answers ${REQUEST_DONE} or ${REQUEST_REFUSED}; while bus:run is down nothing is written`)
  return code
}

function requestFromThisWindow(session: string, args: string[]): number {
  const db = openBus(defaultBusPath())
  try {
    return requestDecision(args, db, new Date(), session, line => console.log(line))
  }
  finally {
    db.close()
  }
}

export function requestFromOwnerShell(args: string[], channel: string, db: DatabaseSync, now: Date, out: (line: string) => void, err: (line: string) => void): number {
  const parsed = parseArgs(splitCreates(args).rest)
  if (parsed === null || parsed.file !== null || parsed.settled.length > 0) {
    err(`${PREFIX}${OWNER_SHELL_USAGE}`)
    return 2
  }
  const source = sourceRefusal(parsed.text)
  if (source !== null) {
    err(source)
    return 1
  }
  const headRefusal = headRefusalIn([parsed.text], db)
  if (headRefusal !== null) {
    err(headRefusal)
    return 1
  }
  sayToOwnerChannel(channel, parsed.text.slice(OWNER_SOURCE.length), now)
  return requestDecision(['--from', 'answer', ...args], db, now, OWNER_SHELL_SESSION, out)
}

export function withOwnerShellBus(run: (db: DatabaseSync, channel: string) => number): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    return run(db, ownerChannelOfBus(os.homedir(), busPath))
  }
  finally {
    db.close()
  }
}

function requestFromThisShell(args: string[]): number {
  return withOwnerShellBus((db, channel) => requestFromOwnerShell(args, channel, db, new Date(), line => console.log(line), line => console.error(line)))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const windowSession = process.env[SESSION_VARIABLE]?.trim()
  process.exitCode = windowSession ? requestFromThisWindow(windowSession, process.argv.slice(2)) : requestFromThisShell(process.argv.slice(2))
}
