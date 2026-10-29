import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CONSTRUCT_HOME_DIR = '.construct'
const HANDOFF_DIR = 'handoff'
const HANDOFF_NAME = 'miko.md'
const RULES_FILE = '.construct/window-rules.md'
const GIT_ENTRY = '.git'
const GITDIR_POINTER = /^gitdir:(.+)$/m
const REMOTE_SECTION = /^\s*\[remote\s+"([^"]+)"\]\s*$/
const ANY_SECTION = /^\s*\[/
const URL_LINE = /^\s*url\s*=(.+)$/
const SLUG_TAIL = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/
const UNSAFE_ID_CHARACTER = /[^\w.-]/g
const PREFERRED_REMOTE = 'origin'
const REPO_ID_SEPARATOR = '--'
const LOCAL_REPO_PREFIX = 'local'
const LOCAL_HASH_LENGTH = 12
const HEADLESS_ENTRYPOINT = 'sdk-cli'
const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/
const COMPACT_SOURCE = 'compact'
const FRESH_MS = 2 * 60 * 1000
const NEEDS_CONSTRUCT = '--needs-construct'
const CONSTRUCT_BIN = 'construct'
const HANDOFF_WRITE_REASON = 'write the handoff with miko handoff write <name> <draft>'
const BUS_DB_VARIABLE = 'CONSTRUCT_BUS_DB'
const BUS_FILE = 'bus.db'
const BOARD_FILE = 'board.html'
const BOARD_EVERY_MINUTES = 5
const WINDOW_HEARTBEAT = 'window.heartbeat'
const WINDOW_ACTOR = 'worker:window:'
const WINDOW_MODE = 'tab'
export const WINDOW_BEAT_MS = 5 * 60 * 1000
const BUS_BUSY_MS = 1000
const BEAT_SESSION = /^[^:\s]{1,128}$/
const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature'
const EVENTS_TABLE = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`
const LAST_SESSION_BEAT = `SELECT max(ts) AS ts FROM events WHERE type = ? AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.session') = ?`
const INSERT_BEAT = 'INSERT OR IGNORE INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 0)'

function executable(file) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

export function constructOnPath(env) {
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean).some(dir => executable(path.join(dir, CONSTRUCT_BIN)))
}

export function missingConstructLine(event, requirement, env) {
  if (requirement !== NEEDS_CONSTRUCT || constructOnPath(env))
    return null
  return `window-hooks: ${CONSTRUCT_BIN} is not on PATH; the ${event ?? 'no event'} hook did nothing`
}

export function tabWindow(env) {
  return !env.CONSTRUCT_CARD && env.CLAUDE_CODE_ENTRYPOINT !== HEADLESS_ENTRYPOINT && env.CONSTRUCT_BUS_RAISED !== '1'
}

function readIfFile(file) {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null
  }
  catch {
    return null
  }
}

function repositoryRoot(dir) {
  let current = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(current, GIT_ENTRY)))
      return current
    const parent = path.dirname(current)
    if (parent === current)
      return null
    current = parent
  }
}

function commonGitDir(root) {
  const entry = path.join(root, GIT_ENTRY)
  const pointer = readIfFile(entry)?.match(GITDIR_POINTER)?.[1]?.trim()
  const gitDir = pointer === undefined ? entry : path.resolve(root, pointer)
  const common = readIfFile(path.join(gitDir, 'commondir'))?.trim()
  return common === undefined || common === '' ? gitDir : path.resolve(gitDir, common)
}

function remoteUrl(config) {
  const urls = new Map()
  let remote = null
  for (const line of config.split('\n')) {
    const section = line.match(REMOTE_SECTION)
    if (section !== null) {
      remote = section[1]
      continue
    }
    if (ANY_SECTION.test(line)) {
      remote = null
      continue
    }
    const url = line.match(URL_LINE)?.[1]?.trim()
    if (remote !== null && url !== undefined && !urls.has(remote))
      urls.set(remote, url)
  }
  return urls.get(PREFERRED_REMOTE) ?? urls.values().next().value ?? null
}

function safeSegment(text) {
  return text.replace(UNSAFE_ID_CHARACTER, '_')
}

export function repoIdOf(dir) {
  const root = repositoryRoot(dir)
  const config = root === null ? null : readIfFile(path.join(commonGitDir(root), 'config'))
  const url = config === null ? null : remoteUrl(config)
  const slug = url === null ? null : url.match(SLUG_TAIL)
  if (slug != null)
    return [slug[1], slug[2]].map(safeSegment).join(REPO_ID_SEPARATOR)
  const place = root ?? path.resolve(dir)
  const hash = createHash('sha256').update(place).digest('hex').slice(0, LOCAL_HASH_LENGTH)
  return [LOCAL_REPO_PREFIX, `${safeSegment(path.basename(place))}-${hash}`].join(REPO_ID_SEPARATOR)
}

export function handoffDirOf(env, home, dir) {
  return env.CONSTRUCT_HANDOFF_DIR || path.join(home, CONSTRUCT_HOME_DIR, repoIdOf(dir), HANDOFF_DIR)
}

export function handoffOf(env, home, dir) {
  return env.CONSTRUCT_HANDOFF || path.join(handoffDirOf(env, home, dir), HANDOFF_NAME)
}

function realWithTail(target) {
  const tail = []
  let head = path.resolve(target)
  while (!existsSync(head) && path.dirname(head) !== head) {
    tail.unshift(path.basename(head))
    head = path.dirname(head)
  }
  try {
    return path.join(realpathSync(head), ...tail)
  }
  catch {
    return path.join(head, ...tail)
  }
}

export function statusOf(text) {
  return text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? []).at(-1) ?? null
}

export function parsed(text) {
  try {
    const input = JSON.parse(text)
    return input !== null && typeof input === 'object' ? input : {}
  }
  catch {
    return {}
  }
}

function mtimeOrNull(file) {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return null
  }
}

export function stopOutput(input, handoff, text) {
  if (input.stop_hook_active === true || text === null || statusOf(text) !== 'CONTINUE')
    return null
  return { decision: 'block', reason: `window-hooks: ${handoff} ends STATUS: CONTINUE; take its next task in this session` }
}

export function boardLine(busFile) {
  if (!existsSync(busFile))
    return null
  return `the board: construct board --every ${BOARD_EVERY_MINUTES} in a terminal, or open ${path.join(path.dirname(busFile), BOARD_FILE)}, the page the factory rewrites on every tick; name both to the owner in your first line`
}

export function sessionStartOutput(input, handoff, text, rules, board = null) {
  const handoffLine = input.source === COMPACT_SOURCE && text !== null
    ? `read ${handoff}; if its last STATUS: line is CONTINUE, continue with its next task without asking the owner; if it is OWNER, ask the owner in this window and wait for the answer in this session`
    : null
  const parts = [rules, board, handoffLine].filter(part => part != null)
  if (parts.length === 0)
    return null
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') } }
}

export function preCompactLine(handoff, mtime, now) {
  if (mtime === null)
    return `window-hooks: no handoff at ${handoff}; the compacted session has nothing to continue from`
  return now - mtime <= FRESH_MS ? null : `window-hooks: ${handoff} is older than ${FRESH_MS / 1000}s; write the handoff before the next compaction`
}

export function preCompactOutput(line) {
  return line === null ? null : { systemMessage: line }
}

export function handoffWriteOutput(input, handoffDir, dir) {
  const target = input.tool_input?.file_path
  if (typeof target !== 'string' || target === '')
    return null
  const relative = path.relative(realWithTail(handoffDir), realWithTail(path.resolve(dir, target)))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HANDOFF_WRITE_REASON } }
}

export function busFileOf(env, home, dir) {
  return env[BUS_DB_VARIABLE] || path.join(home, CONSTRUCT_HOME_DIR, repoIdOf(dir), BUS_FILE)
}

function loadSqlite() {
  const emitWarning = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning?.message ?? warning).startsWith(SQLITE_EXPERIMENTAL_WARNING))
      Reflect.apply(emitWarning, process, [warning, ...rest])
  }
  try {
    return process.getBuiltinModule?.('node:sqlite') ?? null
  }
  catch {
    return null
  }
  finally {
    process.emitWarning = emitWarning
  }
}

export function beatDue(lastTs, now) {
  return lastTs == null || now - Date.parse(lastTs) >= WINDOW_BEAT_MS
}

export function writeWindowBeat(busFile, session, root, now, gauges = () => ({})) {
  if (typeof session !== 'string' || !BEAT_SESSION.test(session) || !existsSync(busFile))
    return false
  const sqlite = loadSqlite()
  if (sqlite == null)
    return false
  const db = new sqlite.DatabaseSync(busFile, { timeout: BUS_BUSY_MS })
  try {
    if (db.prepare(EVENTS_TABLE).get() === undefined)
      return false
    if (!beatDue(db.prepare(LAST_SESSION_BEAT).get(WINDOW_HEARTBEAT, session)?.ts ?? null, now))
      return false
    const ts = new Date(now).toISOString()
    const payload = JSON.stringify({ session, mode: WINDOW_MODE, root, ...gauges() })
    db.prepare(INSERT_BEAT).run(ts, WINDOW_HEARTBEAT, `${WINDOW_ACTOR}${session}`, `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload)
    return true
  }
  finally {
    db.close()
  }
}

export function heartbeatLine(busFile, session, root, now, gauges) {
  try {
    writeWindowBeat(busFile, session, root, now, gauges)
    return null
  }
  catch (error) {
    return `window-hooks: no window.heartbeat written to ${busFile}: ${error instanceof Error ? error.message : String(error)}`
  }
}

export function windowHookOutput(event, input, env, home, now, dir) {
  if (!tabWindow(env))
    return {}
  const handoff = handoffOf(env, home, dir)
  if (event === 'stop')
    return { stdout: stopOutput(input, handoff, readIfFile(handoff)) }
  if (event === 'session-start')
    return { stdout: sessionStartOutput(input, handoff, readIfFile(handoff), readIfFile(path.join(dir, RULES_FILE)), boardLine(busFileOf(env, home, dir))) }
  if (event === 'pre-compact')
    return { stdout: preCompactOutput(preCompactLine(handoff, mtimeOrNull(handoff), now)) }
  if (event === 'pre-tool-use')
    return { stdout: handoffWriteOutput(input, handoffDirOf(env, home, dir), dir) }
  if (event === 'heartbeat')
    return { stderr: heartbeatLine(busFileOf(env, home, dir), input.session_id, dir, now) }
  return { stderr: `window-hooks: ${event ?? 'no event'} is not one of stop, session-start, pre-compact, pre-tool-use, heartbeat; nothing run` }
}

export async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const [event, requirement] = process.argv.slice(2)
  const input = parsed(await readStdin())
  const missing = missingConstructLine(event, requirement, process.env)
  if (missing !== null) {
    process.stderr.write(`${missing}\n`)
    return
  }
  const output = windowHookOutput(event, input, process.env, os.homedir(), Date.now(), process.env.CLAUDE_PROJECT_DIR || process.cwd())
  if (output.stdout != null)
    process.stdout.write(`${JSON.stringify(output.stdout)}\n`)
  if (output.stderr != null)
    process.stderr.write(`${output.stderr}\n`)
}

function isMain() {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  }
  catch {
    return false
  }
}

if (isMain()) {
  void (async () => {
    try {
      await main()
    }
    catch (error) {
      process.stderr.write(`window-hooks: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })()
}
