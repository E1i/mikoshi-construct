import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const CARD_VARIABLE = 'CONSTRUCT_CARD'
const SESSION_ID = /^[\w-]{1,128}$/

export function heartbeatArgv(root, session) {
  return ['--import', 'tsx', path.join(root, 'scripts', 'bus', 'heartbeat.ts'), session]
}

export function sessionOf(text) {
  try {
    const id = JSON.parse(text)?.session_id
    return typeof id === 'string' && SESSION_ID.test(id) ? id : null
  }
  catch {
    return null
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR
  if (process.env[CARD_VARIABLE] === undefined || root === undefined)
    return
  let text
  try {
    text = await readStdin()
  }
  catch (error) {
    process.stderr.write(`heartbeat: stdin unread: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }
  const session = sessionOf(text)
  if (session === null)
    return
  try {
    const child = spawn(process.execPath, heartbeatArgv(root, session), { cwd: root, detached: true, stdio: 'ignore', env: process.env })
    child.on('error', error => process.stderr.write(`heartbeat: ${error.message}\n`))
    child.unref()
  }
  catch (error) {
    process.stderr.write(`heartbeat: ${error instanceof Error ? error.message : String(error)}\n`)
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
