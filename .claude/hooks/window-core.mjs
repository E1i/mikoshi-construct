import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CORE_FILE = 'architecture/window-core.md'
const MISSING_WARNING = 'WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.'
const COMPACT_SOURCE = 'compact'
const COMPACT_START_TIMEOUT_MS = 4_000

function emit(output) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', ...output.context }, ...output.top })}\n`)
}

function refuse(message) {
  const reading = `window-core: ${message}`
  process.stderr.write(`${reading}\n`)
  emit({
    context: { additionalContext: `${MISSING_WARNING}\n\n${reading}. Tell the owner, and take no action until a session starts with ${CORE_FILE} delivered.\n` },
    top: { systemMessage: `${MISSING_WARNING} ${reading}` },
  })
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function sourceOf(input) {
  try {
    return JSON.parse(input)?.source
  }
  catch {
    return undefined
  }
}

function compactContext(root, input) {
  if (sourceOf(input) !== COMPACT_SOURCE)
    return ''
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'window', 'compact-start.ts')], { cwd: root, input, encoding: 'utf8', timeout: COMPACT_START_TIMEOUT_MS })
  if (run.error !== undefined || run.status !== 0) {
    process.stderr.write(`window-core: compact-start gave no continue prompt (${run.error?.message ?? `exit ${run.status ?? run.signal}`})\n`)
    return ''
  }
  const prompt = (run.stdout ?? '').trim()
  return prompt === '' ? '' : `\n\n${prompt}\n`
}

async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR
  if (root == null || root === '') {
    refuse(`CLAUDE_PROJECT_DIR is not set, so ${CORE_FILE} cannot be read; the coordinating window starts without its laws`)
    return
  }
  const file = path.join(root, CORE_FILE)
  let text
  try {
    text = readFileSync(file, 'utf8')
  }
  catch (error) {
    refuse(`${file} could not be read (${typeof error?.code === 'string' ? error.code : 'read-error'}); the coordinating window starts without its laws`)
    return
  }
  let input = ''
  try {
    input = await readStdin()
  }
  catch (error) {
    process.stderr.write(`window-core: stdin unread: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  emit({ context: { additionalContext: `${text}${compactContext(root, input)}` }, top: {} })
}

void main()
