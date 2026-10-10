import path from 'node:path'

export interface EntryCommand {
  name: string
  command: string
  line: number
  cwd: string
}

const OPERATORS = /&&|\|\||[;|<>]/g
const QUOTES = /^["']+|["']+$/g

function suffixes(token: string): string[] {
  const parts = token.split('/')
  return parts.map((_, index) => parts.slice(index).join('/')).filter(candidate => candidate !== '')
}

function inside(cwd: string, candidate: string): string {
  return path.posix.normalize(path.posix.join(cwd === '.' ? '' : cwd, candidate))
}

export function targetsOf(entry: EntryCommand, tracked: Set<string>): string[] {
  const tokens = entry.command.replace(OPERATORS, ' ').split(/\s+/).flatMap(token => token.split('=')).map(token => token.replace(QUOTES, ''))
  const found = tokens.flatMap((token) => {
    const target = suffixes(token).map(candidate => inside(entry.cwd, candidate)).find(candidate => tracked.has(candidate))
    return target === undefined ? [] : [target]
  })
  return [...new Set(found)]
}
