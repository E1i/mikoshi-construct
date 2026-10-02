import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const CACHE_WRITE_WEIGHT = 1.25
export const CACHE_READ_WEIGHT = 0.1
export const SPEND_BASIS = 'spent = input_tokens + cache_creation_input_tokens × 1.25 + cache_read_input_tokens × 0.1, summed over the messages read, each requestId counted once (the last record wins)'
export const CONTEXT_BASIS = 'context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens of the last response in the parent transcript'

const STATE_DIR = '.construct/eddies.d'
const AGENT_TRANSCRIPT = /^agent-[\w-]+\.jsonl$/
const NEWLINE = 10

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function emptyTokens() {
  return { input: 0, cacheWrite: 0, cacheRead: 0 }
}

export function addTokens(into, tokens) {
  into.input += tokens.input
  into.cacheWrite += tokens.cacheWrite
  into.cacheRead += tokens.cacheRead
  return into
}

export function spentOf(tokens) {
  return tokens.input + tokens.cacheWrite * CACHE_WRITE_WEIGHT + tokens.cacheRead * CACHE_READ_WEIGHT
}

export function contextOf(tokens) {
  return tokens.input + tokens.cacheWrite + tokens.cacheRead
}

function responseOf(line) {
  let entry
  try {
    entry = JSON.parse(line)
  }
  catch {
    return null
  }
  const usage = entry?.message?.role === 'assistant' ? entry.message.usage : null
  if (usage == null || typeof usage !== 'object')
    return null
  return {
    request: typeof entry.requestId === 'string' ? entry.requestId : null,
    tokens: { input: count(usage.input_tokens), cacheWrite: count(usage.cache_creation_input_tokens), cacheRead: count(usage.cache_read_input_tokens) },
  }
}

function freshState() {
  return { offset: 0, lastRead: 0, requests: new Map(), anonymous: emptyTokens(), last: null }
}

function stateFileOf(root, transcript) {
  return path.join(root, STATE_DIR, `${createHash('sha256').update(transcript).digest('hex').slice(0, 32)}.json`)
}

export function hasBeenRead(root, transcript) {
  return existsSync(stateFileOf(root, transcript))
}

function loadState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return {
      offset: count(saved.offset),
      lastRead: count(saved.lastRead),
      requests: new Map(saved.requests.map(([request, input, cacheWrite, cacheRead]) => [request, { input, cacheWrite, cacheRead }])),
      anonymous: saved.anonymous,
      last: saved.last,
    }
  }
  catch {
    return freshState()
  }
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true })
  const requests = [...state.requests].map(([request, tokens]) => [request, tokens.input, tokens.cacheWrite, tokens.cacheRead])
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ offset: state.offset, lastRead: state.lastRead, requests, anonymous: state.anonymous, last: state.last }))
  renameSync(temporary, file)
}

function completeLinesFrom(file, from, size) {
  const length = size - from
  if (length <= 0)
    return { text: '', read: 0 }
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const got = readSync(fd, buffer, 0, length, from)
    const end = buffer.subarray(0, got).lastIndexOf(NEWLINE) + 1
    return { text: buffer.subarray(0, end).toString('utf8'), read: end }
  }
  finally {
    closeSync(fd)
  }
}

export function readTranscript(root, transcript) {
  const stateFile = stateFileOf(root, transcript)
  const size = statSync(transcript).size
  let state = loadState(stateFile)
  if (size < state.offset)
    state = freshState()
  const from = state.offset
  const { text, read } = completeLinesFrom(transcript, from, size)
  for (const line of text.split('\n')) {
    const response = line === '' ? null : responseOf(line)
    if (response == null)
      continue
    if (response.request == null)
      addTokens(state.anonymous, response.tokens)
    else
      state.requests.set(response.request, response.tokens)
    state.last = response.tokens
  }
  state.offset = from + read
  state.lastRead = read
  saveState(stateFile, state)
  const tokens = { ...state.anonymous }
  for (const requestTokens of state.requests.values())
    addTokens(tokens, requestTokens)
  return { tokens, last: state.last ?? emptyTokens() }
}

export function sumTranscripts(root, files) {
  const tokens = emptyTokens()
  for (const file of files)
    addTokens(tokens, readTranscript(root, file).tokens)
  return tokens
}

export function agentTranscriptsUnder(dir) {
  let names
  try {
    names = readdirSync(dir, { recursive: true })
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return []
    throw error
  }
  return names.filter(name => AGENT_TRANSCRIPT.test(path.basename(name))).sort().map(name => path.join(dir, name))
}
