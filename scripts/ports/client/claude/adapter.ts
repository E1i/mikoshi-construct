import type { ClientAdapter, Invocation, ReadBudget, Refusal, Role, SessionPolicy, SessionSpec, SessionTool } from '../contract.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { settingsFlag, shiftSettings } from '../../shift-settings.js'

const CLAUDE_COMMAND = 'claude'
const MCP_OFF_FLAG = '--strict-mcp-config'
const CARD_PERMISSION = ['--permission-mode', 'dontAsk'] as const
const HEADLESS_OUTPUT = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none'] as const
export const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
export const USER_SETTINGS = '~/.claude/settings.json'
const SESSION_ENV: NodeJS.ProcessEnv = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
const WINDOW_ENV: NodeJS.ProcessEnv = {}
const CARD_SESSION_ROLES: ReadonlySet<Role> = new Set(['launch', 'answer', 'review'])
const CARD_SESSION_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
const TOOLS_OF_WORD: Record<SessionTool, string[]> = { web: ['WebFetch', 'WebSearch'], skills: ['Skill'], agents: ['Agent'] }
const SLASH_COMMANDS_OFF_FLAG = '--disable-slash-commands'
const EDITING_TOOLS: ReadonlySet<unknown> = new Set(['Edit', 'Write'])

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

function userInstructionsOff(): { autoMemoryEnabled: false, claudeMdExcludes: string[] } {
  return { autoMemoryEnabled: false, claudeMdExcludes: [path.join(os.homedir(), '.claude', 'CLAUDE.md')] }
}

function settingsOf({ role, cwd, policy }: SessionSpec): string[] {
  const narrowed = CARD_SESSION_ROLES.has(role)
  if (policy.profile !== 'sandboxed')
    return narrowed ? ['--settings', JSON.stringify(userInstructionsOff())] : []
  const settings = shiftSettings(cwd, { prepush: policy.gateCommands, handoffWrite: null, codeMatrix: null }, policy.writePaths)
  return settingsFlag(narrowed ? { ...settings, ...userInstructionsOff() } : settings)
}

function toolsOf({ role, policy }: SessionSpec): string[] {
  if (!CARD_SESSION_ROLES.has(role))
    return []
  const words = policy.tools ?? []
  const names = [...CARD_SESSION_TOOLS, ...words.flatMap(word => TOOLS_OF_WORD[word])]
  return ['--tools', names.join(','), ...(words.includes('skills') ? [] : [SLASH_COMMANDS_OFF_FLAG])]
}

function selectionOf(spec: SessionSpec): string[] {
  return [...spec.addDirs.flatMap(dir => ['--add-dir', dir]), ...(spec.pick.model === null ? [] : ['--model', spec.pick.model])]
}

function mcpOf(policy: SessionPolicy): string[] {
  return policy.mcpOff ? [MCP_OFF_FLAG] : []
}

function identityOf(spec: SessionSpec): string[] {
  return [spec.kind === 'start' ? '--session-id' : '--resume', spec.session]
}

function invocationOf(args: string[], stdin: string | null = null, env: NodeJS.ProcessEnv = SESSION_ENV): Invocation {
  return { command: CLAUDE_COMMAND, args, env: { ...env }, stdin }
}

function headlessSession(spec: SessionSpec): Invocation {
  return invocationOf([...settingsOf(spec), ...selectionOf(spec), ...toolsOf(spec), ...HEADLESS_OUTPUT, ...mcpOf(spec.policy), ...identityOf(spec), spec.prompt])
}

function cardSession(spec: SessionSpec): Invocation {
  const flags = [...CARD_PERMISSION, ...settingsOf(spec), ...selectionOf(spec), ...toolsOf(spec), ...mcpOf(spec.policy), '-p', ...identityOf(spec)]
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
  ghost: headlessSession,
  launch: cardSession,
  ladder: cardSession,
  window: windowSession,
}

interface TranscriptMessage {
  usage: Record<string, unknown>
  content?: unknown
}

function reportedMessageOf(line: string): TranscriptMessage[] {
  try {
    const message = (JSON.parse(line) as { message?: Partial<TranscriptMessage> }).message
    return message?.usage === undefined ? [] : [message as TranscriptMessage]
  }
  catch {
    return []
  }
}

function contextOf(usage: Record<string, unknown>): number | null {
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
  return parts.every(part => typeof part === 'number') ? (parts as number[]).reduce((sum, part) => sum + part, 0) : null
}

function editsAFile(content: unknown): boolean {
  return Array.isArray(content) && (content as { type?: unknown, name?: unknown }[]).some(block => block?.type === 'tool_use' && EDITING_TOOLS.has(block.name))
}

function budgetOf(transcript: string): ReadBudget {
  const reported = transcript.split('\n').flatMap(reportedMessageOf)
  const first = reported.at(0)
  const edit = reported.find(message => editsAFile(message.content))
  const startContext = first === undefined ? null : contextOf(first.usage)
  const editContext = edit === undefined ? null : contextOf(edit.usage)
  return { startContext, readBeforeEdit: startContext === null || editContext === null ? null : editContext - startContext }
}

function readBudget(home: string, session: string): ReadBudget {
  const projects = path.join(home, '.claude', 'projects')
  const transcript = existsSync(projects) ? readdirSync(projects).map(project => path.join(projects, project, `${session}.jsonl`)).find(existsSync) : undefined
  return budgetOf(transcript === undefined ? '' : readFileSync(transcript, 'utf8'))
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
  readBudget,
  models: pending('models', 'clientmodels'),
  modelFor: pending('modelFor', 'clientmodels'),
  processes: {
    isClient: pending('processes.isClient', 'clientprocess'),
    sessionMarker: pending('processes.sessionMarker', 'clientprocess'),
    liveCwds: pending('processes.liveCwds', 'clientprocess'),
    isolationCommand: () => [CLAUDE_COMMAND, ...HEADLESS_OUTPUT, MCP_OFF_FLAG],
  },
  ownSession: env => env[SESSION_VARIABLE] || null,
}
