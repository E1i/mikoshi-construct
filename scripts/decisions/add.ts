import type { OwnerDecision } from '../bus/decisions.js'
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../bus/db.js'
import { recordDecision } from '../bus/decisions.js'
import { DECISIONS_IN_FORCE_LIMIT, decisionsRefusals, inForceBytes, parseDecisions, PREFIX, WRITER_MARKER } from './decisions.js'
import { archiveOf, defaultDecisions } from './read.js'

export const USAGE = 'usage: pnpm decisions:add [--file <owner-decisions.md>] [--supersedes D-M]... [--card #N]... "[owner] <decision>"'
export const OWNER_SOURCE = '[owner]'
export const ARCHIVE_HEADER = '# Owner decisions archive\n\nSuperseded decisions, moved here from the decisions file by pnpm decisions:add.\n\n'

const SOURCE_TAG = /^\[[^\]]*\]/
const DECISION_REFERENCE = /^D-([1-9]\d*)$/
const CARD_REFERENCE = /^#?([1-9]\d*)$/

export interface DecisionsAddDeps {
  home: string
  now: () => Date
  exists: (file: string) => boolean
  read: (file: string) => string
  write: (file: string, text: string) => void
  remove: (file: string) => void
  record: (decision: OwnerDecision) => void
  out: (line: string) => void
  err: (line: string) => void
}

interface AddArgs {
  file: string | null
  supersedes: number[]
  cards: number[]
  text: string
}

export interface AddPlan {
  number: number
  line: string
  file: string
  archive: string
  archived: number[]
}

function parseArgs(args: readonly string[]): AddArgs | null {
  const parsed: AddArgs = { file: null, supersedes: [], cards: [], text: '' }
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

export function planAdd(text: string, archive: string, record: string, supersedes: readonly number[], cards: readonly number[], now: Date): AddPlan | string {
  const { decisions } = parseDecisions(text)
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
  const marked = parseDecisions(lines.join('\n')).decisions.filter(decision => decision.supersededBy !== null)
  const movedLines = new Set(marked.map(decision => decision.line))
  const kept = lines.filter((_, index) => !movedLines.has(index + 1))
  const line = `- D-${number} · ${stampOf(now)} — ${record}${cardTail(cards)} · ${WRITER_MARKER}`
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
  const plan = planAdd(original, originalArchive, parsed.text, parsed.supersedes, parsed.cards, now)
  if (typeof plan === 'string') {
    deps.err(plan)
    return 1
  }
  const bytes = inForceBytes(parseDecisions(plan.file).decisions)
  if (bytes > DECISIONS_IN_FORCE_LIMIT) {
    deps.err(`${PREFIX}decisions in force would be ${bytes} bytes, over the limit of ${DECISIONS_IN_FORCE_LIMIT} after the superseded ones go to the archive; nothing written`)
    return 1
  }
  const restore = (): void => {
    deps.write(file, original)
    if (archiveExisted)
      deps.write(archiveFile, originalArchive)
    else if (deps.exists(archiveFile))
      deps.remove(archiveFile)
  }
  if (plan.archive !== originalArchive)
    deps.write(archiveFile, plan.archive)
  deps.write(file, plan.file)
  const refusals = decisionsRefusals(deps.read(file), deps.exists(archiveFile) ? deps.read(archiveFile) : '')
  if (refusals.length > 0) {
    restore()
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}D-${plan.number} refused: ${refusals.length} refusals, ${file} restored as it was`)
    return 1
  }
  try {
    deps.record({ ts: now.toISOString(), decisionId: plan.number, text: parsed.text.slice(OWNER_SOURCE.length).trim(), cards: [...new Set(parsed.cards)] })
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsAdd(process.argv.slice(2), {
    home: os.homedir(),
    now: () => new Date(),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    remove: unlinkSync,
    record: recordInBus,
    out: line => console.log(line),
    err: line => console.error(line),
  })
}
