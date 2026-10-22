import { spawnSync } from 'node:child_process'

export interface PnpmResult {
  code: number
  stdout: string
  stderr: string
}

const PNPM_OUTPUT_LIMIT = 64 * 1024 * 1024

export function runPnpmCommand(cwd: string, args: string[], input?: string): PnpmResult {
  const result = spawnSync('pnpm', args, { cwd, input, encoding: 'utf8', maxBuffer: PNPM_OUTPUT_LIMIT })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error === undefined ? result.stderr ?? '' : result.error.message }
}
