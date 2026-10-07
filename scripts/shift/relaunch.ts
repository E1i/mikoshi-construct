import type { ClaudeExit, ClaudeRun } from './claude.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { claudeProjectsDir } from '../../src/commands/cost/index.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { missingFields, refusal } from '../ghosts/handoff-check.js'
import { appendJournalEvent } from '../ghosts/journal.js'
import { CLAUDE_VARIABLE, runClaude } from './claude.js'
import { CONTINUE_PROMPT, MAX_RESTARTS } from './continuation.js'
import { GHOST_JOURNAL } from './places.js'

export const PREFIX = '[relaunch] '
export const USAGE = 'usage: pnpm relaunch <handoff.md> [--max N] [--model <id>]'
export const DEFAULT_CLAUDE = 'claude --permission-mode auto'
export const LAUNCH_LINE = 'pnpm ghosts:launch reads its yes from stdin and this session\'s stdin carries nothing a child can read: run it as echo yes | env -u FORCE_COLOR NO_COLOR=1 pnpm ghosts:launch ...'
export const RELAUNCH_PROMPT = `${CONTINUE_PROMPT}\n\n${LAUNCH_LINE}`
export const NO_MODEL = 'no model: pass --model <id>'

const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE)\b/
const SYNTHETIC_MODEL = '<synthetic>'

export type Status = 'CONTINUE' | 'OWNER' | 'DONE'

export interface RelaunchDeps {
  cwd: string
  claude: string | undefined
  journal: string
  projectsDir: string
  read: (file: string) => string
  listDir: (dir: string) => string[]
  modified: (file: string) => number
  now: () => Date
  uuid: () => string
  run: (run: ClaudeRun) => Promise<ClaudeExit>
  out: (line: string) => void
  err: (line: string) => void
}

interface RelaunchArgs {
  handoff: string
  max: number
  model: string | null
}

export function statusOf(text: string): Status | null {
  const found = text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? [])
  return (found.at(-1) as Status | undefined) ?? null
}

export function projectDirOf(projectsDir: string, cwd: string): string {
  return path.join(projectsDir, cwd.replaceAll('/', '-'))
}

function modelOfLine(line: string): string | null {
  try {
    const entry = JSON.parse(line) as { model?: unknown, message?: { model?: unknown } } | null
    const model = entry?.model ?? entry?.message?.model
    return typeof model === 'string' && model !== '' && model !== SYNTHETIC_MODEL ? model : null
  }
  catch {
    return null
  }
}

export function transcriptModel(deps: RelaunchDeps): string | null {
  const dir = projectDirOf(deps.projectsDir, deps.cwd)
  const newest = deps.listDir(dir)
    .filter(file => file.endsWith('.jsonl'))
    .map(file => path.join(dir, file))
    .sort((a, b) => deps.modified(b) - deps.modified(a))
    .at(0)
  if (newest === undefined)
    return null
  return deps.read(newest).split('\n').map(modelOfLine).filter(model => model !== null).at(-1) ?? null
}

function parseArgs(args: string[]): RelaunchArgs | null {
  let handoff: string | undefined
  let max = MAX_RESTARTS
  let model: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = args[index + 1]
    if (arg === '--max' || arg === '--model') {
      if (value === undefined || value.startsWith('--'))
        return null
      if (arg === '--max') {
        if (!/^[1-9]\d*$/.test(value))
          return null
        max = Number(value)
      }
      else {
        model = value
      }
      index += 1
    }
    else if (arg.startsWith('--') || handoff !== undefined) {
      return null
    }
    else {
      handoff = arg
    }
  }
  return handoff === undefined ? null : { handoff, max, model }
}

function readHandoff(deps: RelaunchDeps, handoff: string): string | null {
  try {
    return deps.read(handoff)
  }
  catch {
    return null
  }
}

async function record(deps: RelaunchDeps, event: object): Promise<void> {
  mkdirSync(path.dirname(deps.journal), { recursive: true })
  await appendJournalEvent(deps.journal, event)
}

export async function runRelaunch(args: string[], deps: RelaunchDeps): Promise<number> {
  const parsed = parseArgs(args)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 1
  }
  const handoff = path.resolve(deps.cwd, parsed.handoff)
  let sessions = 0
  const stop = async (reason: string, code: number): Promise<number> => {
    await record(deps, { event: 'relaunch-stop', handoff, reason, sessions, ts: deps.now().toISOString() })
    if (code === 0)
      deps.out(`${PREFIX}${reason}`)
    else
      deps.err(`${PREFIX}${reason}`)
    return code
  }
  const model = parsed.model ?? transcriptModel(deps)
  if (model === null)
    return stop(NO_MODEL, 1)
  const command = deps.claude ?? DEFAULT_CLAUDE
  for (;;) {
    const text = readHandoff(deps, handoff)
    if (text === null)
      return stop(`no handoff at ${handoff}`, 1)
    const missing = missingFields(text)
    if (missing.length > 0) {
      for (const line of refusal(missing))
        deps.err(line)
      return stop(`${handoff} fails handoff:check: ${missing.length} fields missing`, 1)
    }
    const status = statusOf(text)
    if (status === null)
      return stop('no STATUS line', 1)
    if (status !== 'CONTINUE')
      return stop(`STATUS ${status}`, 0)
    if (sessions >= parsed.max)
      return stop(`max ${parsed.max} reached`, 0)
    sessions += 1
    const session = deps.uuid()
    deps.out(`${PREFIX}session ${sessions}/${parsed.max} ${session} on ${model}`)
    const exit = await deps.run({ command, cwd: deps.cwd, sessionId: session, prompt: RELAUNCH_PROMPT, log: `${handoff}.relaunch-${sessions}.log`, extraArgv: ['--model', model] })
    await record(deps, {
      event: 'relaunch',
      handoff,
      session,
      model,
      n: sessions,
      exit: exit.kind === 'exited' ? exit.code : null,
      status: statusOf(readHandoff(deps, handoff) ?? '') ?? 'none',
      ts: deps.now().toISOString(),
    })
  }
}

function realDeps(): RelaunchDeps {
  return {
    cwd: process.cwd(),
    claude: process.env[CLAUDE_VARIABLE],
    journal: path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL),
    projectsDir: claudeProjectsDir(),
    read: file => readFileSync(file, 'utf8'),
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    modified: file => statSync(file).mtimeMs,
    now: () => new Date(),
    uuid: randomUUID,
    run: runClaude,
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runRelaunch(process.argv.slice(2), realDeps())
