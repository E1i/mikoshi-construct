import type { StartContext } from '../ports/client/claude/adapter.js'
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { lastSessionPrompted, startContextOf } from '../ports/client/claude/adapter.js'
import { MIKO_HANDOFF_NAME } from './loop.js'

export const FIRST_TURN_LIMIT = 45_000
export const FIRST_WATCH_LIMIT = 70_000
export const WATCH_MARKER = 'miko:watch'
const LAST_FLAG = '--last'

export interface StartVerdict {
  pass: boolean
  lines: string[]
}

function lineOf(name: string, value: number | null, limit: number): string {
  return `${name}: ${value ?? 'none'} (limit ${limit})`
}

export function verdictOf(context: StartContext): StartVerdict {
  const firstTurnOk = context.firstTurn !== null && context.firstTurn <= FIRST_TURN_LIMIT
  const atWatchOk = context.atMarker !== null && context.atMarker <= FIRST_WATCH_LIMIT
  return {
    pass: firstTurnOk && atWatchOk,
    lines: [lineOf('first turn', context.firstTurn, FIRST_TURN_LIMIT), lineOf(`first ${WATCH_MARKER}`, context.atMarker, FIRST_WATCH_LIMIT)],
  }
}

export function startContextReport(env: NodeJS.ProcessEnv, worktree: string, args: readonly string[]): StartVerdict {
  if (!args.includes(LAST_FLAG))
    return { pass: false, lines: [`usage: start-context.ts ${LAST_FLAG}`] }
  const transcript = lastSessionPrompted(env, worktree, MIKO_HANDOFF_NAME)
  if (transcript === null)
    return { pass: false, lines: [`no window session in ${worktree}`] }
  const verdict = verdictOf(startContextOf(readFileSync(transcript, 'utf8'), WATCH_MARKER))
  return { ...verdict, lines: [transcript, ...verdict.lines, verdict.pass ? 'pass' : 'fail'] }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = startContextReport(process.env, process.cwd(), process.argv.slice(2))
  process.stdout.write(`${report.lines.join('\n')}\n`)
  process.exitCode = report.pass ? 0 : 1
}
