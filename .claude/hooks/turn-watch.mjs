import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SESSION_ID = /^[\w-]{1,128}$/
const REFUSED = 1
const TURN_WATCH_TIMEOUT_MS = 10_000
const TURN_WATCH_LINE = 'turn-watch:'

const HEADLESS_ENTRYPOINT = 'sdk-cli'

function underTheLoop(env) {
  return env.MIKO_WINDOW === '1' || Boolean(env.MIKO_LOOP_PID) || Boolean(env.MIKO_EXIT_REQUEST)
}

function tabCandidate(env) {
  return env.CLAUDE_CODE_ENTRYPOINT !== HEADLESS_ENTRYPOINT && env.CONSTRUCT_BUS_RAISED !== '1'
}

export function windowMarked(env) {
  return !env.CONSTRUCT_CARD && (underTheLoop(env) || tabCandidate(env))
}

export function stopInputOf(text) {
  try {
    const input = JSON.parse(text)
    const id = input?.session_id
    return { session: typeof id === 'string' && SESSION_ID.test(id) ? id : null, again: input?.stop_hook_active === true }
  }
  catch {
    return { session: null, again: false }
  }
}

export function turnWatchArgv(root) {
  return ['--import', 'tsx', path.join(root, 'scripts', 'window', 'turn-watch.ts')]
}

export function stopDecision(status, stderr) {
  if (status !== REFUSED)
    return null
  const reason = stderr.split('\n').map(line => line.trim()).filter(line => line.includes(TURN_WATCH_LINE)).at(-1)
  return reason === undefined ? null : { decision: 'block', reason }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR
  let text
  try {
    text = await readStdin()
  }
  catch (error) {
    process.stderr.write(`turn-watch hook: stdin unread: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }
  const { session, again } = stopInputOf(text)
  if (root === undefined || session === null || again || !windowMarked(process.env))
    return
  const run = spawnSync(process.execPath, turnWatchArgv(root), { cwd: root, encoding: 'utf8', timeout: TURN_WATCH_TIMEOUT_MS, env: { ...process.env, CLAUDE_CODE_SESSION_ID: session } })
  if (run.error !== undefined) {
    process.stderr.write(`turn-watch hook: ${run.error.message}\n`)
    return
  }
  const decision = stopDecision(run.status, run.stderr ?? '')
  if (decision !== null)
    process.stdout.write(`${JSON.stringify(decision)}\n`)
  else if (run.status !== 0)
    process.stderr.write(`turn-watch hook: turn-watch exited ${run.status ?? run.signal} without a turn-watch line; the turn ends\n`)
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
