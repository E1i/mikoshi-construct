import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

const ENV_ASSIGNMENT = /^[A-Z_]\w*=/i
const SHELL_WORDS = new Set(['.', ':', '(', '{', '!', 'cd', 'command', 'eval', 'exec', 'export', 'set', 'source', 'if', 'for', 'while', 'until', 'case'])

export function commandWord(command: string): string | undefined {
  return command.trim().split(/\s+/).find(word => !ENV_ASSIGNMENT.test(word))
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
