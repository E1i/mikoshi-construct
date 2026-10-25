import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const RELAYED_SCRIPTS = ['pre-compact']
const RELAY_TIMEOUT_MS = 25_000

export function relayArgv(root, script) {
  return ['--import', 'tsx', path.join(root, 'scripts', 'window', `${script}.ts`)]
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const script = process.argv[2]
  const root = process.env.CLAUDE_PROJECT_DIR
  if (!RELAYED_SCRIPTS.includes(script) || root === undefined) {
    process.stderr.write(`miko-relay hook: ${script ?? 'no script'} is not one of ${RELAYED_SCRIPTS.join(', ')} or CLAUDE_PROJECT_DIR is unset; nothing run\n`)
    return
  }
  let input
  try {
    input = await readStdin()
  }
  catch (error) {
    process.stderr.write(`miko-relay hook: stdin unread: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }
  const run = spawnSync(process.execPath, relayArgv(root, script), { cwd: root, input, encoding: 'utf8', timeout: RELAY_TIMEOUT_MS })
  if (run.error !== undefined) {
    process.stderr.write(`miko-relay hook: ${script}: ${run.error.message}\n`)
    return
  }
  process.stdout.write(run.stdout ?? '')
  process.stderr.write(run.stderr ?? '')
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
