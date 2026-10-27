import { Buffer } from 'node:buffer'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const AGENTS_FILE = '.construct/window-agents.jsonl'
const EVENTS = { SubagentStart: 'start', SubagentStop: 'stop' }

export function agentLineOf(text, at) {
  let input
  try {
    input = JSON.parse(text)
  }
  catch {
    return null
  }
  const event = EVENTS[input?.hook_event_name]
  const id = input?.agent_id
  if (event === undefined || typeof id !== 'string' || id === '')
    return null
  return { event, id, type: typeof input.agent_type === 'string' ? input.agent_type : null, session: typeof input.session_id === 'string' ? input.session_id : null, at }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const root = process.env.CLAUDE_PROJECT_DIR
  if (root === undefined)
    return
  try {
    const line = agentLineOf(await readStdin(), new Date().toISOString())
    if (line === null)
      return
    const file = path.join(root, AGENTS_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  }
  catch (error) {
    process.stderr.write(`window-agents: ${error instanceof Error ? error.message : String(error)}\n`)
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
