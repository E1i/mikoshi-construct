import type { Invocation, SessionSpec } from '../../ports/client/contract.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { CLIENT_SANDBOX_DIRECTORY, findTranscript, measuredSession, measuredSpent, ownerMessagesOf, stoppedTasksOf, transcriptContext, transcriptCounters, transcriptModel, WINDOW_COMMAND_VARIABLE, WINDOW_KEPT_TOOLS, WINDOW_MCP_CONFIG, WINDOW_UNUSED_TOOLS, windowCommand } from '../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { TSX_PIPE_DIRECTORY } from '../../ports/shift-settings.js'
import { queueDir } from '../../quality/lock.js'
import { sessionGauges } from '../../window/eddies-measure.js'
import { ownerMessagesOf as exitOwnerMessagesOf } from '../../window/exit.js'
import { CLAUDE_VARIABLE, claudeArgv, claudeCommand, DEFAULT_CLAUDE } from '../../window/loop.js'
import { stoppedTasksOf as agentsStoppedTasksOf, sessionTranscriptOf } from '../../window/window-agents.js'

const PROMPT = 'continue from the handoff'
const SESSION = 'window-1577'
const MODEL = 'the-window-model'
const STARTED_AT = '2026-11-05T00:00:00.000Z'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'client-window-'))
  roots.push(root)
  return root
}

function windowSpec(prompt: string): SessionSpec {
  return { kind: 'start', role: 'window', session: SESSION, cwd: '/tree', prompt, addDirs: [], pick: { model: null }, policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false } }
}

function windowInvocation(prompt: string): Invocation {
  const result = clientAdapter().invocation(windowSpec(prompt))
  if ('kind' in result)
    throw new Error(result.reason)
  return result
}

function argvThroughTheLoop(command: string, prompt: string): string[] {
  const root = scratch()
  const argv = path.join(root, 'argv')
  const stub = path.join(root, 'claude')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argv}'\n`)
  chmodSync(stub, 0o755)
  const run = spawnSync('sh', claudeArgv(command.replace('$STUB', stub), prompt), { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } })
  expect(run.status, String(run.stderr)).toBe(0)
  return readFileSync(argv, 'utf8').split('\0').slice(0, -1)
}

function assistantLine(input: number, cacheWrite: number, cacheRead: number): string {
  return JSON.stringify({ timestamp: STARTED_AT, type: 'assistant', message: { role: 'assistant', model: MODEL, usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead } } })
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
}

function transcriptIn(home: string, session: string, lines: string[]): string {
  const project = path.join(home, '.claude', 'projects', 'a-project')
  mkdirSync(project, { recursive: true })
  const file = path.join(project, `${session}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

const WINDOW_DIET_COMMAND = `claude --setting-sources project,local --strict-mcp-config --mcp-config ${WINDOW_MCP_CONFIG} --disallowedTools Artifact,Workflow,AskUserQuestion,ScheduleWakeup,ReportFindings --permission-mode dontAsk`

const TOOLS_THE_WINDOW_KEEPS = ['Bash', 'Read', 'Edit', 'Write', 'CronCreate', 'CronDelete', 'Monitor', 'Agent', 'Skill', 'ToolSearch', 'SendMessage', 'TaskStop']

function disallowedOf(args: readonly string[]): string[] {
  const at = args.indexOf('--disallowedTools')
  return at === -1 ? [] : args[at + 1]!.split(',')
}

it('the window command carries --setting-sources project,local, --strict-mcp-config with the window MCP config and --disallowedTools for the unused schemas', () => {
  const { args } = windowInvocation(PROMPT)
  expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local')
  expect(args).toContain('--strict-mcp-config')
  expect(args[args.indexOf('--mcp-config') + 1]).toBe(WINDOW_MCP_CONFIG)
  expect(JSON.parse(readFileSync(WINDOW_MCP_CONFIG, 'utf8'))).toEqual({ mcpServers: {} })
  expect(disallowedOf(args)).toEqual([...WINDOW_UNUSED_TOOLS])
  expect(args.slice(args.indexOf('--disallowedTools') + 2).at(0), 'a variadic flag never stands right before the prompt').toMatch(/^--/)
  expect(args.at(-1)).toBe(PROMPT)
  expect(DEFAULT_CLAUDE).toBe(WINDOW_DIET_COMMAND)
  expect(WINDOW_KEPT_TOOLS).toEqual(expect.arrayContaining(TOOLS_THE_WINDOW_KEEPS))
  expect(WINDOW_KEPT_TOOLS.filter(kept => disallowedOf(args).includes(kept))).toEqual([])
})

it('the window command never disallows a tool the window keeps', () => {
  const { args } = windowInvocation(PROMPT)
  expect(TOOLS_THE_WINDOW_KEEPS.filter(kept => disallowedOf(args).includes(kept))).toEqual([])
  expect(args).not.toContain('--tools')
  expect(args).not.toContain('--disable-slash-commands')
})

it('the card session command is unchanged by the window diet', () => {
  const card = clientAdapter().invocation({ ...windowSpec(PROMPT), role: 'launch' })
  if ('kind' in card)
    throw new Error(card.reason)
  expect(card.args).toEqual(['--permission-mode', 'dontAsk', '--settings', JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: [path.join(homedir(), '.claude', 'CLAUDE.md')] }), '--tools', 'Read,Edit,Write,Bash,Grep,Glob', '--disable-slash-commands', '-p', '--session-id', SESSION])
  expect(card.args).not.toContain('--disallowedTools')
  expect(card.args).not.toContain('--mcp-config')
})

it('the window invocation equals the command of the existing loop', () => {
  const invocation = windowInvocation('')
  expect([invocation.command, ...invocation.args].join(' ')).toBe(WINDOW_DIET_COMMAND)
  expect(DEFAULT_CLAUDE).toBe(WINDOW_DIET_COMMAND)
  expect(claudeCommand({})).toBe(DEFAULT_CLAUDE)
  expect(argvThroughTheLoop(claudeCommand({}), PROMPT)).toEqual(windowInvocation(PROMPT).args)
  expect(argvThroughTheLoop(claudeCommand({}), '')).toEqual([...invocation.args, ''])
  expect(CLAUDE_VARIABLE).toBe('MIKO_CLAUDE')
  expect(WINDOW_COMMAND_VARIABLE).toBe(CLAUDE_VARIABLE)
  expect(claudeCommand({ [CLAUDE_VARIABLE]: '$STUB --from-the-owner' })).toBe('$STUB --from-the-owner')
  expect(argvThroughTheLoop(claudeCommand({ [CLAUDE_VARIABLE]: '$STUB --from-the-owner' }), PROMPT)).toEqual(['--from-the-owner', PROMPT])
})

it('the sandbox directory of the lock and of the shift settings is one value', () => {
  const home = scratch()
  writeFileSync(path.join(home, '.construct'), '')
  expect(path.dirname(queueDir({}, home))).toBe(CLIENT_SANDBOX_DIRECTORY)
  expect(path.dirname(TSX_PIPE_DIRECTORY)).toBe(CLIENT_SANDBOX_DIRECTORY)
})

it('the loop and the exit read the window through the adapter functions themselves', () => {
  expect(claudeCommand).toBe(windowCommand)
  expect(exitOwnerMessagesOf).toBe(ownerMessagesOf)
  expect(agentsStoppedTasksOf).toBe(stoppedTasksOf)
})

it('the adapter finds a transcript under any project, throws without the projects directory, and the window keeps its null', () => {
  const home = scratch()
  const file = transcriptIn(home, SESSION, [])
  expect(findTranscript(home, SESSION)).toBe(file)
  expect(findTranscript(home, 'another')).toBeNull()
  expect(sessionTranscriptOf(home, SESSION)).toBe(file)
  const empty = scratch()
  expect(() => findTranscript(empty, SESSION)).toThrow()
  expect(sessionTranscriptOf(empty, SESSION)).toBeNull()
  expect(sessionTranscriptOf(home, '../escape')).toBeNull()
})

it('the counters, context and model come from the assistant lines, the last one for the context, and a torn line counts for nothing', () => {
  const text = [userLine('hello', { timestamp: STARTED_AT }), assistantLine(1, 2, 3), '{"torn', 'null', assistantLine(10, 20, 30)].join('\n')
  expect(transcriptCounters(text)).toEqual({ start: { input: 1, cache_write: 2, cache_read: 3 }, end: { input: 10, cache_write: 20, cache_read: 30 }, startedAt: STARTED_AT })
  expect(transcriptContext(text)).toBe(60)
  expect(transcriptModel(text)).toBe(MODEL)
  expect(transcriptCounters('{"torn')).toEqual({ start: null, end: null, startedAt: null })
  expect(transcriptContext('')).toBeNull()
  expect(transcriptModel('')).toBeNull()
})

it('an owner message is a user text that is neither meta, a sidechain, a tag nor a tool result', () => {
  const text = [
    userLine('the owner speaks'),
    userLine([{ type: 'text', text: 'the owner again' }]),
    userLine('<command-name>/status</command-name>'),
    userLine('meta', { isMeta: true }),
    userLine('sidechain', { isSidechain: true }),
    userLine([{ type: 'tool_result' }, { type: 'text', text: 'tool' }]),
    'null',
  ].join('\n')
  expect(ownerMessagesOf(text)).toBe(2)
})

it('a stopped task is the id of a TaskStop tool use and nothing else', () => {
  const stop = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'TaskStop', input: { task_id: 'a1' } }, { type: 'tool_use', name: 'Bash', input: { task_id: 'a2' } }] } })
  expect(stoppedTasksOf([stop, 'null', '{"torn', userLine('text')].join('\n'))).toEqual(new Set(['a1']))
})

it('the measured session the adapter reads is what the window gauges report', () => {
  const home = scratch()
  const file = transcriptIn(home, SESSION, [assistantLine(1, 2, 3), assistantLine(10, 20, 30)])
  const measured = measuredSession(home, file)
  expect(measured.context).toBe(60)
  expect(measured.spent).toBe(measuredSpent(home, file))
  expect(sessionGauges(home, home, SESSION)).toEqual({ ...measured, model: MODEL })
})
