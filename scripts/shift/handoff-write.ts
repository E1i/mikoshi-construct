import type { ParkedDepends } from '../ghosts/handoff-check.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { defaultParking, handoffRefusals, NO_PREV, parkedDepends, PREV_LABEL } from '../ghosts/handoff-check.js'

export const PREFIX = '[handoff:write] '
export const USAGE = 'usage: pnpm handoff:write <handoff.md> <draft.md> [--parking <dir>]'
export const ARCHIVE_DIR = 'archive'

const ARCHIVED = /^(\d{4,})\.md$/
const STOP_HEADING = /^#{1,6} +STOP\b/
const PREV_LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?${PREV_LABEL}:`, 'i')

export interface HandoffWriteDeps {
  cwd: string
  handoffDir: string | undefined
  exists: (file: string) => boolean
  read: (file: string) => string
  listDir: (dir: string) => string[]
  makeDir: (dir: string) => void
  write: (file: string, text: string) => void
  writeNew: (file: string, text: string) => void
  rename: (from: string, to: string) => void
  parked: (parking: string) => ParkedDepends
  home: string
  out: (line: string) => void
  err: (line: string) => void
}

export function nextArchive(names: readonly string[]): string {
  const taken = names.flatMap(name => ARCHIVED.exec(name)?.[1] ?? []).map(Number)
  return `${String(Math.max(0, ...taken) + 1).padStart(4, '0')}.md`
}

export function withPrev(draft: string, prev: string): string {
  const lines = draft.split(/\r?\n/).filter(line => !PREV_LINE.test(line))
  const stop = lines.findIndex(line => STOP_HEADING.test(line))
  lines.splice(stop + 1, 0, `${PREV_LABEL}: ${prev}`)
  return lines.join('\n')
}

function parseArgs(args: string[]): { handoff: string, draft: string, parking: string | null } | null {
  const [handoff, draft, ...rest] = args
  if (handoff === undefined || draft === undefined || handoff.startsWith('--') || draft.startsWith('--'))
    return null
  if (rest.length === 0)
    return { handoff, draft, parking: null }
  return rest.length === 2 && rest[0] === '--parking' ? { handoff, draft, parking: rest[1]! } : null
}

export function runHandoffWrite(args: string[], deps: HandoffWriteDeps): number {
  const parsed = parseArgs(args)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const draft = path.resolve(deps.cwd, parsed.draft)
  if (!deps.exists(draft)) {
    deps.err(`${PREFIX}no draft at ${draft}`)
    return 1
  }
  const handoff = path.resolve(deps.handoffDir ?? deps.cwd, parsed.handoff)
  const archiveDir = path.join(path.dirname(handoff), ARCHIVE_DIR)
  const previous = deps.exists(handoff) ? deps.read(handoff) : null
  const archived = previous === null ? null : path.join(archiveDir, nextArchive(deps.exists(archiveDir) ? deps.listDir(archiveDir) : []))
  const prev = archived === null ? NO_PREV : path.relative(path.dirname(handoff), archived)
  const text = withPrev(deps.read(draft), prev)
  const refusals = handoffRefusals(text, {
    file: handoff,
    exists: file => file === archived || deps.exists(file),
    parked: deps.parked(parsed.parking ?? defaultParking(deps.home)),
  })
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${draft} refused: nothing archived, ${handoff} unchanged`)
    return 1
  }
  if (archived !== null && previous !== null) {
    deps.makeDir(archiveDir)
    deps.writeNew(archived, previous)
  }
  const staged = `${handoff}.writing`
  deps.write(staged, text.endsWith('\n') ? text : `${text}\n`)
  deps.rename(staged, handoff)
  deps.out(`${PREFIX}${handoff}: ${text.length} chars, ${PREV_LABEL}: ${prev}`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runHandoffWrite(process.argv.slice(2), {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE],
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: parkedDepends,
    home: os.homedir(),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}
