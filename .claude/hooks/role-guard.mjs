import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { appendRoleLine, definitionsDigest, snapshotPath } from './role-definitions.mjs'

const REFUSAL = 'role definitions changed since this session started (.claude/agents); start a new session'
const GUARDED_TOOL = 'Agent'
const SOURCES_THAT_KEEP_THE_SNAPSHOT = ['clear', 'compact']
const PLAIN_ID = /^[\w-]{1,128}$/
const PLAIN_REASON = /^[\w.:-]{1,64}$/

class Refusal extends Error {}

function reasonOf(error, fallback) {
  const code = error?.code
  return typeof code === 'string' && PLAIN_REASON.test(code) ? code : fallback
}

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parsedInput(text) {
  try {
    const input = JSON.parse(text)
    return input != null && typeof input === 'object' && !Array.isArray(input) ? input : null
  }
  catch {
    return null
  }
}

function sessionOf(input) {
  return typeof input.session_id === 'string' && PLAIN_ID.test(input.session_id) ? input.session_id : null
}

function projectRoot() {
  const root = process.env.CLAUDE_PROJECT_DIR
  return root != null && root !== '' && existsSync(root) && statSync(root).isDirectory() ? root : null
}

function takeSnapshot(root, input) {
  const session = sessionOf(input)
  if (session == null) {
    appendRoleLine(root, { kind: 'unread', hook: 'role-snapshot', reason: 'no-session' })
    return
  }
  const file = snapshotPath(root, session)
  if (SOURCES_THAT_KEEP_THE_SNAPSHOT.includes(input.source) && existsSync(file))
    return
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${definitionsDigest(root)}\n`)
  renameSync(temporary, file)
}

function snapshotOf(root, session) {
  try {
    return readFileSync(snapshotPath(root, session), 'utf8').trim()
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return null
    throw error
  }
}

function recordNoSnapshot(root, session) {
  try {
    appendRoleLine(root, { kind: 'no-snapshot', session })
  }
  catch (error) {
    process.stderr.write(`role-guard: no snapshot for session ${session}, and the line recording it was not written (${reasonOf(error, 'write-error')})\n`)
  }
}

function guard(root, input) {
  if (input.tool_name !== GUARDED_TOOL)
    return
  const session = sessionOf(input)
  if (session == null)
    throw new Refusal('role-guard: the hook input names no session; start a new session')
  const snapshot = snapshotOf(root, session)
  if (snapshot == null) {
    recordNoSnapshot(root, session)
    return
  }
  if (definitionsDigest(root) !== snapshot)
    throw new Refusal(REFUSAL)
}

async function snapshotMain() {
  const root = projectRoot()
  if (root == null)
    return
  try {
    const input = parsedInput(await readInput())
    if (input == null)
      appendRoleLine(root, { kind: 'unread', hook: 'role-snapshot', reason: 'not-an-object' })
    else
      takeSnapshot(root, input)
  }
  catch (error) {
    try {
      appendRoleLine(root, { kind: 'unread', hook: 'role-snapshot', reason: reasonOf(error, 'snapshot-error') })
    }
    catch {
      process.stderr.write(`role-guard: the snapshot was not taken (${reasonOf(error, 'snapshot-error')})\n`)
    }
  }
}

async function guardMain() {
  try {
    const root = projectRoot()
    if (root == null)
      throw new Refusal('role-guard: CLAUDE_PROJECT_DIR is not a directory, so the role definitions cannot be compared; start a new session')
    const input = parsedInput(await readInput())
    if (input == null)
      throw new Refusal('role-guard: the hook input is not a JSON object; start a new session')
    guard(root, input)
  }
  catch (error) {
    process.stderr.write(error instanceof Refusal ? `${error.message}\n` : `role-guard: the role definitions could not be compared (${reasonOf(error, 'read-error')}); start a new session\n`)
    process.exitCode = 2
  }
}

const MODES = { snapshot: snapshotMain, guard: guardMain }

if (Object.hasOwn(MODES, process.argv[2]))
  void MODES[process.argv[2]]()
