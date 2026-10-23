import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const OWNER_CHANNEL_HOME = '.construct-owner'
export const OWNER_ANSWERS = 'answers'
export const SAID_PREFIX = 'said: '
export const UNUSED_WORD = '.md'
export const USED_WORD = '.used'
export const OWNER_WORD_NOT_FOUND = 'слово владельца не найдено в канале владельца'

export interface ConsumedWord {
  file: string
  release: () => boolean
}

export function ownerChannelOf(home: string): string {
  return path.join(home, OWNER_CHANNEL_HOME, OWNER_ANSWERS)
}

export function sayToOwnerChannel(channel: string, text: string, now: Date): string {
  mkdirSync(channel, { recursive: true })
  const said = now.toISOString()
  const file = path.join(channel, `${said.replace(/[:.]/g, '-')}-${randomUUID()}${UNUSED_WORD}`)
  writeFileSync(file, `${SAID_PREFIX}${said}\n${text.trim()}\n`, { flag: 'wx' })
  return file
}

function holdsWords(file: string, words: string): boolean {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(1).some(line => line.trim() === words)
  }
  catch {
    return false
  }
}

function renamed(from: string, to: string): boolean {
  try {
    renameSync(from, to)
    return true
  }
  catch {
    return false
  }
}

export function consumeOwnerWord(channel: string, words: string): ConsumedWord | null {
  if (!existsSync(channel))
    return null
  const unused = readdirSync(channel).filter(name => name.endsWith(UNUSED_WORD)).sort().map(name => path.join(channel, name))
  const file = unused.find(candidate => holdsWords(candidate, words) && renamed(candidate, `${candidate}${USED_WORD}`))
  return file === undefined ? null : { file, release: () => renamed(`${file}${USED_WORD}`, file) }
}
