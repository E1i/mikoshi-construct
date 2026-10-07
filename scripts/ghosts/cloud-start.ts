import type { Card } from '../../src/card/grammar.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cardLine, parseCard } from '../../src/card/grammar.js'
import { INTAKE_EVENT } from '../../src/commands/intake/confirm.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'

export const PREFIX = '[cloud-start] '
export const USAGE = 'usage: cloud-start.ts <run-id> --card "<card>" [--journal <path>]'
export const CLOUD_START_EVENT = 'cloud-start'
const CARD_FLAG = '--card'
const JOURNAL_FLAG = '--journal'
const BASE_REF = 'origin/main'

export interface CloudStartDeps {
  read: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
  handoffDir: string
  base: () => string | null
}

export interface CloudStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

function refuse(message: string): CloudStartResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function readArgs(argv: string[]): { runId: string | undefined, card: string, journal: string | undefined } | string {
  const values = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (arg !== CARD_FLAG && arg !== JOURNAL_FLAG)
      return `unknown flag ${arg}`
    const value = argv[++index]
    if (value === undefined || value.startsWith('--'))
      return `${arg} needs a value`
    values.set(arg, value)
  }
  const card = values.get(CARD_FLAG)
  if (card === undefined)
    return `${CARD_FLAG} is required`
  if (positional.length > 1)
    return 'one run id is needed'
  return { runId: positional[0], card, journal: values.get(JOURNAL_FLAG) }
}

function intakeAdmits(journal: string | null, card: Card): boolean {
  return (journal ?? '').split('\n').some((text) => {
    try {
      const entry = JSON.parse(text) as Record<string, unknown> | null
      if (entry?.event !== INTAKE_EVENT || entry.task !== String(card.id) || typeof entry.card !== 'string')
        return false
      const recorded = parseCard(entry.card)
      return recorded.kind === 'card' && cardLine(recorded.card) === cardLine(card)
    }
    catch {
      return false
    }
  })
}

function earlierStartRun(journal: string | null, card: Card): string | undefined {
  for (const text of (journal ?? '').split('\n')) {
    try {
      const entry = JSON.parse(text) as Record<string, unknown> | null
      if (entry?.event === CLOUD_START_EVENT && entry.task === String(card.id))
        return String(entry.run)
    }
    catch {}
  }
  return undefined
}

export function runCloudStart(argv: string[], deps: CloudStartDeps): CloudStartResult {
  const args = readArgs(argv)
  if (typeof args === 'string')
    return refuse(`${args}; ${USAGE}; nothing written`)
  if (args.runId === undefined || args.runId.trim() === '')
    return refuse(`a run id is needed: the routine trigger id or the cloud session id; ${USAGE}; nothing written`)
  const parsed = parseCard(args.card)
  if (parsed.kind === 'refused')
    return refuse(`card refused: ${parsed.reason}; nothing written`)
  const { card } = parsed
  const journal = args.journal ?? path.join(deps.handoffDir, 'ghosts.jsonl')
  const recorded = deps.read(journal)
  if (!intakeAdmits(recorded, card))
    return refuse(`card #${card.id} has no intake line in ${journal} that confirms this card: slice and confirm it with construct intake; nothing written`)
  const earlierRun = earlierStartRun(recorded, card)
  if (earlierRun !== undefined)
    return refuse(`card #${card.id} already has a cloud-start line in ${journal} (run ${earlierRun}): one card, one start; nothing written`)
  const at = deps.now().toISOString()
  const line = { event: CLOUD_START_EVENT, task: String(card.id), card, run: args.runId, base: deps.base(), ts: at }
  try {
    deps.append(journal, `${JSON.stringify(line)}\n`)
  }
  catch (error) {
    return refuse(`the start line could not be written to ${journal}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  return { stdout: [`${PREFIX}#${card.id} ${card.name} run ${args.runId} · start line written to ${journal}`], stderr: [], exitCode: 0 }
}

function realDeps(): CloudStartDeps {
  return {
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    base: () => {
      try {
        return execFileSync('git', ['rev-parse', BASE_REF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      }
      catch {
        return null
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCloudStart(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
