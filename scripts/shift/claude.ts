import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import process from 'node:process'
import { sessionEnv } from '../ghosts/session.js'

export const CLAUDE_VARIABLE = 'SHIFT_CLAUDE'

export interface ClaudeRun {
  command: string
  cwd: string
  sessionId: string
  card: number
  prompt: string
  log: string
}

export type ClaudeExit = { kind: 'exited', code: number | null, signal: string | null } | { kind: 'unspawnable', error: string }

export function claudeArgv(command: string, sessionId: string): string[] {
  return ['-c', `${command} "$@"`, 'shift', '-p', '--session-id', sessionId]
}

export async function runClaude(run: ClaudeRun): Promise<ClaudeExit> {
  const fd = openSync(run.log, 'w')
  try {
    return await new Promise((resolve) => {
      const child = spawn('sh', claudeArgv(run.command, run.sessionId), { cwd: run.cwd, env: sessionEnv(process.env, run.card), stdio: ['pipe', fd, fd] })
      child.on('error', error => resolve({ kind: 'unspawnable', error: error.message }))
      child.on('close', (code, signal) => resolve({ kind: 'exited', code, signal }))
      child.stdin?.on('error', () => {})
      child.stdin?.end(run.prompt)
    })
  }
  finally {
    closeSync(fd)
  }
}
