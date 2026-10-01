import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CORE_FILE = 'architecture/window-core.md'
const MISSING_WARNING = 'WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.'

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

function main() {
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
  emit({ context: { additionalContext: text }, top: {} })
}

main()
