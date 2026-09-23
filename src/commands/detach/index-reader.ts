import type { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type IndexUnreadable = 'index-v4' | 'split-index' | 'sparse-index' | 'object-format'

export type IndexReading = { tracked: Set<string> } | { unreadable: IndexUnreadable }

const HEADER_LENGTH = 12
const STAT_LENGTH = 40
const NAME_LENGTH_MASK = 0xFFF
const EXTENDED_FLAG = 0x4000
const ENTRY_ALIGNMENT = 8
const HASH_SIZES: Record<string, number> = { sha1: 20, sha256: 32 }

function objectFormat(root: string): string {
  const file = path.join(root, '.git/config')
  if (!existsSync(file))
    return 'sha1'
  let section = ''
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const heading = /^\s*\[([^\]]+)\]/.exec(line)
    if (heading != null) {
      section = heading[1].trim().toLowerCase()
      continue
    }
    const key = /^\s*objectformat\s*=\s*(\S+)/i.exec(line)
    if (section === 'extensions' && key != null)
      return key[1].toLowerCase()
  }
  return 'sha1'
}

function optionalExtension(signature: string): boolean {
  return /^[A-Z]/.test(signature)
}

function readEntries(index: Buffer, version: number, count: number, hashSize: number): { tracked: Set<string>, offset: number } {
  const tracked = new Set<string>()
  let offset = HEADER_LENGTH
  for (let entry = 0; entry < count; entry += 1) {
    const start = offset
    offset += STAT_LENGTH + hashSize
    const flags = index.readUInt16BE(offset)
    offset += 2
    if (version >= 3 && (flags & EXTENDED_FLAG) !== 0)
      offset += 2
    const nameLength = flags & NAME_LENGTH_MASK
    const nameEnd = nameLength < NAME_LENGTH_MASK ? offset + nameLength : index.indexOf(0, offset)
    tracked.add(index.toString('utf8', offset, nameEnd))
    offset = start + Math.ceil((nameEnd + 1 - start) / ENTRY_ALIGNMENT) * ENTRY_ALIGNMENT
  }
  return { tracked, offset }
}

function unreadableExtension(index: Buffer, offset: number, hashSize: number): IndexUnreadable | null {
  let cursor = offset
  while (cursor < index.length - hashSize) {
    const signature = index.toString('latin1', cursor, cursor + 4)
    const size = index.readUInt32BE(cursor + 4)
    if (signature === 'link')
      return 'split-index'
    if (signature === 'sdir')
      return 'sparse-index'
    if (!optionalExtension(signature))
      throw new Error(`unknown git index extension "${signature}"`)
    cursor += 8 + size
  }
  return null
}

export function readTrackedPaths(root: string): IndexReading {
  const format = objectFormat(root)
  const hashSize = HASH_SIZES[format]
  if (hashSize == null)
    return { unreadable: 'object-format' }
  const file = path.join(root, '.git/index')
  if (!existsSync(file))
    return { tracked: new Set() }
  const index = readFileSync(file)
  if (index.toString('latin1', 0, 4) !== 'DIRC')
    throw new Error('.git/index does not start with DIRC')
  const version = index.readUInt32BE(4)
  if (version === 4)
    return { unreadable: 'index-v4' }
  if (version !== 2 && version !== 3)
    throw new Error(`unknown git index version ${version}`)
  const { tracked, offset } = readEntries(index, version, index.readUInt32BE(8), hashSize)
  const unreadable = unreadableExtension(index, offset, hashSize)
  return unreadable == null ? { tracked } : { unreadable }
}
