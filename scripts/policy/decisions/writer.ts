import type { Decision } from './decisions.js'
import type { OwnerDecision } from './index.js'
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import process from 'node:process'
import { pnpmCommand } from '../../core/owner-commands.js'
import { boundText, calendarTerm, cardTail, decisionsRefusals, outOfForceLines, OWNER_SOURCE, parseDecisions, PREFIX, settleSupersedes, stampOf, untilTail, WRITER_MARKER } from './decisions.js'
import { archiveOf } from './read.js'

export const ADD_COMMAND = pnpmCommand('decisions:add')
export const FILE_FLAG = '--file'
export const SUPERSEDES_FLAG = '--supersedes'
export const CARD_FLAG = '--card'
export const SETTLED_FLAG = '--settled'
export const UNTIL_FLAG = '--until'
export const USAGE = `usage: ${ADD_COMMAND} [--file <owner-decisions.md>] [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] [--settled #N]... "[owner] <decision>"`
export const ARCHIVE_HEADER = `# Owner decisions archive\n\nSuperseded decisions, moved here from the decisions file by ${ADD_COMMAND}.\n\n`

const SOURCE_TAG = /^\[[^\]]*\]/
const DECISION_REFERENCE = /^D-([1-9]\d*)$/
export const CARD_REFERENCE = /^#?([1-9]\d*)$/
const UNTIL_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/

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

export function parseArgs(args: readonly string[]): Required<AddArgs> | null {
  const parsed: Required<AddArgs> = { file: null, supersedes: [], cards: [], until: null, settled: [], text: '' }
  const texts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = args[index + 1]
    if (arg === FILE_FLAG && value !== undefined && parsed.file === null) {
      parsed.file = value
      index += 1
    }
    else if (arg === SUPERSEDES_FLAG && value !== undefined && DECISION_REFERENCE.test(value)) {
      parsed.supersedes.push(Number(DECISION_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === CARD_FLAG && value !== undefined && CARD_REFERENCE.test(value)) {
      parsed.cards.push(Number(CARD_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === SETTLED_FLAG && value !== undefined && CARD_REFERENCE.test(value)) {
      parsed.settled.push(Number(CARD_REFERENCE.exec(value)![1]))
      index += 1
    }
    else if (arg === UNTIL_FLAG && value !== undefined && parsed.until === null && UNTIL_VALUE.test(value) && calendarTerm(value)) {
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
