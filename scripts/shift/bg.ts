import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { ANSWER_FLAG } from './answer.js'
import { GHOST_JOURNAL, SHIFT_JOURNAL } from './places.js'

export const PREFIX = '[shift:bg] '
export const USAGE = 'usage: pnpm shift:bg <dir> [shift arguments]'
export const BG_LOG = 'shift-bg.log'

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

const ANSWERABLE_STOPS: readonly unknown[] = ['question', 'merge']

interface JournalLine {
  event?: unknown
  task?: unknown
  at?: unknown
  shift?: unknown
}

function lastLineInShift(journal: string, task: string, dir: string): JournalLine | undefined {
  return journal.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as JournalLine | null
      return entry?.task === task && typeof entry.shift === 'string' && path.resolve(entry.shift) === dir ? [entry] : []
    }
    catch {
      return []
    }
  }).at(-1)
}

export function answerRefusal(journalFile: string, task: string | undefined, dir: string): string | null {
  if (task === undefined)
    return `${ANSWER_FLAG} names no card`
  const journal = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : ''
  const last = lastLineInShift(journal, task, path.resolve(dir))
  if (last === undefined)
    return `#${task} has no journal line in ${journalFile} for the shift ${dir}, so it has no stop to answer`
  if (last.event !== 'stop' || !ANSWERABLE_STOPS.includes(last.at))
    return `the last journal line of #${task} in the shift ${dir} is event:${String(last.event)}${last.event === 'stop' ? ` at ${String(last.at)}` : ''}, not a question or review stop, so ${ANSWER_FLAG} has nothing to answer`
  return null
}

export function launchArgv(shiftArgs: string[]): string[] {
  return ['nohup', 'pnpm', 'shift', ...shiftArgs]
}

export function runBg(argv: string[], env: NodeJS.ProcessEnv = process.env): BgResult {
  const dir = argv[0]
  if (dir === undefined || dir.startsWith('-'))
    return { stdout: [], stderr: [USAGE], exitCode: 2 }
  const answerAt = argv.indexOf(ANSWER_FLAG)
  if (answerAt !== -1) {
    const journal = path.join(env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
    const refusal = answerRefusal(journal, argv[answerAt + 1]?.replace(/^#/, ''), dir)
    if (refusal !== null)
      return { stdout: [], stderr: [`${PREFIX}${refusal}; nothing started`], exitCode: 1 }
  }
  else if (existsSync(path.join(dir, SHIFT_JOURNAL))) {
    return { stdout: [], stderr: [`${PREFIX}${path.join(dir, SHIFT_JOURNAL)} exists — that shift already ran; pnpm shift refuses it`], exitCode: 1 }
  }
  mkdirSync(dir, { recursive: true })
  const log = path.resolve(dir, BG_LOG)
  const [command, ...args] = launchArgv(argv)
  const fd = openSync(log, 'a')
  try {
    const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.on('error', () => {})
    child.unref()
    if (child.pid === undefined)
      return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
    return { stdout: [String(child.pid), `${PREFIX}pnpm shift ${argv.join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
  }
  finally {
    closeSync(fd)
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runBg(process.argv.slice(2))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
