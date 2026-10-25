import type { DatabaseSync } from 'node:sqlite'
import type { OwnerDecision } from '../decisions.js'
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../../core/db.js'
import { REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { busHistory } from '../../core/journal.js'
import { busCardStates } from '../../core/tasks.js'
import { runRequest, SESSION_VARIABLE } from '../../window/window-requests.js'
import { recordDecision } from '../decisions.js'
import { calendarTerm, DECISIONS_IN_FORCE_LIMIT, decisionsRefusals, inForceBytes, outOfForceLines, OWNER_SOURCE, parseDecisions, PREFIX, settleSupersedes, WRITER_MARKER } from './decisions.js'
import { archiveOf, defaultDecisions, settledCards } from './read.js'

export const USAGE = 'usage: pnpm decisions:add [--file <owner-decisions.md>] [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] [--settled #N]... "[owner] <decision>"'
export const ARCHIVE_HEADER = '# Owner decisions archive\n\nSuperseded decisions, moved here from the decisions file by pnpm decisions:add.\n\n'

const SOURCE_TAG = /^\[[^\]]*\]/
const DECISION_REFERENCE = /^D-([1-9]\d*)$/
const CARD_REFERENCE = /^#?([1-9]\d*)$/
const UNTIL_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/

export interface DecisionsAddDeps {
  home: string
  now: () => Date
  exists: (file: string) => boolean
  read: (file: string) => string
  write: (file: string, text: string) => void
  remove: (file: string) => void
  record: (decision: OwnerDecision) => void
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

export function stampOf(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10)} ~${iso.slice(11, 16)}Z`
}

function cardTail(cards: readonly number[]): string {
  return cards.length === 0 ? '' : ` · card ${[...new Set(cards)].map(card => `#${card}`).join(' ')}`
}

function untilTail(until: string | null): string {
  return until === null ? '' : ` · until ${until}`
}

export function planAdd(read: string, archive: string, { text: record, supersedes, cards, until }: AddArgs, now: Date, settled: (card: number) => boolean = () => false): AddPlan | string {
  const text = settleSupersedes(read, archive)
  const { decisions } = parseDecisions(text)
  const outOfForce = outOfForceLines(decisions, now, settled)
  const archivedNumbers = parseDecisions(archive).decisions.map(decision => decision.number)
  const number = Math.max(0, ...decisions.map(decision => decision.number), ...archivedNumbers) + 1
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
  const file = parsed.file ?? defaultDecisions(deps.home)
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no decisions at ${file}`)
    return 1
  }
  const archiveFile = archiveOf(file)
  const original = deps.read(file)
  const archiveExisted = deps.exists(archiveFile)
  const originalArchive = archiveExisted ? deps.read(archiveFile) : ''
  const now = deps.now()
  const plan = planAdd(original, originalArchive, parsed, now, card => parsed.settled.includes(card) || deps.settled(card))
  if (typeof plan === 'string') {
    deps.err(plan)
    return 1
  }
  const bytes = inForceBytes(parseDecisions(plan.file).decisions)
  if (bytes > DECISIONS_IN_FORCE_LIMIT) {
    deps.err(`${PREFIX}decisions in force would be ${bytes} bytes, over the limit of ${DECISIONS_IN_FORCE_LIMIT} after the superseded, spent and lapsed ones go to the archive; decisions in force are never moved, so this is a question for the owner; nothing written`)
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
  try {
    deps.record({ ts: now.toISOString(), decisionId: plan.number, text: `${parsed.text.slice(OWNER_SOURCE.length).trim()}${untilTail(parsed.until)}`, cards: [...new Set(parsed.cards)] })
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

function recordInBus(decision: OwnerDecision): void {
  const db = openBus(defaultBusPath())
  try {
    recordDecision(db, decision)
  }
  finally {
    db.close()
  }
}

function settledCardsOnThisMachine(): (card: number) => boolean {
  const cards = settledCards(busHistory(defaultBusPath()), busCardStates(defaultBusPath()))
  return card => cards.has(card)
}

export function requestDecision(args: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void): number {
  const lines: string[] = []
  const code = runRequest(['decisions:add', ...args], db, now, session, line => lines.push(line))
  for (const line of lines)
    out(line)
  if (code === 0)
    out(`${PREFIX}not written yet: ${lines[0]?.match(/window\.request \d+/)?.[0] ?? 'the request'} waits for bus:run, which writes it into owner-decisions.md outside the sandbox and answers ${REQUEST_DONE} or ${REQUEST_REFUSED}; while bus:run is down nothing is written`)
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

function writeOnThisMachine(args: string[]): number {
  return runDecisionsAdd(args, {
    home: os.homedir(),
    now: () => new Date(),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    remove: unlinkSync,
    record: recordInBus,
    settled: settledCardsOnThisMachine(),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const windowSession = process.env[SESSION_VARIABLE]?.trim()
  process.exitCode = windowSession ? requestFromThisWindow(windowSession, process.argv.slice(2)) : writeOnThisMachine(process.argv.slice(2))
}
