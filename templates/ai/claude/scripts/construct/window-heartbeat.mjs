import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { addTokens, agentTranscriptsUnder, contextOf, readTranscript, spentOf, sumTranscripts } from './eddies-measure.mjs'
import { busFileOf, heartbeatLine, parsed, readStdin, tabWindow } from './window-hooks.mjs'

const NO_TRANSCRIPT = 'no-transcript'
const GAUGES_UNREAD = 'unread'

export function windowGauges(root, transcript) {
  if (typeof transcript !== 'string' || !path.isAbsolute(transcript) || !existsSync(transcript))
    return { reason: NO_TRANSCRIPT }
  try {
    const parent = readTranscript(root, transcript)
    const others = sumTranscripts(root, agentTranscriptsUnder(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')))
    return { context: contextOf(parent.last), spent: spentOf(addTokens({ ...parent.tokens }, others)) }
  }
  catch (error) {
    return { reason: GAUGES_UNREAD, error: error instanceof Error ? error.message : String(error) }
  }
}

export function windowHeartbeat(input, env, home, now, root) {
  if (!tabWindow(env))
    return null
  return heartbeatLine(busFileOf(env, home, root), input.session_id, root, now, () => windowGauges(root, input.transcript_path))
}

async function main() {
  const input = parsed(await readStdin())
  const line = windowHeartbeat(input, process.env, os.homedir(), Date.now(), process.env.CLAUDE_PROJECT_DIR || process.cwd())
  if (line != null)
    process.stderr.write(`${line}\n`)
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
      process.stderr.write(`window-heartbeat: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })()
}
