export const RUNNER_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
]

const STRING_LITERAL = /^(['"])(.*)\1$/

function literalEntries(body: string): string[] | null {
  const trimmed = body.trim()
  if (trimmed === '')
    return []
  const entries = trimmed.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  const values = entries.map(entry => STRING_LITERAL.exec(entry)?.[2])
  return values.every(value => value != null) ? values as string[] : null
}

export function includeGlobs(source: string): string[] | null {
  const found: string[] = []
  let literal = false
  for (const match of source.matchAll(/include\s*:\s*/g)) {
    const rest = source.slice(match.index + match[0].length)
    if (!rest.startsWith('['))
      return null
    const close = rest.indexOf(']')
    if (close === -1)
      return null
    const entries = literalEntries(rest.slice(1, close))
    if (entries == null)
      return null
    literal = true
    found.push(...entries)
  }
  return literal ? found : null
}

function escapeLiteral(character: string): string {
  return /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character
}

export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  let braces = 0
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*' && glob[index + 1] === '*' && glob[index + 2] === '/') {
      pattern += '(?:[^/]+/)*'
      index += 2
      continue
    }
    if (character === '*' && glob[index + 1] === '*') {
      pattern += '.*'
      index += 1
      continue
    }
    if (character === '*') {
      pattern += '[^/]*'
      continue
    }
    if (character === '?') {
      pattern += '[^/]'
      continue
    }
    if (character === '{') {
      braces += 1
      pattern += '(?:'
      continue
    }
    if (character === '}' && braces > 0) {
      braces -= 1
      pattern += ')'
      continue
    }
    if (character === ',' && braces > 0) {
      pattern += '|'
      continue
    }
    pattern += escapeLiteral(character)
  }
  return new RegExp(`^${pattern}$`)
}

export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const normalized = file.replace(/^\.\//, '')
  return globs.some(glob => globToRegExp(glob.replace(/^\.\//, '')).test(normalized))
}
