import type { ClientAdapter, Invocation, Refusal, Role, SessionPolicy, SessionSpec } from '../contract.js'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { commandWords } from '../../isolation.js'
import { settingsFlag, shiftSettings } from '../../shift-settings.js'
import { claudeProcessCwds } from '../../worktree.js'

const CLAUDE_COMMAND = 'claude'
const MCP_OFF_FLAG = '--strict-mcp-config'
const CARD_PERMISSION = ['--permission-mode', 'dontAsk'] as const
const SESSION_ID_FLAG = '--session-id'
const ARGV_HEAD_NAMING_THE_PROGRAM = 2
const HEADLESS_OUTPUT = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none'] as const
export const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
export const USER_SETTINGS = '~/.claude/settings.json'
const SESSION_ENV: NodeJS.ProcessEnv = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
const WINDOW_ENV: NodeJS.ProcessEnv = {}

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')
const HOOK_MEASURE_MODULE = path.join(REPO_ROOT, '.claude', 'hooks', 'eddies-measure.mjs')
const TASK_STOP = 'TaskStop'

export const WINDOW_COMMAND_VARIABLE = 'MIKO_CLAUDE'
export const CLIENT_SANDBOX_DIRECTORY = path.join('/tmp', `claude-${os.userInfo().uid}`)
export const WINDOW_RESUME_REFUSAL = 'a window session is never resumed: the miko loop starts a fresh session from the handoff'

export class ClientOperationPending extends Error {
  constructor(readonly operation: string, readonly card: string) {
    super(`the client operation ${operation} is filled by the card ${card}`)
    this.name = 'ClientOperationPending'
  }
}

function pending(operation: string, card: string): () => never {
  return () => {
    throw new ClientOperationPending(operation, card)
  }
}

function settingsOf(cwd: string, policy: SessionPolicy): string[] {
  if (policy.profile !== 'sandboxed')
    return []
  return settingsFlag(shiftSettings(cwd, { prepush: policy.gateCommands, handoffWrite: null, codeMatrix: null }, policy.writePaths))
}

function selectionOf(spec: SessionSpec): string[] {
  return [...spec.addDirs.flatMap(dir => ['--add-dir', dir]), ...(spec.pick.model === null ? [] : ['--model', spec.pick.model])]
}

function mcpOf(policy: SessionPolicy): string[] {
  return policy.mcpOff ? [MCP_OFF_FLAG] : []
}

function identityOf(spec: SessionSpec): string[] {
  return [spec.kind === 'start' ? SESSION_ID_FLAG : '--resume', spec.session]
}

function invocationOf(args: string[], stdin: string | null = null, env: NodeJS.ProcessEnv = SESSION_ENV): Invocation {
  return { command: CLAUDE_COMMAND, args, env: { ...env }, stdin }
}

function headlessSession(spec: SessionSpec): Invocation {
  return invocationOf([...settingsOf(spec.cwd, spec.policy), ...selectionOf(spec), ...HEADLESS_OUTPUT, ...mcpOf(spec.policy), ...identityOf(spec), spec.prompt])
}

function cardSession(spec: SessionSpec): Invocation {
  const flags = [...CARD_PERMISSION, ...settingsOf(spec.cwd, spec.policy), ...selectionOf(spec), ...mcpOf(spec.policy), '-p', ...identityOf(spec)]
  return spec.kind === 'start' ? invocationOf(flags, spec.prompt) : invocationOf([...flags, spec.prompt])
}

function windowSession(spec: SessionSpec): Invocation | Refusal {
  if (spec.kind === 'resume')
    return { kind: 'refused', reason: WINDOW_RESUME_REFUSAL }
  return invocationOf([...CARD_PERMISSION, ...selectionOf(spec), ...(spec.prompt === '' ? [] : [spec.prompt])], null, WINDOW_ENV)
}

const SESSION_OF_ROLE: Record<Role, (spec: SessionSpec) => Invocation | Refusal> = {
  review: headlessSession,
  answer: headlessSession,
  launch: cardSession,
  ladder: cardSession,
  window: windowSession,
}

function isClaudeArgv(argv: string): boolean {
  return argv.split(/\s+/).slice(0, ARGV_HEAD_NAMING_THE_PROGRAM).some(word => path.basename(word) === CLAUDE_COMMAND)
}

export function cardIsolationCommand(client: string): string[] {
  return [...commandWords(client), ...CARD_PERMISSION]
}

export const claudeAdapter: ClientAdapter = {
  id: 'claude',
  capabilities: {
    identity: 'assigned',
    ladder: true,
    reports: { cost: true, turns: true, model: true, denials: true, journal: true },
  },
  invocation: spec => SESSION_OF_ROLE[spec.role](spec),
  reading: pending('reading', 'clientreading'),
  models: pending('models', 'clientmodels'),
  modelFor: pending('modelFor', 'clientmodels'),
  processes: {
    isClient: isClaudeArgv,
    sessionMarker: session => `${SESSION_ID_FLAG} ${session}`,
    liveCwds: () => claudeProcessCwds(),
    isolationCommand: () => [CLAUDE_COMMAND, ...HEADLESS_OUTPUT, MCP_OFF_FLAG, SESSION_ID_FLAG],
  },
  ownSession: env => env[SESSION_VARIABLE] || null,
}

export function windowCommand(env: NodeJS.ProcessEnv): string {
  return env[WINDOW_COMMAND_VARIABLE] ?? [CLAUDE_COMMAND, ...CARD_PERMISSION].join(' ')
}

interface HookTokens {
  input: number
  cacheWrite: number
  cacheRead: number
}

interface HookMeasure {
  SPEND_BASIS: string
  addTokens: (into: HookTokens, tokens: HookTokens) => HookTokens
  spentOf: (tokens: HookTokens) => number
  contextOf: (tokens: HookTokens) => number
  readTranscript: (root: string, transcript: string) => { tokens: HookTokens, last: HookTokens }
  sumTranscripts: (root: string, files: string[]) => HookTokens
  agentTranscriptsUnder: (dir: string) => string[]
}

function hookMeasure(): HookMeasure {
  return createRequire(import.meta.url)(HOOK_MEASURE_MODULE) as HookMeasure
}

export interface TranscriptCounters {
  input: number
  cache_write: number
  cache_read: number
}

interface TranscriptEntry {
  type?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  timestamp?: unknown
  message?: {
    role?: unknown
    model?: unknown
    content?: unknown
    usage?: { input_tokens?: unknown, cache_creation_input_tokens?: unknown, cache_read_input_tokens?: unknown } | null
  }
}

function entriesOf(text: string): TranscriptEntry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown
      return entry !== null && typeof entry === 'object' ? [entry as TranscriptEntry] : []
    }
    catch {
      return []
    }
  })
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function countersOf(entry: TranscriptEntry): TranscriptCounters | null {
  const usage = entry.message?.role === 'assistant' ? entry.message.usage : null
  if (usage == null || typeof usage !== 'object')
    return null
  return { input: tokenCount(usage.input_tokens), cache_write: tokenCount(usage.cache_creation_input_tokens), cache_read: tokenCount(usage.cache_read_input_tokens) }
}

export function findTranscript(home: string, session: string): string | null {
  const projects = path.join(home, '.claude', 'projects')
  return readdirSync(projects).map(project => path.join(projects, project, `${session}.jsonl`)).find(existsSync) ?? null
}

export function transcriptCounters(text: string): { start: TranscriptCounters | null, end: TranscriptCounters | null, startedAt: string | null } {
  const entries = entriesOf(text)
  const counters = entries.map(countersOf).filter(counter => counter !== null)
  const startedAt = entries.map(entry => entry.timestamp).find(stamp => typeof stamp === 'string') as string | undefined
  return { start: counters.at(0) ?? null, end: counters.at(-1) ?? null, startedAt: startedAt ?? null }
}

export function transcriptContext(text: string): number | null {
  const { end } = transcriptCounters(text)
  return end === null ? null : end.input + end.cache_write + end.cache_read
}

export function transcriptModel(text: string): string | null {
  const models = entriesOf(text).map(entry => entry.message?.role === 'assistant' ? entry.message.model : undefined)
  const model = models.filter(each => typeof each === 'string').at(-1)
  return typeof model === 'string' ? model : null
}

function isOwnerText(content: unknown): boolean {
  if (typeof content === 'string')
    return !content.startsWith('<')
  const parts = Array.isArray(content) ? content as { type?: unknown }[] : []
  return parts.some(part => part?.type === 'text') && !parts.some(part => part?.type === 'tool_result')
}

export function ownerMessagesOf(transcript: string): number {
  return entriesOf(transcript).filter(entry => entry.type === 'user' && entry.isMeta !== true && entry.isSidechain !== true && isOwnerText(entry.message?.content)).length
}

export function stoppedTasksOf(transcript: string): Set<string> {
  const stopped = new Set<string>()
  for (const entry of entriesOf(transcript)) {
    const content = entry.message?.content
    for (const use of (Array.isArray(content) ? content : []) as { type?: unknown, name?: unknown, input?: { task_id?: unknown } }[]) {
      if (use?.type === 'tool_use' && use.name === TASK_STOP && typeof use.input?.task_id === 'string')
        stopped.add(use.input.task_id)
    }
  }
  return stopped
}

export function spendBasis(): string {
  return hookMeasure().SPEND_BASIS
}

function spentWithAgents(root: string, transcript: string, parent: HookTokens): number {
  const measure = hookMeasure()
  const agents = measure.sumTranscripts(root, measure.agentTranscriptsUnder(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')))
  return measure.spentOf(measure.addTokens({ ...parent }, agents))
}

export function measuredSpent(root: string, transcript: string): number {
  return spentWithAgents(root, transcript, hookMeasure().readTranscript(root, transcript).tokens)
}

export function measuredSession(root: string, transcript: string): { context: number, spent: number } {
  const measure = hookMeasure()
  const parent = measure.readTranscript(root, transcript)
  return { context: measure.contextOf(parent.last), spent: spentWithAgents(root, transcript, parent.tokens) }
}
