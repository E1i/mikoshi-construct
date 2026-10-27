import type { PushPolicy } from '../../src/commands/attach/record.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ATTACH_RECORD = '.construct/attach.json'

export function pushPolicyOf(git: (cwd: string, args: string[]) => string, worktree: string): PushPolicy {
  const root = path.dirname(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  const record = path.join(root, ATTACH_RECORD)
  if (!existsSync(record))
    return 'bus'
  return (JSON.parse(readFileSync(record, 'utf8')) as { push?: PushPolicy }).push === 'bus' ? 'bus' : 'none'
}
