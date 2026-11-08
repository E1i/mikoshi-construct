import type { DatabaseSync } from 'node:sqlite'
import type { AdmitResult } from '../../../src/commands/intake/admit.js'
import type { OwnerDecision } from '../decisions.js'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runAmend } from '../../../src/commands/intake/amend.js'
import { defaultBusPath, openBus } from '../../core/db.js'
import { REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { busIntakePorts } from '../../intake/intake.js'
import { ownerChannelOfBus, sayToOwnerChannel } from '../../owner/channel.js'
import { runRequest, SESSION_VARIABLE } from '../../window/window-requests.js'
import { boundText, calendarTerm, cardTail, decisionsRefusals, outOfForceLines, OWNER_SOURCE, parseDecisions, PREFIX, settleSupersedes, stampOf, untilTail, WRITER_MARKER } from './decisions.js'
import { archiveOf } from './read.js'

export const USAGE = 'usage: pnpm decisions:add [--file <owner-decisions.md>] [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] [--settled #N]... "[owner] <decision>"'
export const OWNER_SHELL_USAGE = 'usage: pnpm decisions:add [--supersedes D-M]... [--card #N]... [--creates <path>]... [--until <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>"'
export const ARCHIVE_HEADER = '# Owner decisions archive\n\nSuperseded decisions, moved here from the decisions file by pnpm decisions:add.\n\n'

const SOURCE_TAG = /^\[[^\]]*\]/
const DECISION_REFERENCE = /^D-([1-9]\d*)$/
const CARD_REFERENCE = /^#?([1-9]\d*)$/
const UNTIL_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/
const OWNER_SHELL_SESSION = 'owner-shell'
const CREATES_FLAG = '--creates'

export interface DecisionsAddDeps {
  decisions: string
  now: () => Date
  exists: (file: string) => boolean
  read: (file: string) => string
  write: (file: string, text: string) => void
  remove: (file: string) => void
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

export function planAdd(read: string, archive: string, { text: record, supersedes, cards, until }: AddArgs, now: Date, settled: (card: number) => boolean = () => false, held: readonly number[] = []): AddPlan | string {
  const text = settleSupersedes(read, archive)
  const { decisions } = parseDecisions(text)
  const outOfForce = outOfForceLines(decisions, now, settled)
  const archivedNumbers = parseDecisions(archive).decisions.map(decision => decision.number)
  const number = Math.max(0, ...decisions.map(decision => decision.number), ...archivedNumbers, ...held) + 1
  const lines = text.split('\n')
  for (const target of supersedes) {
    const decision = decisions.find(candidate => candidate.number === target)
    if (decision === undefined)
      return `${PREFIX}--supersedes D-${target}: not a decision in the file; nothing written`
    if (decision.supersededBy === null)
      lines[decision.line - 1] = `${lines[decision.line - 1]!.trimEnd()} · superseded-by D-${number}`
  }
  const marked = parseDecisions(lines.join('\n')).decisions.filter(decision => decision.supersededBy !== null || outOfForce.has(decision.line))
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
  const restore = (): void => {
    deps.write(file, original)
    if (archiveExisted)
      deps.write(archiveFile, originalArchive)
    else if (deps.exists(archiveFile))
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

function amendRefusal(result: AdmitResult): string {
  if (result.status === 'refused')
    return result.why
  if ('reasons' in result)
    return result.reasons.join('; ')
  return `the amend ended ${result.status}`
}

function widenCards(db: DatabaseSync, cards: readonly number[], creates: readonly string[], dir: string, now: Date, out: (line: string) => void): boolean {
  const ports = busIntakePorts(db)
  const change = creates.map(file => `+${file}`).join(',')
  return cards.every((card) => {
    const result = runAmend({ card: `#${card}`, flags: { touches: change, creates: change }, dir, dryRun: false, autoConfirm: true, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => now)
    const widened = result.status === 'admitted' || result.status === 'alreadyAdmitted'
    out(widened ? `${PREFIX}#${card}: ${creates.join(', ')} added to its touches and creates` : `${PREFIX}#${card}: ${creates.join(', ')} not added to its touches, nothing requested: ${amendRefusal(result)}`)
    return widened
  })
}

export function requestDecision(args: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void, dir: string = process.cwd()): number {
  const { creates, rest } = splitCreates(args)
  if (creates.length > 0) {
    const cards = cardsNamed(rest)
    if (cards.length === 0) {
      out(`${PREFIX}${CREATES_FLAG} names a file a card's decision requires and needs --card; nothing requested`)
      return 2
    }
    if (!widenCards(db, cards, creates, dir, now, out))
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
  sayToOwnerChannel(channel, parsed.text.slice(OWNER_SOURCE.length), now)
  return requestDecision(['--from', 'answer', ...args], db, now, OWNER_SHELL_SESSION, out)
}

function requestFromThisShell(args: string[]): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    return requestFromOwnerShell(args, ownerChannelOfBus(os.homedir(), busPath), db, new Date(), line => console.log(line), line => console.error(line))
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const windowSession = process.env[SESSION_VARIABLE]?.trim()
  process.exitCode = windowSession ? requestFromThisWindow(windowSession, process.argv.slice(2)) : requestFromThisShell(process.argv.slice(2))
}
