import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const ORIGINAL_NAME = 'settings.local.json.orig'

const KEY_LENGTH = 12
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const TOLERATED = ['ENOENT', 'ENOTEMPTY', 'ENOTDIR']

export type OriginalKept
  = | { kind: 'kept', copy: string, sha256: string }
    | { kind: 'failed', copy: string }

export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function attachHome(): string {
  return path.join(homedir(), '.construct', 'attach')
}

export function originalKey(root: string): string {
  const real = realpathSync(root)
  return `${sha256OfBytes(Buffer.from(real)).slice(0, KEY_LENGTH)}-${path.basename(real)}`
}

export function originalCopyPath(root: string): string {
  return path.join(attachHome(), originalKey(root), ORIGINAL_NAME)
}

export function isConfinedCopy(copy: unknown): copy is string {
  return typeof copy === 'string'
    && path.isAbsolute(copy)
    && path.normalize(copy) === copy
    && path.basename(copy) === ORIGINAL_NAME
    && path.dirname(path.dirname(copy)) === attachHome()
}

function tolerating(action: () => void): boolean {
  try {
    action()
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && TOLERATED.includes(error.code))
      return false
    throw error
  }
}

function removeEmptyDirectory(directory: string): void {
  tolerating(() => rmdirSync(directory))
}

function abandon(copy: string, written: boolean): void {
  try {
    if (written)
      rmSync(copy)
    dropEmptyDirectories(copy)
  }
  catch {
    return undefined
  }
}

export function keepOriginal(root: string, bytes: Buffer): OriginalKept {
  const copy = originalCopyPath(root)
  const keyDirectory = path.dirname(copy)
  let written = false
  try {
    mkdirSync(keyDirectory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(keyDirectory, DIRECTORY_MODE)
    writeFileSync(copy, bytes, { flag: 'wx', mode: FILE_MODE })
    written = true
    chmodSync(copy, FILE_MODE)
  }
  catch {
    abandon(copy, written)
    return { kind: 'failed', copy }
  }
  return { kind: 'kept', copy, sha256: sha256OfBytes(bytes) }
}

function dropEmptyDirectories(copy: string): void {
  const keyDirectory = path.dirname(copy)
  removeEmptyDirectory(keyDirectory)
  removeEmptyDirectory(path.dirname(keyDirectory))
}

export function dropOriginal(copy: string): void {
  tolerating(() => rmSync(copy))
  dropEmptyDirectories(copy)
}
