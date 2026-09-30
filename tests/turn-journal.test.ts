import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = path.resolve(import.meta.dirname, '../.claude/hooks/turn-journal.mjs')
const USAGE = { input_tokens: 1, output_tokens: 1 }
const CANARY = 'CANARY-7Q'
const roots: string[] = []

interface Journal { kind: string, [key: string]: any }

function project(): { root: string, transcript: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-turns-'))
  roots.push(root)
  const transcript = path.join(root, 's.jsonl')
  writeFileSync(transcript, '')
  return { root, transcript }
}

function fire(root: string, transcript: string, event: string, extra: Record<string, unknown> = {}): void {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: root, hook_event_name: event, ...extra }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
}

function assistant(request: string, usage: Record<string, number>, tools: string[] = []): string {
  return `${JSON.stringify({ type: 'assistant', requestId: request, message: { role: 'assistant', model: 'm-1', usage, content: tools.map(name => ({ type: 'tool_use', id: 't', name, input: {} })) } })}\n`
}

function journal(root: string): Journal[] {
  const file = path.join(root, '.construct', 'turns.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Journal) : []
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fireInPieces(root: string, transcript: string, event: string, pieces: Array<{ afterMs: number, text: string }>): Promise<{ status: number | null, stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
    let stdout = ''
    child.stdout.on('data', (chunk: Uint8Array) => {
      stdout += String(chunk)
    })
    child.on('close', status => resolve({ status, stdout }))
    let elapsed = 0
    pieces.forEach(({ afterMs, text }, index) => {
      elapsed += afterMs
      setTimeout(() => index === pieces.length - 1 ? child.stdin.end(text) : child.stdin.write(text), elapsed)
    })
  })
}

describe('the turn journal hook, fired by a parent that writes stdin when it writes it', () => {
  const input = (root: string, transcript: string, event: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: root, hook_event_name: event, ...extra })

  it('records a turn whose prompt arrives 200 ms after the spawn', async () => {
    const { root, transcript } = project()
    const prompt = await fireInPieces(root, transcript, 'UserPromptSubmit', [{ afterMs: 200, text: input(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-late' }) }])
    appendFileSync(transcript, assistant('r1', { input_tokens: 5, output_tokens: 6 }))
    const stop = await fireInPieces(root, transcript, 'Stop', [{ afterMs: 200, text: input(root, transcript, 'Stop', { prompt_id: 'p-late' }) }])

    expect([prompt.status, stop.status]).toEqual([0, 0])
    expect([prompt.stdout, stop.stdout]).toEqual(['', ''])
    expect(journal(root).filter(line => line.kind === 'turn').map(line => line.prompt)).toEqual(['p-late'])
  })

  it('records a prompt whose input arrives in two writes 100 ms apart, and one of 300 KB', async () => {
    const { root, transcript } = project()
    const text = input(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-split', prompt: 'x'.repeat(300_000) })
    const half = Math.floor(text.length / 2)
    await fireInPieces(root, transcript, 'UserPromptSubmit', [{ afterMs: 0, text: text.slice(0, half) }, { afterMs: 100, text: text.slice(half) }])
    appendFileSync(transcript, assistant('r1', { input_tokens: 5, output_tokens: 6 }))
    fire(root, transcript, 'Stop', { prompt_id: 'p-split' })

    expect(journal(root).filter(line => line.kind === 'turn').map(line => line.prompt)).toEqual(['p-split'])
  })
})

describe('the turn journal hook, when it cannot read its input', () => {
  for (const [name, stdin, reason] of [['empty', '', 'empty'], ['not JSON', 'nope', 'not-json'], ['a JSON array', '[]', 'not-an-object']] as const) {
    it(`writes an unread line naming ${reason} for input that is ${name}, and still exits 0 with nothing on stdout`, () => {
      const { root } = project()
      const result = spawnSync('node', [HOOK], { input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(journal(root).map(line => [line.kind, line.reason])).toEqual([['unread', reason]])
    })
  }
})

describe('the turn journal hook', () => {
  it('a turn is the transcript bytes between a prompt and the stop that ends it', () => {
    const { root, transcript } = project()
    appendFileSync(transcript, assistant('r0', { input_tokens: 1000, output_tokens: 1000 }, ['Bash']))
    const from = statSync(transcript).size
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1', prompt: 'do it' })
    const call = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }
    appendFileSync(transcript, assistant('r1', call, ['Bash', 'Agent']))
    appendFileSync(transcript, assistant('r1', call, ['Read']))
    appendFileSync(transcript, 'not json\n')
    appendFileSync(transcript, `${JSON.stringify({ type: 'a-kind-from-a-later-version', payload: { n: 1 } })}\n`)
    appendFileSync(transcript, assistant('r2', { input_tokens: 1, output_tokens: 2 }))
    const to = statSync(transcript).size
    fire(root, transcript, 'Stop', { prompt_id: 'p-1' })
    const [turn, ...rest] = journal(root)
    expect(rest).toEqual([])
    expect(turn).toMatchObject({ v: 1, kind: 'turn', session: 'sess-1', prompt: 'p-1', end: 'stop', from, to, usage: { calls: 2, input: 11, cacheWrite: 20, cacheRead: 30, output: 42, models: ['m-1'] }, toolCalls: { Bash: 1, Agent: 1, Read: 1 }, unreadable: 1 })
    expect(turn.startedAt <= turn.endedAt).toBe(true)
  })

  it('a line written after its stop is counted once, for the turn it follows', () => {
    const { root, transcript } = project()
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1' })
    appendFileSync(transcript, assistant('r1', USAGE, ['Bash']))
    fire(root, transcript, 'Stop', { prompt_id: 'p-1' })
    appendFileSync(transcript, assistant('r1', USAGE, ['Read']))
    appendFileSync(transcript, assistant('r2', USAGE))
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-2' })
    appendFileSync(transcript, assistant('r3', USAGE))
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-3' })
    appendFileSync(transcript, assistant('r4', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-3' })
    appendFileSync(transcript, assistant('r5', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-3', stop_hook_active: true })
    const lines = journal(root)
    expect(lines.map(line => [line.kind, line.prompt, line.end, line.usage.calls])).toEqual([['turn', 'p-1', 'stop', 1], ['late', 'p-1', undefined, 1], ['turn', 'p-2', 'superseded', 1], ['turn', 'p-3', 'stop', 1], ['late', 'p-3', undefined, 1]])
    expect(lines[1].toolCalls).toEqual({ Read: 1 })
    lines.slice(1).forEach((line, index) => expect(line.from).toBe(lines[index].to))
    expect(lines.at(-1)?.to).toBe(statSync(transcript).size)
  })

  it('a transcript that shrank leaves the turn unmeasured, never zero', () => {
    const { root, transcript } = project()
    appendFileSync(transcript, assistant('r1', USAGE))
    const whole = statSync(transcript).size
    const cut = assistant('r2', { input_tokens: 5, output_tokens: 5 })
    appendFileSync(transcript, cut.slice(0, 20))
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1' })
    appendFileSync(transcript, cut.slice(20))
    fire(root, transcript, 'Stop', { prompt_id: 'p-1' })
    expect(journal(root)[0]).toMatchObject({ kind: 'turn', from: whole, to: statSync(transcript).size, usage: { calls: 1, input: 5 } })
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-2' })
    writeFileSync(transcript, assistant('r9', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-2' })
    expect(journal(root)[1]).toMatchObject({ kind: 'turn', prompt: 'p-2', usage: 'unknown', reset: 'shrunk', from: null })
    const after = statSync(transcript).size
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-3' })
    appendFileSync(transcript, assistant('r10', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-3' })
    expect(journal(root)[2]).toMatchObject({ kind: 'turn', prompt: 'p-3', from: after, to: statSync(transcript).size, usage: { calls: 1 } })
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-4' })
    const moved = path.join(root, 'moved.jsonl')
    writeFileSync(moved, assistant('r11', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-4', transcript_path: moved })
    expect(journal(root)[3]).toMatchObject({ kind: 'turn', prompt: 'p-4', usage: 'unknown', reset: 'moved' })
  })

  it('no message content reaches the journal or the state', () => {
    const { root, transcript } = project()
    const scan = (): string[] => {
      const construct = path.join(root, '.construct')
      const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
      return existsSync(construct) ? files(construct).filter(file => readFileSync(file, 'utf8').includes(CANARY)) : []
    }
    const content = [{ type: 'text', text: CANARY }, { type: 'thinking', thinking: CANARY }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: CANARY } }]
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1', prompt: CANARY, prompt_text: CANARY })
    expect(scan()).toEqual([])
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: CANARY }] }, toolUseResult: { stdout: CANARY } })}\n`)
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', requestId: 'r1', message: { role: 'assistant', model: 'm-1', usage: USAGE, content } })}\n`)
    appendFileSync(transcript, `${CANARY} is not JSON\n`)
    const agent = path.join(root, 'agent-a1.jsonl')
    writeFileSync(agent, `${JSON.stringify({ type: 'assistant', requestId: 's1', message: { role: 'assistant', model: 'm-1', usage: USAGE, content } })}\n`)
    fire(root, transcript, 'SubagentStop', { prompt_id: 'p-1', agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: agent, last_assistant_message: CANARY })
    expect(scan()).toEqual([])
    fire(root, transcript, 'Stop', { prompt_id: 'p-1', last_assistant_message: CANARY })
    fire(root, transcript, 'SessionEnd', { reason: 'other' })
    expect(scan()).toEqual([])
    expect(journal(root).length).toBeGreaterThanOrEqual(3)
    const before = journal(root).length
    for (const session of ['../escaped', 'a/b', '', '..'])
      fire(root, transcript, 'UserPromptSubmit', { session_id: session, prompt_id: 'p-9' })
    expect(journal(root)).toHaveLength(before)
    expect(existsSync(path.join(path.dirname(root), 'escaped.json'))).toBe(false)
  })

  it('a held lock is waited for and given up on, a stale one is broken', () => {
    const { root, transcript } = project()
    const lock = path.join(root, '.construct', 'turns.lock')
    mkdirSync(lock, { recursive: true })
    const started = Date.now()
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(existsSync(lock)).toBe(true)
    expect(existsSync(path.join(root, '.construct', 'turns.d', 'sess-1.json'))).toBe(false)
    const old = new Date(Date.now() - 600_000)
    utimesSync(lock, old, old)
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1' })
    appendFileSync(transcript, assistant('r1', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-1' })
    expect(journal(root).map(line => line.kind)).toEqual(['turn'])
    expect(existsSync(lock)).toBe(false)
  })

  it('a subagent line reads only what was added, and a session end closes the turn and removes the state', () => {
    const { root, transcript } = project()
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-1' })
    const agent = path.join(root, 'agent-a1.jsonl')
    writeFileSync(agent, assistant('s1', USAGE, ['Grep']) + assistant('s1', USAGE, ['Read']) + assistant('s2', USAGE))
    const stop = { prompt_id: 'p-1', agent_id: 'a1', agent_type: '', agent_transcript_path: agent }
    fire(root, transcript, 'SubagentStop', stop)
    const mid = statSync(agent).size
    appendFileSync(agent, assistant('s3', USAGE))
    fire(root, transcript, 'SubagentStop', stop)
    appendFileSync(transcript, assistant('r1', USAGE))
    fire(root, transcript, 'Stop', { prompt_id: 'p-1' })
    fire(root, transcript, 'UserPromptSubmit', { prompt_id: 'p-2' })
    appendFileSync(transcript, assistant('r2', USAGE))
    fire(root, transcript, 'SessionEnd', { reason: 'clear' })
    const lines = journal(root)
    expect(lines.map(line => [line.kind, line.agentType, line.from, line.usage?.calls])).toEqual([['subagent', '', 0, 2], ['subagent', '', mid, 1], ['turn', undefined, 0, 1], ['turn', undefined, lines[2]?.to, 1], ['session-end', undefined, undefined, undefined]])
    expect(lines[0].toolCalls).toEqual({ Grep: 1, Read: 1 })
    expect(lines[3]).toMatchObject({ prompt: 'p-2', end: 'session-end' })
    expect(lines[4]).toMatchObject({ session: 'sess-1', reason: 'clear' })
    expect(existsSync(path.join(root, '.construct', 'turns.d', 'sess-1.json'))).toBe(false)
  })
})
