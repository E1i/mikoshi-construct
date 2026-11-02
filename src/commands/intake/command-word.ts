import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

const ENV_ASSIGNMENT = /^[A-Z_]\w*=/i
const SHELL_WORDS = new Set(['.', ':', '(', '{', '!', 'cd', 'command', 'eval', 'exec', 'export', 'set', 'source', 'if', 'for', 'while', 'until', 'case'])
export const TEST_NAME_ARGUMENT = /(?:^|\s)(?:-t|--testNamePattern)(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g
const OUTPUT_REDIRECT = /(?:\d|&)?>>?\s*\S+/g
const ARGUMENT_PREFIX = /^(?:[\w-]+=|\d*[<>]+&?|['"(])+/
const TRAILING_QUOTES = /['")]+$/
export const HOME_REFERENCE = /^~(?:\/|$)|\$\{?HOME\b/
const CURRENT_DIRECTORY_PREFIX = /^\.\//

export function commandWord(command: string): string | undefined {
  return command.trim().split(/\s+/).find(word => !ENV_ASSIGNMENT.test(word))
}

export function namesATest(command: string): boolean {
  return command.match(TEST_NAME_ARGUMENT) !== null
}

export function commandArguments(command: string): string[] {
  const read = command.replace(TEST_NAME_ARGUMENT, ' ').replace(OUTPUT_REDIRECT, ' ')
  const word = commandWord(read)
  const words = read.trim().split(/\s+/)
  return words.filter((_, index) => index !== words.indexOf(word ?? '')).map(token => token.replace(ARGUMENT_PREFIX, '').replace(TRAILING_QUOTES, '')).filter(token => token !== '')
}

export function pathsNamedBy(command: string, readable: (relative: string) => boolean): string[] {
  const word = commandWord(command) ?? ''
  const named = commandArguments(command)
  return (word.includes('/') ? [word, ...named] : named)
    .filter(token => !token.startsWith('-') && !path.isAbsolute(token) && !HOME_REFERENCE.test(token))
    .map(token => token.replace(CURRENT_DIRECTORY_PREFIX, ''))
    .filter(readable)
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

function resolvesOnPath(word: string, searchPath: string): boolean {
  return searchPath
    .split(path.delimiter)
    .filter(directory => path.isAbsolute(directory))
    .some(directory => isExecutableFile(path.join(directory, word)))
}

export function unresolvedCommandWord(command: string, searchPath: string): string | null {
  const word = commandWord(command)
  if (word == null || word.includes('/') || SHELL_WORDS.has(word))
    return null
  return resolvesOnPath(word, searchPath) ? null : word
}
