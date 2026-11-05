import type { ClientAdapter, Invocation, Refusal, Role, SessionPolicy, SessionSpec } from '../contract.js'
import { settingsFlag, shiftSettings } from '../../shift-settings.js'

const CLAUDE_COMMAND = 'claude'
const MCP_OFF_FLAG = '--strict-mcp-config'
const CARD_PERMISSION = ['--permission-mode', 'dontAsk'] as const
const HEADLESS_OUTPUT = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none'] as const
export const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
export const USER_SETTINGS = '~/.claude/settings.json'
const SESSION_ENV: NodeJS.ProcessEnv = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
const WINDOW_ENV: NodeJS.ProcessEnv = {}

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
  return [spec.kind === 'start' ? '--session-id' : '--resume', spec.session]
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
    isClient: pending('processes.isClient', 'clientprocess'),
    sessionMarker: pending('processes.sessionMarker', 'clientprocess'),
    liveCwds: pending('processes.liveCwds', 'clientprocess'),
    isolationCommand: pending('processes.isolationCommand', 'clientprocess'),
  },
  ownSession: env => env[SESSION_VARIABLE] || null,
}
