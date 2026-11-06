import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refusedOwnerQuestionIn } from '../../nodes/answer/answerer.js'
import { clientLastSteps, hasClientTranscript, transcriptFile } from '../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { readResultFields } from '../../ports/result.js'
import { streamReading } from '../../ports/session.js'

const TREE = '/tree'
const SESSION = 'recorded-session'

const RECORDED_INIT = '{"type":"system","subtype":"init","cwd":"/tree","session_id":"recorded-session","tools":["Task","Bash","Edit","Read","Write"],"mcp_servers":[],"model":"claude-opus-5-5"}'
const RECORDED_READ = '{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_recorded_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_recorded_1","name":"Read","input":{"file_path":"/tree/src/a.ts"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null}}'
const RECORDED_BASH = '{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_recorded_2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_recorded_2","name":"Bash","input":{"command":"git -C /tree status --short","description":"Read review role and diff stat"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null}}'
const RECORDED_EDIT = '{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_recorded_3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_recorded_3","name":"Edit","input":{"file_path":"/tree/src/a.ts","old_string":"a","new_string":"b","replace_all":false},"caller":{"type":"direct"}}],"container":null,"stop_reason":null}}'
const RECORDED_RESULT = '{"duration_api_ms":183144,"stop_reason":"end_turn","session_id":"recorded-session","total_cost_usd":1.2936034,"usage":{"input_tokens":52,"cache_creation_input_tokens":77211,"cache_read_input_tokens":1831537,"output_tokens":15470,"output_tokens_details":{"thinking_tokens":5378},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":77211,"ephemeral_5m_input_tokens":0},"inference_geo":"global","speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"completed","safety_stops":0,"is_error":false,"num_turns":26,"subtype":"success","api_error_status":null,"result":"My verdict is changes, with four findings.","type":"result"}'
const RECORDED_DENIAL = '{"duration_api_ms":265162,"stop_reason":"end_turn","session_id":"recorded-session","total_cost_usd":1.7613276,"usage":{"input_tokens":48,"cache_creation_input_tokens":101173,"cache_read_input_tokens":2324158,"output_tokens":24346,"output_tokens_details":{"thinking_tokens":7834}},"permission_denials":[{"tool_name":"Edit","tool_use_id":"toolu_recorded_4","tool_input":{"file_path":"/tree/.claude/settings.json","old_string":"before","new_string":"after","replace_all":false}}],"terminal_reason":"completed","is_error":false,"num_turns":32,"subtype":"success","api_error_status":null,"result":"The owner must allow this edit.","type":"result"}'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'client-reading-'))
  roots.push(root)
  return root
}

function aStream(...lines: string[]): string {
  const file = path.join(aRoot(), 'out.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function aTranscript(...lines: string[]): void {
  const home = aRoot()
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
  const file = transcriptFile(home, TREE, SESSION)!
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}

function transcriptReading(): ReturnType<typeof streamReading> {
  return clientAdapter().reading({ session: SESSION, cwd: TREE, stdoutPath: null, stderrPath: null, exitCode: null })
}

describe('a stream reading', () => {
  it('recorded real streams give the same values through the reading', () => {
    const stream = aStream(RECORDED_INIT, RECORDED_READ, RECORDED_BASH, RECORDED_EDIT, RECORDED_RESULT)
    const reading = streamReading(stream)

    expect(reading.end).toBe('completed')
    expect(reading.failure).toBeNull()
    expect(reading.usage).toEqual({ input: 52, cacheWrite: 77211, cached: 1831537, output: 15470, reasoning: 5378 })
    expect(reading.costUsd).toBe(1.2936034)
    expect(reading.turns).toBe(26)
    expect(reading.model).toBe('claude-opus-5-5')
    expect(reading.denials).toEqual([])
    expect(reading.toolUses).toEqual([
      { kind: 'other', command: null, path: '/tree/src/a.ts' },
      { kind: 'exec', command: 'git -C /tree status --short', path: null },
      { kind: 'write', command: null, path: '/tree/src/a.ts' },
    ])
    expect(readResultFields(stream)).toMatchObject({ resultLine: 'present', total_cost_usd: 1.2936034, num_turns: 26, duration_ms: null, usage: { input_tokens: 52, cache_read_input_tokens: 1831537 } })

    const refused = aStream(RECORDED_INIT, RECORDED_DENIAL)
    expect(streamReading(refused).denials).toEqual([{ tool: 'Edit', path: '/tree/.claude/settings.json', command: null, text: 'The owner must allow this edit.' }])
    expect(refusedOwnerQuestionIn(refused, '/tree/.claude/settings.json')).toBe('The owner must allow this edit.')
    expect(refusedOwnerQuestionIn(refused, '/tree/other.json')).toBeNull()

    const byCommand = aStream('{"type":"result","result":"Ask the owner.","permission_denials":[{"tool_input":{"command":"tee /tree/q.md"}}]}')
    expect(refusedOwnerQuestionIn(byCommand, '/tree/q.md')).toBe('Ask the owner.')
  })

  it('a denied file aims at the owner question only by its whole path, and a command by holding it', () => {
    const denied = (input: object): string => aStream(JSON.stringify({ type: 'result', result: 'Ask the owner.', permission_denials: [{ tool_name: 'Edit', tool_input: input }] }))

    expect(refusedOwnerQuestionIn(denied({ file_path: '/tree/q.md.bak', content: 'not the question' }), '/tree/q.md')).toBeNull()
    expect(refusedOwnerQuestionIn(denied({ file_path: '/tree/q.md', content: 'the question' }), '/tree/q.md')).toBe('the question')
    expect(refusedOwnerQuestionIn(denied({ file_path: '/tree/other.md', command: 'tee /tree/q.md' }), '/tree/q.md')).toBe('Ask the owner.')
  })

  it('what a stream does not report reads null and never zero', () => {
    const bare = streamReading(aStream('{"type":"result","is_error":false}'))
    expect(bare).toMatchObject({ end: 'completed', usage: null, costUsd: null, turns: null, durationMs: null, model: null, contextTokens: null, lastSteps: null, journal: 'unreadable' })

    const partial = streamReading(aStream('{"type":"result","usage":{"output_tokens":5}}'))
    expect(partial.usage).toEqual({ input: null, cached: null, cacheWrite: null, output: 5, reasoning: null })

    const absent = streamReading(path.join(aRoot(), 'none.jsonl'))
    expect(absent).toMatchObject({ end: 'missing', failure: null, usage: null, costUsd: null, turns: null, denials: [], toolUses: [] })

    aTranscript('{"type":"assistant","timestamp":"2026-11-05T00:00:00.000Z","message":{"role":"assistant","usage":{},"content":[]}}')
    expect(transcriptReading().contextTokens).toBeNull()
  })

  it('a result marked as an error reads failed with its text, and no result reads missing', () => {
    expect(streamReading(aStream('{"type":"result","is_error":true,"subtype":"error_during_execution","result":"the turn broke"}'))).toMatchObject({ end: 'failed', failure: 'the turn broke' })
    expect(streamReading(aStream('{"type":"result","is_error":true,"subtype":"error_max_turns"}'))).toMatchObject({ end: 'failed', failure: 'error_max_turns' })
    expect(streamReading(aStream(RECORDED_INIT, 'not json'))).toMatchObject({ end: 'missing', model: 'claude-opus-5-5' })
  })

  it('a nonzero exit with no stream line reads failed with stderr, and an exit with a stream reads by the stream', () => {
    const place = (stdoutPath: string, stderrPath: string | null, exitCode: number | null): ReturnType<typeof streamReading> => clientAdapter().reading({ session: '', cwd: '', stdoutPath, stderrPath, exitCode })
    const stderr = path.join(aRoot(), 'err')
    writeFileSync(stderr, 'the binary would not start\n')

    expect(place(aStream(''), stderr, 1)).toMatchObject({ end: 'failed', failure: 'the binary would not start' })
    expect(place(aStream(''), null, 1)).toMatchObject({ end: 'failed', failure: expect.stringContaining('exited 1') })
    expect(place(aStream(''), stderr, 0)).toMatchObject({ end: 'missing', failure: null })
    expect(place(aStream(''), stderr, null)).toMatchObject({ end: 'missing', failure: null })
    expect(place(aStream(RECORDED_INIT, RECORDED_RESULT), stderr, 1)).toMatchObject({ end: 'completed', failure: null })
  })

  it('the session of the client is the one the place names, else the one its stream reports, else null', () => {
    const stream = aStream(RECORDED_INIT, RECORDED_RESULT)

    expect(clientAdapter().reading({ session: SESSION, cwd: TREE, stdoutPath: aStream('{"type":"result"}'), stderrPath: null, exitCode: null }).clientSession).toBe(SESSION)
    expect(streamReading(stream).clientSession).toBe('recorded-session')
    expect(streamReading(aStream('{"type":"result"}')).clientSession).toBeNull()
  })

  it('the model is the model of the init event, whatever a hook line before it names', () => {
    const stream = aStream('{"type":"system","subtype":"hook_started","model":"not-this-one"}', 'not json', RECORDED_INIT)
    expect(streamReading(stream).model).toBe('claude-opus-5-5')
  })

  it('the span of a stream is its timestamps, read null with fewer than two', () => {
    expect(streamReading(aStream('{"timestamp":"2026-11-05T00:00:00.000Z"}', '{"timestamp":"2026-11-05T00:00:02.500Z"}')).durationMs).toBe(2500)
    expect(streamReading(aStream('{"timestamp":"2026-11-05T00:00:00.000Z"}')).durationMs).toBeNull()
  })
})

describe('a transcript reading', () => {
  const edit = '{"type":"assistant","timestamp":"2026-11-05T00:00:00.000Z","message":{"role":"assistant","model":"claude-opus-5-5","usage":{"input_tokens":3,"cache_creation_input_tokens":40,"cache_read_input_tokens":500},"content":[{"type":"text","text":"said something"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/tree/src/a.ts","old_string":"a","new_string":"b"}}]}}'
  const done = '{"type":"user","timestamp":"2026-11-05T00:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}'

  it('the held-tree journal, the context, the model and the last steps come from the transcript of the session', () => {
    aTranscript(edit, done)
    const reading = transcriptReading()

    expect(reading.contextTokens).toBe(543)
    expect(reading.model).toBe('claude-opus-5-5')
    expect(reading.journal).toMatchObject({ end: Date.parse('2026-11-05T00:00:01.000Z') })
    expect(reading.journal === 'unreadable' ? null : [...reading.journal.changes.keys()]).toEqual(['src/a.ts'])
    expect(reading.lastSteps).toEqual(['said something', 'Edit /tree/src/a.ts'])
    expect(clientLastSteps(process.env, TREE, SESSION)).toEqual(['said something', 'Edit /tree/src/a.ts'])
  })

  it('the last steps of a session with no transcript read null', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', aRoot())
    expect(clientLastSteps(process.env, TREE, SESSION)).toBeNull()
  })

  it('whether a transcript exists is answered without reading it', () => {
    const home = aRoot()
    vi.stubEnv('CLAUDE_CONFIG_DIR', home)
    expect(hasClientTranscript(process.env, TREE, SESSION)).toBe(false)
    mkdirSync(transcriptFile(home, TREE, SESSION)!, { recursive: true })
    expect(hasClientTranscript(process.env, TREE, SESSION)).toBe(true)
    expect(hasClientTranscript(process.env, TREE, 'not/plain')).toBe(false)
  })

  it('a transcript that does not parse reads an unreadable journal', () => {
    aTranscript('not json')
    expect(transcriptReading().journal).toBe('unreadable')
  })
})
