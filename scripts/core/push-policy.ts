import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ATTACH_RECORD = '.construct/attach.json'

export type PushPolicy = 'none' | 'bus'

export function pushPolicyAt(cwd: string): PushPolicy {
  return pushPolicyOf((dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), cwd)
}

export function pushPolicyOf(git: (cwd: string, args: string[]) => string, worktree: string): PushPolicy {
  const root = path.dirname(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  const record = path.join(root, ATTACH_RECORD)
  if (!existsSync(record))
    return 'bus'
  return (JSON.parse(readFileSync(record, 'utf8')) as { push?: PushPolicy }).push === 'bus' ? 'bus' : 'none'
}
