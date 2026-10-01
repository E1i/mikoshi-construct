import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const ARGS_PATH = '.construct/implement-args.json'

function readBytes(file: string): Buffer | null {
  try {
    return readFileSync(file)
  }
  catch {
    return null
  }
}

function agreedSha256Of(bytes: Buffer): unknown {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined
    return (parsed as Record<string, unknown>).agreedSha256
  }
  catch {
    return undefined
  }
}

export function tiedArgsSha256(worktree: string, approvedSha256: string, rowArgsSha256: string | undefined): string | null {
  const bytes = readBytes(path.join(worktree, ARGS_PATH))
  if (bytes === null || agreedSha256Of(bytes) !== approvedSha256)
    return null
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return sha256 === rowArgsSha256 ? sha256 : null
}
