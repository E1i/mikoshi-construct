import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { VERSION } from '../src/version.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const CLI = path.join(REPO_ROOT, 'src/cli.ts')
const RUNTIME_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_AGENT', 'CURSOR_TRACE_ID']

export const VERSION_PLACEHOLDER = 'v<version>'

export interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

export async function runCli(args: string[], home: string): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', HOME: home }
  for (const name of RUNTIME_MARKERS)
    delete env[name]
  const child = spawn(process.execPath, [TSX, CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const status = await new Promise<number | null>((resolve) => {
    child.on('close', resolve)
  })
  return { status, stdout, stderr }
}

export function withVersionPlaceholder(output: string): string {
  return output.split(`v${VERSION}`).join(VERSION_PLACEHOLDER)
}
