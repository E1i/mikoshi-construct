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
