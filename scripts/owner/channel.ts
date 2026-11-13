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

export const OWNER_WORD_TERM_MS = 24 * 60 * 60 * 1000

interface Said {
  at: number
  lines: string[]
}

function saidIn(file: string): Said | null {
  try {
    const [first = '', ...lines] = readFileSync(file, 'utf8').split('\n')
    const at = first.startsWith(SAID_PREFIX) ? Date.parse(first.slice(SAID_PREFIX.length).trim()) : Number.NaN
    return Number.isNaN(at) ? null : { at, lines }
  }
  catch {
    return null
  }
}

function inTerm(said: Said | null, now: Date): Said | null {
  return said !== null && now.getTime() - said.at <= OWNER_WORD_TERM_MS ? said : null
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

export function consumeOwnerWord(channel: string, command: string, now: Date): ConsumedWord | null {
  const file = unusedWordsOf(channel).find(candidate => inTerm(saidIn(candidate), now)?.lines.some(line => line.trim() === command) === true && renamed(candidate, `${candidate}${USED_WORD}`))
  return file === undefined ? null : consumed(file)
}

function escaped(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wordsClosing(said: Said | null, id: string): string | null {
  if (said === null)
    return null
  const naming = new RegExp(`^(?:close:\\s*)?${escaped(id)}(?=[:\\s]|$):?\\s*`)
  const words = said.lines.join('\n').trim()
  const prefix = naming.exec(words)
  return prefix === null ? null : words.slice(prefix[0].length).trim()
}

export function consumeOwnerWordClosing(channel: string, id: string, now: Date): ClosingWord | null {
  for (const file of unusedWordsOf(channel)) {
    const words = wordsClosing(inTerm(saidIn(file), now), id)
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

export function ownerMoveUnsaid(command: string): string {
  return `${OWNER_WORD_NOT_FOUND}: an owner move runs only on the owner's word, the line "${command}" said into the owner channel`
}

export function ownerWordAwaited(id: string): string {
  return `${id} waits for the owner's word naming ${id}: the owner lifts it by saying "${id}: <the answer>" into the owner channel within ${OWNER_WORD_TERM_MS / 3_600_000} h of the close`
}
