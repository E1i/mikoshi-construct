import type { ClientAdapter, ClientGuarantees, Invocation, ModelPick, ReadBudget, Refusal, SessionPlace, SessionPolicy, SessionReading, SessionSpec, ToolUse, Usage } from '../contract.js'
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
const NO_BUDGET_READING: ReadBudget = { startContext: null, readBeforeEdit: null }
const NO_WRITE_PATHS = 'a read-only review writes nowhere, and the policy names paths to write'
const NO_ADD_DIRS = 'a read-only review reads only its tree: a further directory under it was never witnessed, so addDirs is refused and not dropped'

const GUARANTEES: ClientGuarantees = { allowlist: false, writeConfinement: true, mcpOff: false, toolNarrowing: false, guardFailsClosed: false }

const WHAT_A_POLICY_ASKS: readonly { guarantee: keyof ClientGuarantees, asks: (policy: SessionPolicy) => boolean }[] = [
  { guarantee: 'allowlist', asks: policy => policy.gateCommands.length > 0 },
  { guarantee: 'writeConfinement', asks: policy => policy.profile === 'sandboxed' },
  { guarantee: 'mcpOff', asks: policy => policy.mcpOff },
  { guarantee: 'toolNarrowing', asks: policy => (policy.tools ?? []).length > 0 },
]

type RawEntry = Record<string, unknown>

function refused(reason: string): Refusal {
  return { kind: 'refused', reason }
}

function missingGuarantees(policy: SessionPolicy): string[] {
  return WHAT_A_POLICY_ASKS.filter(({ guarantee, asks }) => asks(policy) && !GUARANTEES[guarantee]).map(({ guarantee }) => guarantee)
}

function reviewInvocation(spec: SessionSpec): Invocation | Refusal {
  const missing = missingGuarantees(spec.policy)
  if (missing.length > 0)
    return refused(`the policy asks for what this client does not guarantee: ${missing.join(', ')}`)
  if (spec.policy.writePaths.length > 0)
    return refused(NO_WRITE_PATHS)
  if (spec.addDirs.length > 0)
    return refused(NO_ADD_DIRS)
  const model = spec.pick.model === null ? [] : [MODEL_FLAG, spec.pick.model]
  return { command: CODEX_COMMAND, args: [...READ_ONLY_HEADLESS, TREE_FLAG, spec.cwd, ...model, spec.prompt], env: {}, stdin: null }
}

function invocationOf(spec: SessionSpec): Invocation | Refusal {
  if (spec.role !== 'review')
    return refused(`${ONLY_READ_ONLY_REVIEW}: the role ${spec.role} is not one`)
  return spec.kind === 'start' ? reviewInvocation(spec) : refused(NO_RESUME_OF_REVIEW)
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

function textOf(file: string | null): string | null {
  return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : null
}

function streamOf(stdoutPath: string | null): RawEntry[] {
  return entriesOf(textOf(stdoutPath) ?? '')
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

function failedStart(place: SessionPlace, exitCode: number): string {
  const text = textOf(place.stderrPath ?? null)?.trim()
  return text === undefined || text === '' ? `the client exited ${exitCode} with no stream and no error text` : text
}

function endOf(entries: RawEntry[], place: SessionPlace): Pick<SessionReading, 'end' | 'failure'> {
  const exitCode = place.exitCode ?? null
  if (entries.length === 0 && exitCode !== null && exitCode !== 0)
    return { end: 'failed', failure: failedStart(place, exitCode) }
  const last = entries.filter(entry => entry.type === 'turn.completed' || entry.type === 'turn.failed').at(-1)
  if (last === undefined)
    return { end: 'missing', failure: null }
  return last.type === 'turn.failed' ? { end: 'failed', failure: failureOf(last) } : { end: 'completed', failure: null }
}

function threadOf(entries: RawEntry[]): string | null {
  const thread = entries.find(entry => entry.type === 'thread.started')?.thread_id
  return typeof thread === 'string' ? thread : null
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
    ...endOf(entries, place),
    usage: usageOf(entries.filter(entry => entry.type === 'turn.completed').at(-1)?.usage),
    costUsd: null,
    turns: null,
    durationMs: null,
    model: null,
    denials: null,
    toolUses: toolUsesOf(entries),
    journal: 'unreadable',
    lastSteps: null,
    contextTokens: null,
    clientSession: threadOf(entries),
  }
}

function isCodexArgv(argv: string): boolean {
  return argv.split(/\s+/).slice(0, ARGV_HEAD_NAMING_THE_PROGRAM).some(word => path.basename(word) === CODEX_COMMAND)
}

function modelOf(wanted: string): ModelPick {
  return { model: wanted === 'auto' ? null : wanted, effort: null }
}

export const codexAdapter: ClientAdapter = {
  id: CODEX_COMMAND,
  capabilities: {
    identity: 'reported',
    ladder: false,
    reports: { cost: false, turns: false, model: false, denials: false, journal: false },
    guarantees: { ...GUARANTEES },
  },
  invocation: invocationOf,
  reading: readingOf,
  readBudget: () => ({ ...NO_BUDGET_READING }),
  models: () => null,
  modelFor: (_role, _effort, wanted) => modelOf(wanted),
  processes: {
    isClient: isCodexArgv,
    sessionMarker: () => null,
    processNames: [CODEX_COMMAND],
    isolationCommand: () => [CODEX_COMMAND, ...READ_ONLY_HEADLESS, TREE_FLAG],
  },
  ownSession: () => null,
}
