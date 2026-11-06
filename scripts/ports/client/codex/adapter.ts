import type { ClientAdapter, Invocation, ModelPick, ReadBudget, Refusal, SessionPlace, SessionReading, SessionSpec, ToolUse, Usage } from '../contract.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const CODEX_COMMAND = 'codex'
const ARGV_HEAD_NAMING_THE_PROGRAM = 2
const READ_ONLY_HEADLESS = ['exec', '--json', '-s', 'read-only'] as const
const TREE_FLAG = '-C'
const MODEL_FLAG = '-m'
const FAILED_WITH_NO_TEXT = 'the client reported a failed turn and no text'

const ONLY_READ_ONLY_REVIEW = 'this client runs only a read-only review session (Q167)'
const NO_RESUME_OF_REVIEW = 'this client starts a read-only review session and never resumes one: resume takes neither the tree nor the sandbox flag (Q167)'
const NO_PROCESS_READING = 'this client has no reading of the working directories of its processes'
const NO_BUDGET_READING: ReadBudget = { startContext: null, readBeforeEdit: null }

type RawEntry = Record<string, unknown>

function reviewInvocation(spec: SessionSpec): Invocation {
  const model = spec.pick.model === null ? [] : [MODEL_FLAG, spec.pick.model]
  return { command: CODEX_COMMAND, args: [...READ_ONLY_HEADLESS, TREE_FLAG, spec.cwd, ...model, spec.prompt], env: {}, stdin: null }
}

function invocationOf(spec: SessionSpec): Invocation | Refusal {
  if (spec.role !== 'review')
    return { kind: 'refused', reason: `${ONLY_READ_ONLY_REVIEW}: the role ${spec.role} is not one` }
  return spec.kind === 'start' ? reviewInvocation(spec) : { kind: 'refused', reason: NO_RESUME_OF_REVIEW }
}

function isObject(value: unknown): value is RawEntry {
  return value !== null && typeof value === 'object'
}

function entriesOf(text: string): RawEntry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown
      return isObject(entry) ? [entry] : []
    }
    catch {
      return []
    }
  })
}

function streamOf(stdoutPath: string | null): RawEntry[] {
  return stdoutPath !== null && existsSync(stdoutPath) ? entriesOf(readFileSync(stdoutPath, 'utf8')) : []
}

function usageOf(raw: unknown): Usage | null {
  if (!isObject(raw))
    return null
  const { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning } = raw
  if (typeof input !== 'number' || typeof cached !== 'number' || typeof cacheWrite !== 'number' || typeof output !== 'number' || typeof reasoning !== 'number')
    return null
  return { input: input - cached, cached, cacheWrite, output, reasoning }
}

function failureOf(failed: RawEntry): string {
  const message = isObject(failed.error) ? failed.error.message : undefined
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : FAILED_WITH_NO_TEXT
}

function endOf(entries: RawEntry[]): Pick<SessionReading, 'end' | 'failure'> {
  const last = entries.filter(entry => entry.type === 'turn.completed' || entry.type === 'turn.failed').at(-1)
  if (last === undefined)
    return { end: 'missing', failure: null }
  return last.type === 'turn.failed' ? { end: 'failed', failure: failureOf(last) } : { end: 'completed', failure: null }
}

function toolUsesOf(entries: RawEntry[]): ToolUse[] {
  return entries.flatMap((entry) => {
    const item = entry.type === 'item.completed' ? entry.item : null
    if (!isObject(item) || item.type !== 'command_execution')
      return []
    return [{ kind: 'exec', command: typeof item.command === 'string' ? item.command : null, path: null }]
  })
}

function readingOf(place: SessionPlace): SessionReading {
  const entries = streamOf(place.stdoutPath)
  return {
    ...endOf(entries),
    usage: usageOf(entries.filter(entry => entry.type === 'turn.completed').at(-1)?.usage),
    costUsd: null,
    turns: null,
    durationMs: null,
    model: null,
    denials: [],
    toolUses: toolUsesOf(entries),
    journal: 'unreadable',
    lastSteps: null,
    contextTokens: null,
  }
}

function isCodexArgv(argv: string): boolean {
  return argv.split(/\s+/).slice(0, ARGV_HEAD_NAMING_THE_PROGRAM).some(word => path.basename(word) === CODEX_COMMAND)
}

function modelOf(wanted: string): ModelPick {
  return { model: wanted === 'auto' ? null : wanted }
}

export const codexAdapter: ClientAdapter = {
  id: CODEX_COMMAND,
  capabilities: {
    identity: 'reported',
    ladder: false,
    reports: { cost: false, turns: false, model: false, denials: false, journal: false },
  },
  invocation: invocationOf,
  reading: readingOf,
  readBudget: () => ({ ...NO_BUDGET_READING }),
  models: () => [],
  modelFor: (_role, _effort, wanted) => modelOf(wanted),
  processes: {
    isClient: isCodexArgv,
    sessionMarker: () => null,
    liveCwds: () => ({ kind: 'unreadable', why: NO_PROCESS_READING }),
    isolationCommand: () => [CODEX_COMMAND, ...READ_ONLY_HEADLESS, TREE_FLAG],
  },
  ownSession: () => null,
}
