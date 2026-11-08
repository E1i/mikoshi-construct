import type { ClientAdapter, Denial, Effort, Invocation, JournalChange, ModelChoice, ModelOffer, ModelPick, ReadBudget, Refusal, Role, SessionJournal, SessionPlace, SessionPolicy, SessionReading, SessionSpec, SessionTool, ToolUse, Usage } from '../contract.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { FACTORY_RUNTIME } from '../../../core/factory-paths.js'
import { commandWords } from '../../isolation.js'
import { reviewModelOf } from '../../session.js'
import { settingsFlag, shiftSettings } from '../../shift-settings.js'

const CLAUDE_COMMAND = 'claude'
const CLAUDE_PROCESS_NAMES = [CLAUDE_COMMAND, '/^[0-9]+[.][0-9]+[.][0-9]+$/']
const MCP_OFF_FLAG = '--strict-mcp-config'
const CARD_PERMISSION = ['--permission-mode', 'dontAsk'] as const
const SESSION_ID_FLAG = '--session-id'
const ARGV_HEAD_NAMING_THE_PROGRAM = 2
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
const CONFIG_DIR_VARIABLE = 'CLAUDE_CONFIG_DIR'
export const CLIENT_ENV_PREFIXES = ['CLAUDE_', 'ANTHROPIC_']

const WRITE_TOOL = 'Write'
const EXEC_TOOL = 'Bash'
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', WRITE_TOOL, 'NotebookEdit'])
const JOURNALED_TOOLS: ReadonlySet<string> = new Set([WRITE_TOOL, 'Edit', EXEC_TOOL])
const PLAIN_SESSION = /^[\w-]+$/
const LAST_STEP_COUNT = 12
const STEP_TEXT_CHARS = 120
const STEP_INPUT_KEYS = ['file_path', 'description', 'command', 'pattern', 'prompt'] as const
const ANY_LINE_BREAK = /\r\n?|[\n\p{Zl}\p{Zp}]/u

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')
const HOOK_MEASURE_MODULE = path.join(REPO_ROOT, '.claude', 'hooks', 'eddies-measure.mjs')
const TASK_STOP = 'TaskStop'
export const WINDOW_MCP_CONFIG = path.join(REPO_ROOT, path.dirname(FACTORY_RUNTIME.mikoLoopEntry), 'window-mcp.json')
export const WINDOW_UNUSED_TOOLS = ['Artifact', 'Workflow', 'AskUserQuestion', 'ScheduleWakeup', 'ReportFindings'] as const
export const WINDOW_KEPT_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'CronCreate', 'CronDelete', 'CronList', 'Monitor', 'Agent', 'ListAgents', 'Skill', 'ToolSearch', 'SendMessage', TASK_STOP] as const
const WINDOW_DIET = ['--setting-sources', 'project,local', MCP_OFF_FLAG, '--mcp-config', WINDOW_MCP_CONFIG, '--disallowedTools', WINDOW_UNUSED_TOOLS.join(',')] as const
const WINDOW_FLAGS = [...WINDOW_DIET, ...CARD_PERMISSION] as const

export const WINDOW_COMMAND_VARIABLE = 'MIKO_CLAUDE'
export const CLIENT_SANDBOX_DIRECTORY = path.join('/tmp', `claude-${os.userInfo().uid}`)
export const WINDOW_RESUME_REFUSAL = 'a window session is never resumed: the miko loop starts a fresh session from the handoff'

const OFFERED_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5'] as const
const OFFERED_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const AUTO_MODEL: ModelChoice = 'auto'

function models(): ModelOffer[] {
  return OFFERED_MODELS.map(id => ({ id, efforts: [...OFFERED_EFFORTS], contextWindow: null, recommendedFor: [] }))
}

function autoPick(role: Role): ModelPick {
  return { model: role === 'review' ? reviewModelOf() ?? null : null, effort: null }
}

function modelFor(role: Role, _effort: Effort | null, wanted: ModelChoice): ModelPick | Refusal {
  if (wanted === AUTO_MODEL)
    return autoPick(role)
  const offers = models().map(offer => offer.id)
  return offers.includes(wanted) ? { model: wanted, effort: null } : { kind: 'refused', reason: `the model ${wanted} is not offered: the offers are ${offers.join(', ')}` }
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
  return [spec.kind === 'start' ? SESSION_ID_FLAG : '--resume', spec.session]
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
  return invocationOf([...WINDOW_FLAGS, ...selectionOf(spec), ...(spec.prompt === '' ? [] : [spec.prompt])], null, WINDOW_ENV)
}

const SESSION_OF_ROLE: Record<Role, (spec: SessionSpec) => Invocation | Refusal> = {
  review: headlessSession,
  answer: headlessSession,
  ghost: headlessSession,
  launch: cardSession,
  ladder: cardSession,
  window: windowSession,
}

function reportedContextOf(usage: Record<string, unknown>): number | null {
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
  return parts.every(part => typeof part === 'number') ? (parts as number[]).reduce((sum, part) => sum + part, 0) : null
}

function editsAFile(content: unknown): boolean {
  return Array.isArray(content) && (content as { type?: unknown, name?: unknown }[]).some(block => block?.type === 'tool_use' && EDITING_TOOLS.has(block.name))
}

function budgetOf(transcript: string): ReadBudget {
  const reported = entriesOf(transcript).filter(entry => entry.message?.usage != null)
  const contextAt = (entry: TranscriptEntry | undefined): number | null => entry === undefined ? null : reportedContextOf(entry.message!.usage!)
  const startContext = contextAt(reported.at(0))
  const editContext = contextAt(reported.find(entry => editsAFile(entry.message!.content)))
  return { startContext, readBeforeEdit: startContext === null || editContext === null ? null : editContext - startContext }
}

function readBudget(place: SessionPlace): ReadBudget {
  const home = os.homedir()
  const projects = path.join(home, '.claude', 'projects')
  const transcript = existsSync(projects) ? findTranscript(home, place.session) : null
  return budgetOf(textOf(transcript) ?? '')
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
    guarantees: { allowlist: true, writeConfinement: true, mcpOff: true, toolNarrowing: true, guardFailsClosed: true },
  },
  invocation: spec => SESSION_OF_ROLE[spec.role](spec),
  reading: place => readingOf(place),
  readBudget,
  models,
  modelFor,
  processes: {
    isClient: isClaudeArgv,
    sessionMarker: session => `${SESSION_ID_FLAG} ${session}`,
    processNames: CLAUDE_PROCESS_NAMES,
    isolationCommand: () => [CLAUDE_COMMAND, ...HEADLESS_OUTPUT, MCP_OFF_FLAG, SESSION_ID_FLAG],
  },
  ownSession: env => env[SESSION_VARIABLE] || null,
}

export function windowCommand(env: NodeJS.ProcessEnv): string {
  return env[WINDOW_COMMAND_VARIABLE] ?? [CLAUDE_COMMAND, ...WINDOW_FLAGS].join(' ')
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

function subagentsDirOf(transcript: string): string {
  return path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
}

function subagentNameOf(file: string): string {
  const id = path.basename(file, '.jsonl')
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { agentType?: unknown } | null
    return typeof meta?.agentType === 'string' && meta.agentType !== '' ? meta.agentType : id
  }
  catch {
    return id
  }
}

export interface MeasuredSubagent {
  name: string
  context: number
  spent: number
  at: string
}

export function measuredSubagents(root: string, transcript: string): MeasuredSubagent[] {
  const measure = hookMeasure()
  return measure.agentTranscriptsUnder(subagentsDirOf(transcript)).map((file) => {
    const { tokens, last } = measure.readTranscript(root, file)
    return { name: subagentNameOf(file), context: measure.contextOf(last), spent: measure.spentOf(tokens), at: statSync(file).mtime.toISOString() }
  })
}

function spentWithAgents(root: string, transcript: string, parent: HookTokens): number {
  const measure = hookMeasure()
  const agents = measure.sumTranscripts(root, measure.agentTranscriptsUnder(subagentsDirOf(transcript)))
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

export function clientHome(env: NodeJS.ProcessEnv): string {
  return env[CONFIG_DIR_VARIABLE] || path.join(os.homedir(), '.claude')
}

function projectDirOf(claudeHome: string, worktree: string): string {
  return path.join(claudeHome, 'projects', worktree.replace(/[^a-z0-9]/gi, '-'))
}

export function transcriptFile(claudeHome: string, worktree: string, session: string): string | null {
  return PLAIN_SESSION.test(session) ? path.join(projectDirOf(claudeHome, worktree), `${session}.jsonl`) : null
}

export interface StartContext {
  firstTurn: number | null
  atMarker: number | null
}

function runsCommandWith(content: unknown, marker: string): boolean {
  const blocks = (Array.isArray(content) ? content : []) as { type?: unknown, name?: unknown, input?: { command?: unknown } }[]
  return blocks.some(block => block?.type === 'tool_use' && block.name === EXEC_TOOL && typeof block.input?.command === 'string' && block.input.command.includes(marker))
}

export function startContextOf(transcript: string, marker: string): StartContext {
  const reported = entriesOf(transcript).filter(entry => entry.message?.role === 'assistant' && entry.message.usage != null)
  const contextAt = (entry: TranscriptEntry | undefined): number | null => entry === undefined ? null : reportedContextOf(entry.message!.usage!)
  return { firstTurn: contextAt(reported.at(0)), atMarker: contextAt(reported.find(entry => runsCommandWith(entry.message!.content, marker))) }
}

function promptText(content: unknown): string {
  if (typeof content === 'string')
    return content
  return ((Array.isArray(content) ? content : []) as { type?: unknown, text?: unknown }[]).map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('')
}

function firstPromptOf(transcript: string): string {
  const prompt = entriesOf(transcript).find(entry => entry.type === 'user' && entry.isMeta !== true && entry.isSidechain !== true)
  return promptText(prompt?.message?.content)
}

export function lastSessionPrompted(env: NodeJS.ProcessEnv, worktree: string, promptStart: string): string | null {
  const dir = projectDirOf(clientHome(env), worktree)
  if (!existsSync(dir))
    return null
  const newestFirst = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => path.join(dir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return newestFirst.find(file => firstPromptOf(readFileSync(file, 'utf8')).startsWith(promptStart)) ?? null
}

function textOf(file: string | null): string | null {
  return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function clientTranscript(env: NodeJS.ProcessEnv, worktree: string, session: string): string | null {
  return textOf(transcriptFile(clientHome(env), worktree, session))
}

export function hasClientTranscript(env: NodeJS.ProcessEnv, worktree: string, session: string): boolean {
  const file = transcriptFile(clientHome(env), worktree, session)
  return file !== null && existsSync(file)
}

export function clientLastSteps(env: NodeJS.ProcessEnv, worktree: string, session: string): string[] | null {
  const transcript = clientTranscript(env, worktree, session)
  return transcript === null ? null : lastSteps(transcript)
}

interface CommandRun {
  startedAt: number
  endedAt: number
}

export interface CommandJournal extends SessionJournal {
  commandRuns: readonly CommandRun[]
}

interface JournaledUse {
  id: string
  name: string
  input: Record<string, unknown>
  at: number
}

interface JournaledResult {
  failed: boolean
  at: number
}

function blocksOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = entry.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? message.content.filter(block => block !== null && typeof block === 'object') : []
}

function changeOf(use: JournaledUse, at: number): JournalChange | null {
  const { input } = use
  if (use.name === WRITE_TOOL)
    return typeof input.content === 'string' ? { kind: 'write', content: input.content, at } : null
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string')
    return null
  return { kind: 'edit', oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all === true, at }
}

export function parseSessionJournal(text: string, worktree: string): CommandJournal {
  const uses: JournaledUse[] = []
  const results = new Map<string, JournaledResult>()
  let end = Number.NEGATIVE_INFINITY
  for (const line of text.split('\n')) {
    if (line.trim() === '')
      continue
    const entry = JSON.parse(line) as Record<string, unknown>
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (!Number.isNaN(at))
      end = Math.max(end, at)
    for (const block of blocksOf(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && JOURNALED_TOOLS.has(block.name))
        uses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown>, at })
      if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !Number.isNaN(at))
        results.set(block.tool_use_id, { failed: block.is_error === true, at })
    }
  }
  if (end === Number.NEGATIVE_INFINITY)
    throw new Error('the session journal holds no timestamped entry')
  const changes = new Map<string, JournalChange[]>()
  const commandRuns: CommandRun[] = []
  for (const use of uses) {
    const result = results.get(use.id)
    if (result === undefined)
      continue
    if (use.name === EXEC_TOOL) {
      if (use.input.run_in_background !== true)
        commandRuns.push({ startedAt: use.at, endedAt: result.at })
      continue
    }
    if (result.failed)
      continue
    const file = use.input.file_path
    if (typeof file !== 'string')
      continue
    const change = changeOf(use, result.at)
    if (change === null)
      continue
    const relative = path.relative(worktree, path.resolve(worktree, file))
    changes.set(relative, [...(changes.get(relative) ?? []), change])
  }
  return { end, changes, commandRuns }
}

function journalOf(transcript: string | null, cwd: string): CommandJournal | 'unreadable' {
  if (transcript === null)
    return 'unreadable'
  try {
    return parseSessionJournal(transcript, cwd)
  }
  catch {
    return 'unreadable'
  }
}

function oneLine(text: string): string {
  return text.split(ANY_LINE_BREAK).join(' ').trim().slice(0, STEP_TEXT_CHARS)
}

function stepOf(block: Record<string, unknown>): string[] {
  if (block.type === 'text' && typeof block.text === 'string')
    return [oneLine(block.text)]
  if (block.type !== 'tool_use' || typeof block.name !== 'string')
    return []
  const input = (block.input ?? {}) as Record<string, unknown>
  const detail = STEP_INPUT_KEYS.map(key => input[key]).find(value => typeof value === 'string') as string | undefined
  return [detail === undefined ? block.name : `${block.name} ${oneLine(detail)}`]
}

function lastSteps(transcript: string): string[] {
  return entriesOf(transcript).flatMap((entry) => {
    const content = entry.type === 'assistant' ? entry.message?.content : undefined
    return Array.isArray(content) ? (content as (Record<string, unknown> | null)[]).flatMap(block => block === null ? [] : stepOf(block)) : []
  }).filter(step => step !== '').slice(-LAST_STEP_COUNT)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmpty(text: unknown): string | null {
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
}

type RawEntry = Record<string, unknown>

function rawEntriesOf(text: string): RawEntry[] {
  return entriesOf(text) as RawEntry[]
}

function resultLineOf(entries: RawEntry[]): RawEntry | null {
  return entries.filter(entry => entry.type === 'result').at(-1) ?? null
}

function initModelOf(entries: RawEntry[]): string | null {
  const init = entries.find(entry => entry.type === 'system' && entry.subtype === 'init' && typeof entry.model === 'string')
  return init === undefined ? null : init.model as string
}

function usageOf(raw: unknown): Usage | null {
  if (raw === null || typeof raw !== 'object')
    return null
  const fields = raw as RawEntry
  const details = fields.output_tokens_details as RawEntry | null | undefined
  const reported = {
    input: numberOrNull(fields.input_tokens),
    cached: numberOrNull(fields.cache_read_input_tokens),
    cacheWrite: numberOrNull(fields.cache_creation_input_tokens),
    output: numberOrNull(fields.output_tokens),
    reasoning: numberOrNull(details?.thinking_tokens),
  }
  return reported as Usage
}

function denialsOf(result: RawEntry | null): Denial[] {
  const denials = Array.isArray(result?.permission_denials) ? result.permission_denials as unknown[] : []
  return denials.flatMap((denial) => {
    const fields = denial !== null && typeof denial === 'object' ? denial as RawEntry : null
    const input = fields?.tool_input
    if (input === null || typeof input !== 'object')
      return []
    const aimed = input as RawEntry
    return [{ tool: String(fields?.tool_name ?? ''), path: stringOrNull(aimed.file_path), command: stringOrNull(aimed.command), text: nonEmpty(aimed.content) ?? nonEmpty(result?.result) ?? '' }]
  })
}

function toolUseOf(block: { name?: unknown, input?: unknown }): ToolUse {
  const input = (block.input ?? {}) as RawEntry
  const name = String(block.name)
  return { kind: WRITING_TOOLS.has(name) ? 'write' : name === EXEC_TOOL ? 'exec' : 'other', command: stringOrNull(input.command), path: stringOrNull(input.file_path) }
}

function toolUsesOf(entries: RawEntry[]): ToolUse[] {
  return entries.flatMap((entry) => {
    const content = (entry.message as { content?: unknown } | null | undefined)?.content
    return Array.isArray(content) ? content.filter(item => item?.type === 'tool_use').map(toolUseOf) : []
  })
}

function timestampSpan(entries: RawEntry[]): number | null {
  const marks = entries.map(entry => typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN).filter(mark => !Number.isNaN(mark))
  return marks.length < 2 ? null : Math.max(...marks) - Math.min(...marks)
}

function endOf(result: RawEntry | null): Pick<SessionReading, 'end' | 'failure'> {
  if (result === null)
    return { end: 'missing', failure: null }
  if (result.is_error !== true)
    return { end: 'completed', failure: null }
  return { end: 'failed', failure: nonEmpty(result.result) ?? nonEmpty(result.subtype) ?? 'the client reported an error and no text' }
}

function runEndOf(entries: RawEntry[], place: SessionPlace): Pick<SessionReading, 'end' | 'failure'> {
  const exitCode = place.exitCode ?? null
  if (entries.length > 0 || exitCode === null || exitCode === 0)
    return endOf(resultLineOf(entries))
  return { end: 'failed', failure: nonEmpty(textOf(place.stderrPath ?? null)) ?? `the client exited ${exitCode} with no stream and no error text` }
}

function clientSessionOf(entries: RawEntry[], place: SessionPlace): string | null {
  return nonEmpty(place.session) ?? nonEmpty(entries.find(entry => typeof entry.session_id === 'string')?.session_id)
}

function reportedContext(transcript: string): number | null {
  const usages = entriesOf(transcript).map(entry => entry.message?.role === 'assistant' ? entry.message.usage : null).filter(usage => usage != null && typeof usage === 'object')
  const last = usages.at(-1)
  const reports = [last?.input_tokens, last?.cache_creation_input_tokens, last?.cache_read_input_tokens].some(count => typeof count === 'number')
  return reports ? transcriptContext(transcript) : null
}

function readingOf(place: SessionPlace): SessionReading {
  const transcript = clientTranscript(process.env, place.cwd, place.session)
  const source = place.stdoutPath === null ? transcript : textOf(place.stdoutPath)
  const entries = rawEntriesOf(source ?? '')
  const result = resultLineOf(entries)
  return {
    ...runEndOf(entries, place),
    usage: usageOf(result?.usage),
    costUsd: numberOrNull(result?.total_cost_usd),
    turns: numberOrNull(result?.num_turns),
    durationMs: timestampSpan(entries),
    model: place.stdoutPath === null ? (transcript === null ? null : transcriptModel(transcript)) : initModelOf(entries),
    denials: denialsOf(result),
    toolUses: toolUsesOf(entries),
    journal: journalOf(transcript, place.cwd),
    lastSteps: transcript === null ? null : lastSteps(transcript),
    contextTokens: transcript === null ? null : reportedContext(transcript),
    clientSession: clientSessionOf(entries, place),
  }
}

export function rawUsageIn(stdoutPath: string): unknown | null {
  return resultLineOf(rawEntriesOf(textOf(stdoutPath) ?? ''))?.usage ?? null
}
