export interface ImportReading {
  specifier: string
  line: number
  bindings: string[]
  namespaces: string[]
}

export interface ModuleReading {
  imports: ImportReading[]
  calls: Array<{ name: string, member: boolean, line: number }>
}

const QUOTES = new Set(['\'', '"', '`'])

function blank(character: string): string {
  return character === '\n' ? '\n' : ' '
}

function stringEnd(source: string, start: number, quote: string): number {
  let index = start + 1
  while (index < source.length) {
    const current = source[index]
    if (current === '\\') {
      index += 2
      continue
    }
    if (current === quote)
      return index + 1
    if (current === '\n' && quote !== '`')
      return index
    index += 1
  }
  return source.length
}

export function maskComments(source: string): { code: string, strings: string } {
  let code = ''
  let strings = ''
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        code += ' '
        strings += ' '
        index += 1
      }
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      for (; index < stop; index += 1) {
        code += blank(source[index])
        strings += blank(source[index])
      }
      continue
    }
    if (QUOTES.has(character)) {
      const end = stringEnd(source, index, character)
      code += source.slice(index, end)
      strings += `${character}${[...source.slice(index + 1, end - 1)].map(blank).join('')}${end - index > 1 ? source[end - 1] : ''}`
      index = end
      continue
    }
    code += character
    strings += character
    index += 1
  }
  return { code, strings }
}

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n')
      line += 1
  }
  return line
}

const IMPORT_FROM = /\b(?:import|export)(\s(?:(?!\b(?:import|export)\b)[\w$\s{},*])*?)from\s*(['"])([^'"\n]*)\2/g
const BARE_IMPORT = /\bimport\s*(?:\(\s*)?(['"])([^'"\n]*)\1/g
const NAMESPACE = /\*\s*as\s+([A-Z_$][\w$]*)/gi
const IDENTIFIER = /^[A-Z_$][\w$]*$/i

function bindingsOf(clause: string): { bindings: string[], namespaces: string[] } {
  const trimmed = clause.trim()
  if (trimmed === '' || trimmed.startsWith('type '))
    return { bindings: [], namespaces: [] }
  const namespaces = [...trimmed.matchAll(NAMESPACE)].map(match => match[1])
  const braces = /\{([^}]*)\}/.exec(trimmed)
  const named = braces == null
    ? []
    : braces[1].split(',').map(part => part.trim()).filter(part => part !== '' && !part.startsWith('type ')).map(part => part.split(/\s+as\s+/).at(-1)?.trim() ?? '')
  const outside = trimmed.replace(/\{[^}]*\}/, '').replace(NAMESPACE, '').split(',').map(part => part.trim())
  const defaults = outside.filter(part => IDENTIFIER.test(part) && part !== 'type')
  return { bindings: [...defaults, ...named].filter(name => IDENTIFIER.test(name)), namespaces }
}

function specifierAt(code: string, match: RegExpMatchArray, specifier: string): string {
  const end = (match.index ?? 0) + match[0].length - 1
  return code.slice(end - specifier.length, end)
}

function escaped(name: string): string {
  return name.replace(/\$/g, '\\$')
}

export function scanModule(source: string): ModuleReading {
  const { code, strings } = maskComments(source)
  const imports: ImportReading[] = []
  const taken = new Set<number>()
  for (const match of strings.matchAll(IMPORT_FROM)) {
    const index = match.index ?? 0
    const exportsOnly = match[0].startsWith('export')
    const { bindings, namespaces } = exportsOnly ? { bindings: [], namespaces: [] } : bindingsOf(match[1])
    imports.push({ specifier: specifierAt(code, match, match[3]), line: lineAt(source, index), bindings, namespaces })
    taken.add(index + match[0].length)
  }
  for (const match of strings.matchAll(BARE_IMPORT)) {
    const index = match.index ?? 0
    if (taken.has(index + match[0].length))
      continue
    imports.push({ specifier: specifierAt(code, match, match[2]), line: lineAt(source, index), bindings: [], namespaces: [] })
  }
  const calls: ModuleReading['calls'] = []
  for (const reading of imports) {
    for (const name of reading.bindings) {
      for (const match of strings.matchAll(new RegExp(`(?<![\\w$.])${escaped(name)}\\s*\\(`, 'g')))
        calls.push({ name, member: false, line: lineAt(source, match.index ?? 0) })
    }
    for (const name of reading.namespaces) {
      for (const match of strings.matchAll(new RegExp(`(?<![\\w$.])${escaped(name)}\\s*\\.\\s*[\\w$]+\\s*\\(`, 'g')))
        calls.push({ name, member: true, line: lineAt(source, match.index ?? 0) })
    }
  }
  return { imports: imports.sort((a, b) => a.line - b.line || (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0)), calls }
}
