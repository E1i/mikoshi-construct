import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMachineBus } from '../core/bus-path.js'

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

export function ownerChannelOfBus(home: string, busPath: string): string {
  const machine = ownerChannelOf(home)
  return isMachineBus(home, busPath) ? machine : path.join(machine, path.basename(path.dirname(path.resolve(busPath))))
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

export interface ClosingWord extends ConsumedWord {
  words: string
}

function unusedWordsOf(channel: string): string[] {
  return existsSync(channel) ? readdirSync(channel).filter(name => name.endsWith(UNUSED_WORD)).sort().map(name => path.join(channel, name)) : []
}

function consumed(file: string): ConsumedWord {
  return { file, release: () => renamed(`${file}${USED_WORD}`, file) }
}

export function consumeOwnerWord(channel: string, words: string): ConsumedWord | null {
  const file = unusedWordsOf(channel).find(candidate => holdsWords(candidate, words) && renamed(candidate, `${candidate}${USED_WORD}`))
  return file === undefined ? null : consumed(file)
}

function escaped(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wordsClosing(file: string, id: string): string | null {
  const naming = new RegExp(`^(?:close:\\s*)?${escaped(id)}(?=[:\\s]|$):?\\s*`)
  try {
    const said = readFileSync(file, 'utf8').split('\n').slice(1).join('\n').trim()
    const prefix = naming.exec(said)
    return prefix === null ? null : said.slice(prefix[0].length).trim()
  }
  catch {
    return null
  }
}

export function consumeOwnerWordClosing(channel: string, id: string): ClosingWord | null {
  for (const file of unusedWordsOf(channel)) {
    const words = wordsClosing(file, id)
    if (words !== null && renamed(file, `${file}${USED_WORD}`))
      return { ...consumed(file), words: words === '' ? id : words }
  }
  return null
}

const OWNER_MARK = /^\[owner\]\s*/
const A_NAMED_WAIT = /^Q\d+(?=[:\s]|$):?\s*/

export function decisionOnAWait(id: string, answer: string): string {
  return `${id}: ${answer}`
}

export function decisionWordsOf(text: string): string {
  return text.trim().replace(OWNER_MARK, '').replace(A_NAMED_WAIT, '').trim()
}

export function sameDecisionWords(one: string, other: string): boolean {
  const words = decisionWordsOf(one)
  return words !== '' && words === decisionWordsOf(other)
}

export function ownerWordAwaited(id: string): string {
  return `${id} waits for the owner's word naming ${id}: the owner lifts it by saying "${id}: <the answer>" into the owner channel, or the answer verbatim`
}
