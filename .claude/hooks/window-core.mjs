import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CORE_FILE = 'architecture/window-core.md'

function refuse(message) {
  process.stderr.write(`window-core: ${message}\n`)
  process.exitCode = 2
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
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`)
}

main()
