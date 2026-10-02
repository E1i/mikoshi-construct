import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = path.resolve(import.meta.dirname, '../.claude/hooks/eddies.mjs')
const SESSION = 'sess-eddies'
const LIMITS = { contextLimit: 150000, sessionSpend: 3000000, agentSpend: 1500000, runSpend: 3000000, warnRatio: 0.8 }
const SPEND_BASIS = 'spent = input_tokens + cache_creation_input_tokens × 1.25 + cache_read_input_tokens × 0.1, summed over the messages read, each requestId counted once (the last record wins)'
const CONTEXT_BASIS = 'context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens of the last response in the parent transcript'
const scratches: string[] = []

interface Usage { input?: number, cacheWrite?: number, cacheRead?: number, request?: string | null }
interface EddiesLine { event: string, level?: string, [key: string]: unknown }
interface Scratch { root: string, transcript: string, subagents: string }

let requests = 0

function response({ input = 0, cacheWrite = 0, cacheRead = 0, request }: Usage): string {
  requests += 1
  const requestId = request === undefined ? `req_${requests}` : request
  return `${JSON.stringify({ type: 'assistant', ...(requestId === null ? {} : { requestId }), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: 16 } } })}\n`
}

function transcriptFile(file: string, responses: Usage[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n${responses.map(response).join('')}`)
}

function scratch(limits: Record<string, number> | null = LIMITS, parent: Usage[] = [{ input: 10, cacheWrite: 1000, cacheRead: 5000 }]): Scratch {
  const base = mkdtempSync(path.join(tmpdir(), 'construct-eddies-'))
  scratches.push(base)
  const root = path.join(base, 'repo')
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  if (limits !== null)
    writeFileSync(path.join(root, '.claude', 'eddies.json'), `${JSON.stringify(limits)}\n`)
  const transcript = path.join(base, 'projects', `${SESSION}.jsonl`)
  transcriptFile(transcript, parent)
  return { root, transcript, subagents: path.join(base, 'projects', SESSION, 'subagents') }
}

function agentFile(s: Scratch, agentId: string, responses: Usage[], run?: string): void {
  transcriptFile(path.join(s.subagents, ...(run === undefined ? [] : ['workflows', run]), `agent-${agentId}.jsonl`), responses)
}

function hook(s: Scratch, mode: string, input: Record<string, unknown> | string): { status: number | null, stdout: string, stderr: string, ms: number } {
  const started = performance.now()
  const result = spawnSync('node', [HOOK, mode], {
    input: typeof input === 'string' ? input : JSON.stringify({ session_id: SESSION, transcript_path: s.transcript, cwd: s.root, ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: s.root },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started }
}

function call(s: Scratch, tool: string, toolInput: Record<string, unknown> = {}, agent: Record<string, string> = {}): ReturnType<typeof hook> {
  return hook(s, 'guard', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, ...agent })
}

function contextOf(result: { stdout: string }): unknown {
  const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: string, additionalContext?: unknown } }
  expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
  return output.hookSpecificOutput?.additionalContext
}

function lines(s: Scratch): EddiesLine[] {
  const file = path.join(s.root, '.construct', 'eddies.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as EddiesLine) : []
}

function stops(s: Scratch): EddiesLine[] {
  return lines(s).filter(line => line.event === 'budget-stop')
}

function lateGuard(s: Scratch, input: Record<string, unknown>, afterMs: number): Promise<{ status: number | null, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK, 'guard'], { env: { ...process.env, CLAUDE_PROJECT_DIR: s.root } })
    let stderr = ''
    child.stderr.on('data', (chunk: Uint8Array) => {
      stderr += String(chunk)
    })
    child.on('close', status => resolve({ status, stderr }))
    const text = JSON.stringify({ session_id: SESSION, transcript_path: s.transcript, ...input })
    setTimeout(() => child.stdin.write(text.slice(0, 20)), afterMs)
    setTimeout(() => child.stdin.end(text.slice(20)), afterMs * 2)
  })
}

const WARN_ACTION = 'finish the current step, save (milestone commit / handoff), start no new work'
const WARN_FIELDS = ['v', 'event', 'level', 'spent', 'limit', 'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'measurement_basis', 'session_id', 'agent_id', 'agent_type', 'run_id', 'warn_ratio', 'at']
const STOP_FIELDS = ['event', 'level', 'reason', 'tool', 'spent', 'limit', 'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'measurement_basis', 'session_id', 'agent_id', 'agent_type', 'run_id', 'at']

afterEach(() => {
  for (const base of scratches.splice(0))
    rmSync(base, { recursive: true, force: true })
})

describe('eddies: the budget hook refuses work past a threshold of .claude/eddies.json', () => {
  it('lets Agent through and writes nothing when every measure is below its threshold (W1)', () => {
    const s = scratch()
    agentFile(s, 'a1', [{ input: 1000, cacheWrite: 2000, cacheRead: 3000 }])

    expect(call(s, 'Agent', { subagent_type: 'scan', prompt: 'p' })).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(lines(s)).toEqual([])
  })

  it('refuses only new work once the parent context reaches contextLimit, one budget-stop line per refusal (W2)', () => {
    const s = scratch(LIMITS, [{ input: 1, cacheWrite: 1000, cacheRead: 149000 }])
    const refused = [
      call(s, 'Agent', { subagent_type: 'scan', prompt: 'p' }),
      call(s, 'Workflow', { script: 'x' }),
      call(s, 'Bash', { command: 'claude -p x' }),
      call(s, 'Bash', { command: 'pnpm ghosts:launch' }),
    ]
    const allowed = [
      call(s, 'Read', { file_path: '/x' }),
      call(s, 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }),
      call(s, 'Write', { file_path: '/x', content: 'handoff' }),
      call(s, 'Bash', { command: 'ls' }),
    ]

    expect(refused.map(result => result.status)).toEqual([2, 2, 2, 2])
    expect(refused[0].stderr).toBe('eddies: session-context stop — context 150001 / limit 150000 (contextLimit in .claude/eddies.json); no new work — write the handoff and stop\n')
    expect(allowed.map(result => result.status)).toEqual([0, 0, 0, 0])
    expect(stops(s).map(line => [line.level, line.tool])).toEqual([['session-context', 'Agent'], ['session-context', 'Workflow'], ['session-context', 'Bash'], ['session-context', 'Bash']])
    for (const line of stops(s))
      expect(Object.keys(line)).toEqual(expect.arrayContaining(STOP_FIELDS))
    expect(stops(s)[0]).toMatchObject({ reason: 'context 150001 >= contextLimit 150000', spent: 150001, limit: 150000, input_tokens: 1, cache_creation_input_tokens: 1000, cache_read_input_tokens: 149000, measurement_basis: CONTEXT_BASIS, session_id: SESSION, agent_id: null, agent_type: null, run_id: null })
  })

  it('refuses Agent at session-spend when the parent context is small and its subagents carry the spend (W3)', () => {
    const s = scratch(LIMITS, [{ input: 300000 }, { input: 10, cacheWrite: 1000, cacheRead: 5000 }])
    agentFile(s, 'a1', [{ input: 150000, cacheWrite: 1000000 }])
    agentFile(s, 'w1', [{ input: 150000, cacheWrite: 1000000 }], 'wf_A')
    const result = call(s, 'Agent', { subagent_type: 'scan', prompt: 'p' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('session-spend stop')
    expect(stops(s)).toEqual([expect.objectContaining({ level: 'session-spend', spent: 3101760, limit: 3000000, measurement_basis: SPEND_BASIS })])
  })

  it('refuses every call of an agent past agentSpend and lets another agent below it through (W4)', () => {
    const s = scratch()
    agentFile(s, 'a1', [{ input: 1600000 }])
    agentFile(s, 'a2', [{ input: 100000 }])
    const over = { agent_id: 'a1', agent_type: 'general-purpose' }
    const results = [call(s, 'Bash', { command: 'ls' }, over), call(s, 'Read', { file_path: '/x' }, over)]

    expect(results.map(result => result.status)).toEqual([2, 2])
    expect(results[0].stderr).toBe('eddies: agent stop — spent 1600000 / limit 1500000 (agentSpend in .claude/eddies.json); return what you have now\n')
    expect(call(s, 'Bash', { command: 'ls' }, { agent_id: 'a2', agent_type: 'general-purpose' }).status).toBe(0)
    expect(stops(s).map(line => [line.level, line.agent_id, line.tool])).toEqual([['agent', 'a1', 'Bash'], ['agent', 'a1', 'Read']])
  })

  it('refuses a workflow agent once its run reaches runSpend though each agent is below agentSpend, and not one of another run (W5)', () => {
    const s = scratch()
    agentFile(s, 'x1', [{ input: 1400000 }], 'wf_X')
    agentFile(s, 'x2', [{ input: 1400000 }], 'wf_X')
    agentFile(s, 'x3', [{ input: 300000 }], 'wf_X')
    agentFile(s, 'y1', [{ input: 1400000 }], 'wf_Y')
    const result = call(s, 'Bash', { command: 'ls' }, { agent_id: 'x1', agent_type: 'workflow-subagent' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('run stop — spent 3100000 / limit 3000000 (runSpend')
    expect(call(s, 'Bash', { command: 'ls' }, { agent_id: 'y1', agent_type: 'workflow-subagent' }).status).toBe(0)
    expect(stops(s)).toEqual([expect.objectContaining({ level: 'run', run_id: 'wf_X', agent_id: 'x1', agent_type: 'workflow-subagent', spent: 3100000 })])
  })

  it.each(['implementer', 'harness', 'architect'])('refuses a ladder role whose hook carries its role name %s as agent_type once its run reaches runSpend, because its transcript sits in the run', (role) => {
    const s = scratch()
    agentFile(s, 'r1', [{ input: 1400000 }], 'wf_L')
    agentFile(s, 'r2', [{ input: 1400000 }], 'wf_L')
    agentFile(s, 'r3', [{ input: 300000 }], 'wf_L')
    const result = call(s, 'Bash', { command: 'ls' }, { agent_id: 'r2', agent_type: role })

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('eddies: run stop — spent 3100000 / limit 3000000 (runSpend in .claude/eddies.json); return what you have now\n')
    expect(stops(s)).toEqual([expect.objectContaining({ event: 'budget-stop', level: 'run', run_id: 'wf_L', agent_id: 'r2', agent_type: role, spent: 3100000 })])
  })

  it('keeps an Agent subagent of the window on its own agentSpend, with no run measured, whatever its sibling transcripts sum to', () => {
    const s = scratch()
    agentFile(s, 'b1', [{ input: 1400000 }])
    agentFile(s, 'b2', [{ input: 1400000 }])
    agentFile(s, 'b3', [{ input: 300000 }])
    const result = call(s, 'Bash', { command: 'ls' }, { agent_id: 'b1', agent_type: 'brief' })

    expect(result.status).toBe(0)
    expect(stops(s)).toEqual([])
    expect(lines(s).map(line => [line.event, line.level])).toEqual([['budget-warn', 'agent']])
  })

  it('measures spent exactly by the formula, each streamed requestId once with its last record, and records the raw components (W6)', () => {
    const s = scratch({ ...LIMITS, agentSpend: 1000 })
    agentFile(s, 'a1', [
      { request: 'req_dup', input: 100, cacheWrite: 200, cacheRead: 1000 },
      { request: 'req_dup', input: 100, cacheWrite: 400, cacheRead: 3000 },
      { request: 'req_two', input: 40, cacheRead: 500 },
      { request: null, input: 10 },
    ])
    const result = call(s, 'Read', { file_path: '/x' }, { agent_id: 'a1', agent_type: 'general-purpose' })

    expect(result.status).toBe(2)
    expect(stops(s)).toEqual([expect.objectContaining({ level: 'agent', spent: 150 + 400 * 1.25 + 3500 * 0.1, input_tokens: 150, cache_creation_input_tokens: 400, cache_read_input_tokens: 3500, measurement_basis: SPEND_BASIS })])
  })

  it('tells the window once on UserPromptSubmit at 85%, in the warn text, with one budget-warn line; at 70% prints and records nothing (W7)', () => {
    const high = scratch(LIMITS, [{ input: 127500 }])
    const first = hook(high, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' })
    const second = hook(high, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' })
    const low = scratch(LIMITS, [{ input: 105000 }])

    expect(first).toMatchObject({ status: 0, stdout: `eddies: session-context warn — context 127500 / warn threshold 120000 (limit 150000, contextLimit in .claude/eddies.json); ${WARN_ACTION}\n` })
    expect(second).toMatchObject({ status: 0, stdout: '' })
    expect(lines(high)).toEqual([expect.objectContaining({ event: 'budget-warn', level: 'session-context', spent: 127500, limit: 150000, warn_ratio: 0.8 })])
    expect(Object.keys(lines(high)[0])).toEqual(WARN_FIELDS)
    expect(hook(low, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' })).toMatchObject({ status: 0, stdout: '' })
    expect(lines(low)).toEqual([])
  })

  it('puts the warn into the context of an agent past 80% of agentSpend on its next call, once, as PreToolUse additionalContext (W10)', () => {
    const s = scratch()
    agentFile(s, 'a1', [{ input: 1300000 }])
    const agent = { agent_id: 'a1', agent_type: 'general-purpose' }
    const first = call(s, 'Read', { file_path: '/x' }, agent)
    const second = call(s, 'Read', { file_path: '/x' }, agent)

    expect(first.status).toBe(0)
    expect(contextOf(first)).toBe(`eddies: agent warn — spent 1300000 / warn threshold 1200000 (limit 1500000, agentSpend in .claude/eddies.json); ${WARN_ACTION}\n`)
    expect(second).toMatchObject({ status: 0, stdout: '' })
    expect(lines(s)).toEqual([expect.objectContaining({ event: 'budget-warn', level: 'agent', agent_id: 'a1', spent: 1300000, limit: 1500000, warn_ratio: 0.8 })])
    expect(Object.keys(lines(s)[0])).toEqual(WARN_FIELDS)
  })

  it('puts the run warn into the context of the workflow agent whose call first sees its run past 80% of runSpend, once per run (W11)', () => {
    const s = scratch()
    agentFile(s, 'x1', [{ input: 1300000 }], 'wf_X')
    agentFile(s, 'x2', [{ input: 1300000 }], 'wf_X')
    const first = call(s, 'Bash', { command: 'ls' }, { agent_id: 'x2', agent_type: 'workflow-subagent' })

    expect(contextOf(first)).toContain('eddies: run warn — spent 2600000 / warn threshold 2400000 (limit 3000000, runSpend')
    expect(call(s, 'Bash', { command: 'ls' }, { agent_id: 'x1', agent_type: 'workflow-subagent' }).stdout).toContain('eddies: agent warn')
    expect(lines(s).map(line => [line.level, line.agent_id])).toEqual([['agent', 'x2'], ['run', 'x2'], ['agent', 'x1']])
  })

  it('puts the warn into the window context on its first tool call past 80%, not only on new work or the next prompt, once (W12)', () => {
    const s = scratch(LIMITS, [{ input: 127500 }])
    const first = call(s, 'Read', { file_path: '/x' })
    const second = call(s, 'Bash', { command: 'ls' })

    expect(first.status).toBe(0)
    expect(contextOf(first)).toBe(`eddies: session-context warn — context 127500 / warn threshold 120000 (limit 150000, contextLimit in .claude/eddies.json); ${WARN_ACTION}\n`)
    expect(second).toMatchObject({ status: 0, stdout: '' })
    expect(hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }).stdout).toBe('')
    expect(lines(s)).toEqual([expect.objectContaining({ event: 'budget-warn', level: 'session-context', session_id: SESSION, agent_id: null })])
  })

  it('warns the window on its next prompt and tool call though an agent starting new work was warned first at the same session level, and each once (W13)', () => {
    const s = scratch(LIMITS, [{ input: 127500 }])
    agentFile(s, 'a1', [{ input: 10 }])
    const agent = call(s, 'Bash', { command: 'claude -p x' }, { agent_id: 'a1', agent_type: 'general-purpose' })
    const window = hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' })
    const warn = `eddies: session-context warn — context 127500 / warn threshold 120000 (limit 150000, contextLimit in .claude/eddies.json); ${WARN_ACTION}\n`

    expect(contextOf(agent)).toBe(warn)
    expect(window).toMatchObject({ status: 0, stdout: warn })
    expect(call(s, 'Read', { file_path: '/x' }).stdout).toBe('')
    expect(call(s, 'Bash', { command: 'claude -p y' }, { agent_id: 'a1', agent_type: 'general-purpose' }).stdout).toBe('')
    expect(lines(s).map(line => [line.event, line.level, line.agent_id])).toEqual([['budget-warn', 'session-context', 'a1'], ['budget-warn', 'session-context', null]])
  })

  it('records nothing on the first prompt of a session whose transcript is not created yet (W14)', () => {
    const s = scratch()
    rmSync(s.transcript)

    expect(hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' })).toMatchObject({ status: 0, stdout: '' })
    expect(lines(s)).toEqual([])
  })

  it('records transcript-ENOENT on a prompt when the transcript it already read is gone', () => {
    const s = scratch()
    expect(hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }).status).toBe(0)
    rmSync(s.transcript)

    expect(hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }).status).toBe(0)
    expect(lines(s)).toEqual([expect.objectContaining({ event: 'unread', hook: 'eddies-prompt', reason: 'transcript-ENOENT', session_id: SESSION })])
  })

  it('lets the call through with an unread line when the transcript or the config cannot be read, and refuses unreadable stdin (W8)', () => {
    const noTranscript = scratch()
    rmSync(noTranscript.transcript)
    const noConfig = scratch(null)

    expect(call(noTranscript, 'Agent', { prompt: 'p' }).status).toBe(0)
    expect(lines(noTranscript)).toEqual([expect.objectContaining({ event: 'unread', reason: 'transcript-ENOENT', session_id: SESSION })])
    expect(call(noConfig, 'Agent', { prompt: 'p' }).status).toBe(0)
    expect(lines(noConfig)).toEqual([expect.objectContaining({ event: 'unread', reason: 'config-missing' })])
    expect(hook(noConfig, 'guard', 'not json').status).toBe(2)
  })

  it('refuses on stdin its parent writes in pieces, 200 ms late, as it refuses on stdin written at once', async () => {
    const s = scratch(LIMITS, [{ input: 1, cacheWrite: 1000, cacheRead: 149000 }])

    expect(await lateGuard(s, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'p' } }, 200)).toMatchObject({ status: 2, stderr: expect.stringContaining('session-context stop') })
  })

  it('reads only the tail of a grown 50 MB transcript on the second call and stays inside the 5 s timeout (W9)', () => {
    const s = scratch()
    const filler = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(1000) } })}\n`
    appendFileSync(s.transcript, filler.repeat(Math.ceil(50_000_000 / filler.length)))
    appendFileSync(s.transcript, response({ input: 10, cacheWrite: 1000, cacheRead: 5000 }))
    expect(call(s, 'Agent', { prompt: 'p' }).status).toBe(0)
    const tail = response({ input: 20, cacheWrite: 1000, cacheRead: 5000 })
    appendFileSync(s.transcript, tail)
    const second = call(s, 'Agent', { prompt: 'p' })
    const stateDir = path.join(s.root, '.construct', 'eddies.d')
    const states = readdirSync(stateDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(path.join(stateDir, name), 'utf8')) as { offset: number, lastRead: number })
    const parent = states.find(state => state.offset > 50_000_000)

    expect(second.status).toBe(0)
    expect(parent?.lastRead).toBe(Buffer.byteLength(tail))
    expect(second.ms).toBeLessThan(5000)
    process.stdout.write(`W9 second call: ${Math.round(second.ms)} ms\n`)
  }, 60_000)
})
