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
