import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARGS_PATH, tiedArgsSha256 } from '../../ghosts/args-chain.js'

const APPROVED = 'a'.repeat(64)

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function worktreeWith(bytes: string | null): string {
  const worktree = mkdtempSync(path.join(tmpdir(), 'ghosts-args-chain-'))
  mkdirSync(path.join(worktree, '.construct'))
  if (bytes !== null)
    writeFileSync(path.join(worktree, ARGS_PATH), bytes)
  return worktree
}

const BUILT = `${JSON.stringify({ agreedSha256: APPROVED, task: 'a task' })}\n`

describe('tiedArgsSha256', () => {
  it('returns the sha256 of the bytes when the file was built from the approved text and the row names those bytes', () => {
    expect(tiedArgsSha256(worktreeWith(BUILT), APPROVED, sha256(BUILT))).toBe(sha256(BUILT))
  })

  it('returns the sha256 of the bytes as read, never of a re-serialisation', () => {
    const spaced = `{ "task": "a task",   "agreedSha256": "${APPROVED}" }`
    expect(sha256(spaced)).not.toBe(sha256(JSON.stringify(JSON.parse(spaced))))
    expect(tiedArgsSha256(worktreeWith(spaced), APPROVED, sha256(spaced))).toBe(sha256(spaced))
  })

  it('is null when the args file is absent', () => {
    expect(tiedArgsSha256(worktreeWith(null), APPROVED, sha256(BUILT))).toBeNull()
  })

  it('is null when the args file cannot be read', () => {
    const worktree = worktreeWith(null)
    mkdirSync(path.join(worktree, ARGS_PATH))
    expect(tiedArgsSha256(worktree, APPROVED, sha256(BUILT))).toBeNull()
  })

  it('is null when the args file is not JSON', () => {
    const bytes = `agreedSha256: ${APPROVED}`
    expect(tiedArgsSha256(worktreeWith(bytes), APPROVED, sha256(bytes))).toBeNull()
  })

  it('is null when the args file is JSON but not an object', () => {
    const bytes = JSON.stringify([APPROVED])
    expect(tiedArgsSha256(worktreeWith(bytes), APPROVED, sha256(bytes))).toBeNull()
  })

  it('is null when the args file was built from a text other than the approved one', () => {
    const bytes = JSON.stringify({ agreedSha256: 'c'.repeat(64) })
    expect(tiedArgsSha256(worktreeWith(bytes), APPROVED, sha256(bytes))).toBeNull()
  })

  it('is null when the row names other bytes', () => {
    expect(tiedArgsSha256(worktreeWith(BUILT), APPROVED, 'd'.repeat(64))).toBeNull()
  })

  it('is null when the row names no argsSha256', () => {
    expect(tiedArgsSha256(worktreeWith(BUILT), APPROVED, undefined)).toBeNull()
  })
})
