import type { CommandSurface, Flag } from './surface.js'
import { stripVTControlCharacters } from 'node:util'

const USAGE_LINE = /^USAGE \S+(?: \[OPTIONS\])?(?: [a-z][\w-]*)* ([a-z][\w-]*(?:\|[a-z][\w-]*)*)\s*$/m
const HEADER = /\(([^()]+)\)$/
const VERSION_TOKEN = /^v\d/
const OPTION = /^((?:-[^\s,-][^\s,]*, )*)--([^\s=,]+)(=<([^>]*)>)?$/
const COLUMN_GAP = /\s{2,}/

function lines(help: string): string[] {
  return stripVTControlCharacters(help).split('\n').map(line => line.trimEnd())
}

function section(help: string[], title: string): string[] {
  const start = help.indexOf(title)
  if (start === -1)
    return []
  const body = help.slice(start + 2)
  const end = body.indexOf('')
  return end === -1 ? body : body.slice(0, end)
}

export function usageCommands(help: string): string[] {
  const names = USAGE_LINE.exec(stripVTControlCharacters(help))?.[1]
  if (names == null)
    throw new Error('the root --help prints no USAGE line listing the commands')
  return names.split('|')
}

export function listsCommands(help: string): boolean {
  return section(lines(help), 'COMMANDS').length > 0
}

function headerCommand(header: string, words: number): string | null {
  const tokens = HEADER.exec(header)?.[1].split(' ').filter(token => token !== '')
  if (tokens == null)
    return null
  const named = VERSION_TOKEN.test(tokens.at(-1) ?? '') ? tokens.slice(0, -1) : tokens
  return named.length >= words ? named.slice(-words).join(' ') : null
}

function flagOf(option: string): [string, Flag] {
  const parsed = OPTION.exec(option.trim().split(COLUMN_GAP)[0])
  if (parsed == null)
    throw new Error(`--help prints an option line that is not a flag: ${option.trim()}`)
  const type = parsed[3] == null ? 'boolean' : parsed[4].includes('|') ? 'enum' : 'string'
  const aliases = parsed[1].split(', ').filter(alias => alias !== '').map(alias => alias.slice(1))
  return [parsed[2], aliases.length === 0 ? { type } : { type, alias: aliases.join(',') }]
}

function withoutNegations(flags: [string, Flag][]): [string, Flag][] {
  const names = new Set(flags.map(([name]) => name))
  return flags.filter(([name, flag]) => !(flag.type === 'boolean' && name.startsWith('no-') && names.has(name.slice(3))))
}

export function commandFromHelp(name: string, help: string): CommandSurface {
  const text = lines(help)
  const canonical = headerCommand(text[0] ?? '', name.split(' ').length)
  if (canonical == null)
    throw new Error(`${name} --help prints no header naming the command`)
  if (canonical !== name)
    return { aliasOf: canonical }
  if (section(text, 'ARGUMENTS').length > 0)
    throw new Error(`${name} --help lists positional arguments, whose names it prints upper-cased`)
  return { flags: Object.fromEntries(withoutNegations(section(text, 'OPTIONS').map(flagOf))) }
}
