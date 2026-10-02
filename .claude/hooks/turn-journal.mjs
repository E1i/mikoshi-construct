import { Buffer } from 'node:buffer'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { contextOf } from './eddies-measure.mjs'
import { appendRoleLine, expectedModel, familyOf, modelMismatches } from './role-definitions.mjs'

export const TURN_JOURNAL_FILE = '.construct/turns.jsonl'

const JOURNAL_VERSION = 1
const STATE_DIR = '.construct/turns.d'
const LOCK_DIR = '.construct/turns.lock'
const LOCK_WAIT_MS = 1000
const LOCK_RETRY_MS = 20
const LOCK_STALE_MS = 10_000
const CHUNK = 65_536
const PLAIN_ID = /^[\w-]{1,128}$/
const PLAIN_NAME = /^[\w.:-]{0,128}$/

function plainId(value) {
  return typeof value === 'string' && PLAIN_ID.test(value) ? value : null
}

function plainName(value) {
  if (typeof value !== 'string')
    return ''
  return PLAIN_NAME.test(value) ? value : 'other'
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function bump(counts, name) {
  const next = Object.hasOwn(counts, name) ? counts[name] + 1 : 1
  Object.defineProperty(counts, name, { value: next, enumerable: true, writable: true, configurable: true })
}

function emptyUsage() {
  return { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: [] }
}

function parsed(line) {
  try {
    return { entry: JSON.parse(line) }
  }
  catch {
    return null
  }
}

function countUsage(usage, entry, message, counted, seen) {
  const request = typeof entry.requestId === 'string' ? entry.requestId : null
  if (request != null) {
    seen.add(request)
    if (counted.has(request))
      return
    counted.add(request)
  }
  usage.calls += 1
  usage.input += count(message.usage.input_tokens)
  usage.cacheWrite += count(message.usage.cache_creation_input_tokens)
  usage.cacheRead += count(message.usage.cache_read_input_tokens)
  usage.output += count(message.usage.output_tokens)
  if (typeof message.model === 'string') {
    const model = plainName(message.model)
    if (!usage.models.includes(model))
      usage.models.push(model)
  }
}

export function measure(text, alreadyCounted = []) {
  const usage = emptyUsage()
  const toolCalls = {}
  const counted = new Set(alreadyCounted)
  const seen = new Set()
  let unreadable = 0
  let context = null
  for (const line of text.split('\n')) {
    if (line.trim() === '')
      continue
    const reading = parsed(line)
    if (reading == null || reading.entry == null || typeof reading.entry !== 'object') {
      if (reading == null)
        unreadable += 1
      continue
    }
    const message = reading.entry.message
    if (message == null || typeof message !== 'object' || message.role !== 'assistant')
      continue
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block != null && block.type === 'tool_use')
          bump(toolCalls, plainName(block.name) || 'other')
      }
    }
    if (message.usage != null && typeof message.usage === 'object') {
      countUsage(usage, reading.entry, message, counted, seen)
      context = contextOf({ input: count(message.usage.input_tokens), cacheWrite: count(message.usage.cache_creation_input_tokens), cacheRead: count(message.usage.cache_read_input_tokens) })
    }
  }
  return { usage, toolCalls, unreadable, context, requestIds: [...seen].filter(id => PLAIN_ID.test(id)) }
}

function boundaryOf(file) {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.alloc(CHUNK)
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const read = readSync(fd, chunk, 0, end - start, start)
      const at = chunk.subarray(0, read).lastIndexOf(10)
      if (at >= 0)
        return start + at + 1
      end = start
    }
    return 0
  }
  finally {
    closeSync(fd)
  }
}

function readRange(file, from, to) {
  const length = to - from
  if (length <= 0)
    return ''
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, from)
    return buffer.subarray(0, read).toString('utf8')
  }
  finally {
    closeSync(fd)
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isStale(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
  }
  catch {
    return false
  }
}

function breakStale(lock) {
  if (!isStale(lock))
    return
  const aside = `${lock}.${process.pid}.${Date.now()}`
  try {
    renameSync(lock, aside)
  }
  catch {
    return
  }
  if (isStale(aside)) {
    rmSync(aside, { recursive: true, force: true })
    return
  }
  try {
    renameSync(aside, lock)
  }
  catch {
    rmSync(aside, { recursive: true, force: true })
  }
}

function acquire(root) {
  const lock = path.join(root, LOCK_DIR)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      return lock
    }
    catch (error) {
      if (error.code !== 'EEXIST')
        throw error
    }
    breakStale(lock)
    if (Date.now() >= deadline)
      return null
    sleep(LOCK_RETRY_MS)
  }
}

function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (state != null && typeof state === 'object')
      return { transcript: null, cursor: null, open: null, lastPrompt: null, counted: [], agents: {}, ...state }
  }
  catch {}
  return { transcript: null, cursor: null, open: null, lastPrompt: null, counted: [], agents: {} }
}

function saveState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, file)
}

function cursorStatus(state, transcript) {
  if (state.cursor == null)
    return 'fresh'
  if (state.transcript !== transcript)
    return 'moved'
  return statSync(transcript).size < state.cursor ? 'shrunk' : 'ok'
}

function resetCursor(state, transcript) {
  state.transcript = transcript
  state.cursor = boundaryOf(transcript)
  state.counted = []
}

function measureRange(state, transcript, to) {
  const reading = measure(readRange(transcript, state.cursor, to), state.counted)
  if (reading.requestIds.length > 0)
    state.counted = reading.requestIds
  state.cursor = to
  return reading
}

function reading(range) {
  return { usage: range.usage, toolCalls: range.toolCalls, unreadable: range.unreadable, context: range.context }
}

function flushLate(session, state, transcript, out, at) {
  if (cursorStatus(state, transcript) !== 'ok') {
    resetCursor(state, transcript)
    return
  }
  const to = boundaryOf(transcript)
  const from = state.cursor
  if (to <= from)
    return
  const range = measureRange(state, transcript, to)
  out.push({ v: JOURNAL_VERSION, kind: 'late', session, prompt: state.lastPrompt, at, from, to, ...reading(range) })
}

function closeTurn(session, state, transcript, out, end, endedAt) {
  const open = state.open
  state.open = null
  state.lastPrompt = open.prompt
  const head = { v: JOURNAL_VERSION, kind: 'turn', session, prompt: open.prompt, startedAt: open.startedAt, endedAt, end }
  const status = cursorStatus(state, transcript)
  if (status !== 'ok') {
    resetCursor(state, transcript)
    out.push({ ...head, from: null, to: state.cursor, usage: 'unknown', reset: status })
    return
  }
  const from = state.cursor
  const to = boundaryOf(transcript)
  out.push({ ...head, from, to, ...reading(measureRange(state, transcript, to)) })
}

function transcriptOf(input, state) {
  if (typeof input.transcript_path === 'string' && input.transcript_path !== '')
    return input.transcript_path
  return state.transcript
}

function onPrompt(session, input, state, out, at) {
  readLateTails(session, state, out, at)
  const transcript = transcriptOf(input, state)
  if (transcript == null)
    return
  if (state.open != null)
    closeTurn(session, state, transcript, out, 'superseded', at)
  else
    flushLate(session, state, transcript, out, at)
  state.open = { prompt: plainId(input.prompt_id), startedAt: at, from: state.cursor }
}

function onStop(session, input, state, out, at) {
  readLateTails(session, state, out, at)
  const transcript = transcriptOf(input, state)
  if (transcript == null)
    return
  if (state.open != null)
    closeTurn(session, state, transcript, out, 'stop', at)
  else
    flushLate(session, state, transcript, out, at)
}

function keepAgent(state, agent, value) {
  Object.defineProperty(state.agents, agent, { value, enumerable: true, writable: true, configurable: true })
}

function tailUnread(file, to, range) {
  return range.usage.models.length === 0 || statSync(file).size > to
}

function readLateTails(session, state, out, at) {
  for (const [agent, known] of Object.entries(state.agents)) {
    if (known.tail == null)
      continue
    const { file, agentType, prompt } = known.tail
    if (statSync(file, { throwIfNoEntry: false }) == null || statSync(file).size < known.cursor) {
      keepAgent(state, agent, { cursor: known.cursor, counted: known.counted })
      continue
    }
    const to = boundaryOf(file)
    if (to <= known.cursor)
      continue
    const range = measure(readRange(file, known.cursor, to), known.counted)
    if (range.usage.calls === 0)
      continue
    keepAgent(state, agent, { cursor: to, counted: range.requestIds.length > 0 ? range.requestIds : known.counted })
    out.push({ v: JOURNAL_VERSION, kind: 'subagent', late: true, session, prompt, at, agent, agentType, from: known.cursor, to, ...reading(range) })
  }
}

function onSubagentStop(session, input, state, out, at) {
  readLateTails(session, state, out, at)
  const agent = plainId(input.agent_id)
  const file = input.agent_transcript_path
  if (agent == null || typeof file !== 'string' || file === '')
    return
  const known = Object.hasOwn(state.agents, agent) ? state.agents[agent] : { cursor: 0, counted: [] }
  const start = statSync(file).size < known.cursor ? { cursor: 0, counted: [] } : known
  const to = boundaryOf(file)
  const range = measure(readRange(file, start.cursor, to), start.counted)
  const prompt = plainId(input.prompt_id) ?? state.open?.prompt ?? state.lastPrompt
  const agentType = plainName(input.agent_type)
  const counted = range.requestIds.length > 0 ? range.requestIds : start.counted
  const tail = tailUnread(file, to, range) ? { file, agentType, prompt } : undefined
  keepAgent(state, agent, tail == null ? { cursor: to, counted } : { cursor: to, counted, tail })
  out.push({ v: JOURNAL_VERSION, kind: 'subagent', session, prompt, at, agent, agentType, from: start.cursor, to, ...reading(range) })
}

function onSessionEnd(session, input, state, out, at) {
  readLateTails(session, state, out, at)
  const transcript = transcriptOf(input, state)
  if (transcript != null) {
    if (state.open != null)
      closeTurn(session, state, transcript, out, 'session-end', at)
    else
      flushLate(session, state, transcript, out, at)
  }
  out.push({ v: JOURNAL_VERSION, kind: 'session-end', session, at, reason: plainName(input.reason) })
}

const HANDLERS = {
  UserPromptSubmit: onPrompt,
  Stop: onStop,
  SubagentStop: onSubagentStop,
  SessionEnd: onSessionEnd,
}

function checkModels(root, parentTranscript, line) {
  const { session, agent, agentType } = line
  const actual = line.usage.models
  if (actual.length === 0 && line.late)
    return
  if (actual.length === 0) {
    appendRoleLine(root, { kind: 'unread', hook: 'model-check', reason: 'empty-actual', session, agent, agentType })
    return
  }
  try {
    const expected = expectedModel(root, agentType, parentTranscript)
    if (familyOf(expected) == null) {
      appendRoleLine(root, { kind: 'unread', hook: 'model-check', reason: 'expected-model-unknown', session, agent, agentType })
      return
    }
    for (const mismatch of modelMismatches({ session, agent, agentType, expected, actual }))
      appendRoleLine(root, mismatch)
  }
  catch (error) {
    appendRoleLine(root, { kind: 'unread', hook: 'model-check', reason: plainName(error?.code) || 'check-error', session, agent, agentType })
  }
}

function held(root, session, input) {
  const handler = Object.hasOwn(HANDLERS, input.hook_event_name) ? HANDLERS[input.hook_event_name] : null
  if (handler == null)
    return
  mkdirSync(path.join(root, STATE_DIR), { recursive: true })
  const stateFile = path.join(root, STATE_DIR, `${session}.json`)
  const state = loadState(stateFile)
  const out = []
  handler(session, input, state, out, new Date().toISOString())
  if (input.hook_event_name === 'SessionEnd')
    rmSync(stateFile, { force: true })
  else
    saveState(stateFile, state)
  if (out.length > 0)
    appendFileSync(path.join(root, TURN_JOURNAL_FILE), out.map(line => `${JSON.stringify(line)}\n`).join(''))
  for (const line of out.filter(entry => entry.kind === 'subagent'))
    checkModels(root, line.late ? state.transcript ?? input.transcript_path : input.transcript_path, line)
}

export function record(root, input) {
  if (input == null || typeof input !== 'object')
    return
  const session = plainId(input.session_id)
  if (session == null)
    return
  const dir = path.join(root, '.construct')
  mkdirSync(dir, { recursive: true })
  const lock = acquire(root)
  if (lock == null)
    return
  try {
    held(root, session, input)
  }
  finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function recordUnread(root, reason) {
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  const lock = acquire(root)
  if (lock == null)
    return
  try {
    const line = { v: JOURNAL_VERSION, kind: 'unread', at: new Date().toISOString(), reason: plainName(reason) ?? 'unnamed' }
    appendFileSync(path.join(root, TURN_JOURNAL_FILE), `${JSON.stringify(line)}\n`)
  }
  finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function parsedInput(text) {
  if (text.trim() === '')
    return { unread: 'empty' }
  try {
    const input = JSON.parse(text)
    return input != null && typeof input === 'object' && !Array.isArray(input) ? { input } : { unread: 'not-an-object' }
  }
  catch {
    return { unread: 'not-json' }
  }
}

async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR
  try {
    if (root == null || root === '' || !statSync(root).isDirectory())
      return
    let text
    try {
      text = await readInput()
    }
    catch (error) {
      recordUnread(root, typeof error?.code === 'string' ? error.code : 'read-error')
      return
    }
    const { input, unread } = parsedInput(text)
    if (unread != null)
      recordUnread(root, unread)
    else
      record(root, input)
  }
  catch (error) {
    process.stderr.write(`turn-journal: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function isMain() {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  }
  catch {
    return false
  }
}

if (isMain())
  void main()
