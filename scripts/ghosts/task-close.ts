import type { Card } from './card.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { VERIFICATION_WORDS } from '../board/verification.js'

export const PREFIX = '[task:close] '
export const USAGE = 'usage: pnpm task:close <id> (--pr <N> | --report <path>) --verification <word>'
const FLAGS = ['--pr', '--report', '--verification'] as const
const PR_NUMBER = /^[1-9]\d*$/
const OUTCOME_OF_KIND: Record<Card['kind'], typeof FLAGS[number]> = { implement: '--pr', probe: '--report' }

type Flag = typeof FLAGS[number]

interface StartLine {
  event: 'path'
  task: string
  path: string
  card: Card
}

export interface TaskCloseDeps {
  cwd: string
  read: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
  handoffDir: string
}

export interface TaskCloseResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
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

function isStartLine(entry: unknown, id: string): entry is StartLine {
  const line = entry as Partial<StartLine> | null
  return line?.event === 'path' && line.task === id && typeof line.card === 'object' && line.card !== null
}

function startLineOf(journal: string, id: string): StartLine | undefined {
  return journal.split('\n').flatMap((text) => {
    try {
      const entry: unknown = JSON.parse(text)
      return isStartLine(entry, id) ? [entry] : []
    }
    catch {
      return []
    }
  }).at(-1)
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
  const journal = path.join(deps.handoffDir, 'ghosts.jsonl')
  const start = startLineOf(deps.read(journal) ?? '', id)
  if (start === undefined)
    return refuse(`${journal} has no task:start line with a card for #${id}; start the task with pnpm task:start <branch> --card "<card>"; nothing written`)
  const outcome = OUTCOME_OF_KIND[start.card.kind]
  const other = outcome === '--pr' ? '--report' : '--pr'
  if (flags.has(other) || !flags.has(outcome))
    return refuse(`#${id} is kind ${start.card.kind}, which closes with ${outcome} only; nothing written`)
  const value = flags.get(outcome)!
  if (outcome === '--pr' && !PR_NUMBER.test(value))
    return refuse(`--pr '${value}' is not a pull request number; nothing written`)
  const report = path.resolve(deps.cwd, value)
  const closing = outcome === '--pr' ? { pr: Number(value) } : { report }
  const line = { event: 'path', task: id, path: start.path, ...closing, verification, ts: deps.now().toISOString() }
  try {
    deps.append(journal, `${JSON.stringify(line)}\n`)
  }
  catch (error) {
    return refuse(`the closing line could not be written to ${journal}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  return { stdout: [`${PREFIX}#${id} closed with ${outcome === '--pr' ? `PR #${value}` : `report ${report}`}, verification ${verification}; line written to ${journal}`], stderr: [], exitCode: 0 }
}

function realDeps(): TaskCloseDeps {
  return {
    cwd: process.cwd(),
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
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
