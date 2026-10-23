import { Buffer } from 'node:buffer'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HANDOFF_NAME = 'miko.md'
const HEADLESS_ENTRYPOINT = 'sdk-cli'
const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/
const COMPACT_SOURCE = 'compact'
const FRESH_MS = 2 * 60 * 1000

export function tabWindow(env) {
  return !env.CONSTRUCT_CARD && env.CLAUDE_CODE_ENTRYPOINT !== HEADLESS_ENTRYPOINT && env.CONSTRUCT_BUS_RAISED !== '1'
}

export function handoffOf(env, home) {
  return env.CONSTRUCT_HANDOFF || path.join(env.CONSTRUCT_HANDOFF_DIR || path.join(home, '.construct', 'handoff'), HANDOFF_NAME)
}

export function statusOf(text) {
  return text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? []).at(-1) ?? null
}

function parsed(text) {
  try {
    const input = JSON.parse(text)
    return input !== null && typeof input === 'object' ? input : {}
  }
  catch {
    return {}
  }
}

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
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

export function sessionStartOutput(input, handoff, text) {
  if (input.source !== COMPACT_SOURCE || text === null)
    return null
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `read ${handoff}; if its last STATUS: line is CONTINUE, continue with its next task without asking the owner; if it is OWNER, ask the owner in this window and wait for the answer in this session`,
    },
  }
}

export function preCompactLine(handoff, mtime, now) {
  if (mtime === null)
    return `window-hooks: no handoff at ${handoff}; the compacted session has nothing to continue from`
  return now - mtime <= FRESH_MS ? null : `window-hooks: ${handoff} is older than ${FRESH_MS / 1000}s; write the handoff before the next compaction`
}

export function windowHookOutput(event, input, env, home, now) {
  if (!tabWindow(env))
    return {}
  const handoff = handoffOf(env, home)
  if (event === 'stop')
    return { stdout: stopOutput(input, handoff, readOrNull(handoff)) }
  if (event === 'session-start')
    return { stdout: sessionStartOutput(input, handoff, readOrNull(handoff)) }
  if (event === 'pre-compact')
    return { stderr: preCompactLine(handoff, mtimeOrNull(handoff), now) }
  return { stderr: `window-hooks: ${event ?? 'no event'} is not one of stop, session-start, pre-compact; nothing run` }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const output = windowHookOutput(process.argv[2], parsed(await readStdin()), process.env, os.homedir(), Date.now())
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
