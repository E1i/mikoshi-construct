import type { Surface } from '../../scripts/contract/surface.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { EXIT_TABLES } from '../../scripts/contract/json-samples.js'
import { generateSurface } from '../../scripts/contract/surface.js'

const HELP = path.resolve(import.meta.dirname, '../fixtures/cli-help')
const EXIT_CHARACTERIZATION = path.resolve(import.meta.dirname, '../cli-exit-codes.test.ts')
const TITLE = /^(?<command>[a-z-]+(?: [a-z-]+)?(?: --[a-z-]+)?)(?: and its alias(?:es)?)?: (?<outcomes>.+)$/
const CODE = /(?:^|\s)(\d+)(?=[,;]|$)/g

let surface: Surface

const GENERATION_TIMEOUT = 180_000

beforeAll(() => {
  surface = generateSurface()
}, GENERATION_TIMEOUT)

function helpOf(command: string): string {
  return readFileSync(path.join(HELP, `${command.replaceAll(' ', '-')}.txt`), 'utf8')
}

function commandsInMainHelp(): string[] {
  const usage = /^USAGE construct (\S+)$/m.exec(helpOf('main'))
  if (usage == null)
    throw new Error('tests/fixtures/cli-help/main.txt carries no USAGE line')
  return usage[1].split('|')
}

function flagsInHelp(command: string): string[] {
  return [...helpOf(command).matchAll(/--([a-z][\w-]*)/gi)].map(match => match[1])
}

function characterizedTitles(): string[] {
  const source = readFileSync(EXIT_CHARACTERIZATION, 'utf8')
  return [...source.matchAll(/\bit\('([^']+)'/g)].map(match => match[1])
}

function characterizedCodes(): Map<string, Set<number>> {
  const byCommand = new Map<string, Set<number>>()
  for (const title of characterizedTitles()) {
    const parsed = TITLE.exec(title)
    const codes = parsed == null ? [] : [...parsed.groups!.outcomes.matchAll(CODE)].map(match => Number(match[1]))
    if (parsed == null || codes.length === 0)
      throw new Error(`tests/cli-exit-codes.test.ts has a title this test cannot read: "${title}"`)
    byCommand.set(parsed.groups!.command, new Set(codes))
  }
  return byCommand
}

function recordedCodes(command: string): Set<number> {
  const table = surface.exits[command]
  if (table == null)
    return new Set()
  return new Set(Object.entries(table).filter(([state]) => state !== 'failed').map(([, code]) => code))
}

function sorted(codes: Set<number>): number[] {
  return [...codes].sort((a, b) => a - b)
}

describe('the surface covers what outside witnesses show of the command line', () => {
  it('names every command and alias in the main help', () => {
    const recorded = Object.keys(surface.commands)
    const missing = commandsInMainHelp().filter(name => !recorded.some(command => command === name || command.startsWith(`${name} `)))
    expect(missing, `commands and aliases the help shows and the surface lacks: ${missing.join(', ')}`).toEqual([])
  })

  it('names every flag each command help shows under that command', () => {
    const missing = Object.entries(surface.commands)
      .filter(([, command]) => 'flags' in command)
      .flatMap(([name, command]) => flagsInHelp(name).filter(flag => !('flags' in command && flag in command.flags)).map(flag => `${name} --${flag}`))
    expect(missing).toEqual([])
  })

  it('records per command the exit codes tests/cli-exit-codes.test.ts characterizes, apart from failed, which B0 does not characterize', () => {
    const characterized = characterizedCodes()
    expect(characterized.size).toBeGreaterThan(0)
    for (const [command, codes] of characterized)
      expect(sorted(recordedCodes(command)), `exit codes of ${command}`).toEqual(sorted(codes))
    expect(Object.keys(surface.exits).filter(command => !characterized.has(command))).toEqual([])
  })

  it('samples the --json of every state each exit table names, and samples no state the table lacks', () => {
    const unsampled = Object.entries(EXIT_TABLES)
      .flatMap(([command, table]) => Object.keys(table).filter(state => surface.jsonKeys[command]?.[state] == null).map(state => `${command} ${state}`))
    const unnamed = Object.entries(EXIT_TABLES)
      .flatMap(([command, table]) => Object.keys(surface.jsonKeys[command] ?? {}).filter(state => !(state in table)).map(state => `${command} ${state}`))
    expect(unsampled, `states with no --json sample: ${unsampled.join(', ')}`).toEqual([])
    expect(unnamed, `sampled states no exit table names: ${unnamed.join(', ')}`).toEqual([])
  })

  it('samples every command that takes --json, so a new one cannot print JSON the contract never recorded', () => {
    const withJson = Object.entries(surface.commands).filter(([, command]) => 'flags' in command && 'json' in command.flags).map(([name]) => name)
    expect(withJson.filter(name => !(name in EXIT_TABLES))).toEqual([])
  })
})
