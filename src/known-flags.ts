import type { ArgsDef } from 'citty'

const BUILT_IN_KEYS = ['_', 'help', 'h', 'version', 'v']

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function toCamelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
}

function aliasesOf(arg: ArgsDef[string]): string[] {
  const declared = 'alias' in arg ? arg.alias : undefined
  return declared == null ? [] : Array.isArray(declared) ? declared : [declared]
}

function spellingsOf(name: string): string[] {
  return [name, toKebabCase(name), toCamelCase(name)]
}

function declaredNames(argsDef: ArgsDef): Set<string> {
  const names = new Set(BUILT_IN_KEYS)
  for (const [name, arg] of Object.entries(argsDef)) {
    for (const spelling of spellingsOf(name))
      names.add(spelling)
    for (const alias of aliasesOf(arg)) {
      for (const spelling of spellingsOf(alias))
        names.add(spelling)
    }
  }
  return names
}

export function unknownFlags(argsDef: ArgsDef, parsedArgs: Record<string, unknown>): string[] {
  const known = declaredNames(argsDef)
  return Object.keys(parsedArgs).filter(key => !known.has(key))
}

function flagNameOf(token: string): string {
  return token.replace(/^-+/, '').split('=')[0]
}

export function typedSpellings(unknown: string[], rawArgs: string[]): string[] {
  const names = new Set(unknown)
  const typed = rawArgs
    .filter(token => token.startsWith('-'))
    .filter((token) => {
      const name = flagNameOf(token)
      return names.has(name) || (name.startsWith('no-') && names.has(name.slice(3)))
    })
    .map(token => token.split('=')[0])
  return [...new Set(typed)]
}
