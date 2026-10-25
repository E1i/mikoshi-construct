function globToRegExp(glob: string): RegExp {
  let pattern = ''
  let index = 0
  while (index < glob.length) {
    const rest = glob.slice(index)
    if (rest.startsWith('**/')) {
      pattern += '(?:.*/)?'
      index += 3
    }
    else if (rest.startsWith('**')) {
      pattern += '.*'
      index += 2
    }
    else if (glob[index] === '*') {
      pattern += '[^/]*'
      index += 1
    }
    else {
      pattern += glob[index]!.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      index += 1
    }
  }
  return new RegExp(`^${pattern}$`)
}

export function matchGlob(glob: string, candidate: string): boolean {
  return globToRegExp(glob).test(candidate)
}

export function expandGlob(glob: string, files: string[]): string[] {
  return files.filter(file => matchGlob(glob, file))
}
