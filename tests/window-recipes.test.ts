import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL = '.claude/skills/window-recipes/SKILL.md'
const TEMPLATE = 'templates/ai/claude/_claude/skills/window-recipes/SKILL.md'
const CORE = 'architecture/window-core.md'
const CORE_LINE = '- тупик карты — сначала навык window-recipes'
const PROCEDURES = '## Procedures'
const COLUMNS = ['Situation', 'Sign in the bus', 'Command', 'Who']
const COMMAND_COLUMN = COLUMNS.indexOf('Command')
const WHO_COLUMN = COLUMNS.indexOf('Who')
const WHO = new Set(['window', 'owner'])
const HELP_TIMEOUT_MS = 180_000
const SEPARATOR_ROW = /^\|[-|]+\|$/
const INLINE_CODE = /`([^`]+)`/g
const QUOTED_OR_PLACEHOLDER = /^[<'"+]/
const FLAG = /^--[a-z-]+$/
const USAGE = /usage/i

const scratch = mkdtempSync(path.join(tmpdir(), 'window-recipes-'))
const SCRATCH_BUS = { CONSTRUCT_BUS_DB: path.join(scratch, 'bus.db') }

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function rowsOf(skill: string): string[][] {
  return skill.split('\n')
    .filter(line => line.startsWith('|') && !SEPARATOR_ROW.test(line))
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
}

function commandsOf(skill: string): string[] {
  const commands = rowsOf(skill).slice(1).flatMap(row => [...row[COMMAND_COLUMN]!.matchAll(INLINE_CODE)].map(match => match[1]!))
  return [...new Set(commands)]
}

interface HelpCall {
  tool: string
  args: string[]
  names: string[]
}

function helpCallOf(command: string): HelpCall {
  const [tool, ...words] = command.split(' ')
  const flags = words.filter(word => FLAG.test(word))
  if (tool === 'pnpm') {
    const [script, subcommand] = words
    const named = subcommand === undefined || subcommand.startsWith('-') || QUOTED_OR_PLACEHOLDER.test(subcommand) ? [] : [subcommand]
    return { tool, args: ['--silent', script!, '--help'], names: [...named, ...flags] }
  }
  if (tool === 'gh') {
    const end = words.findIndex(word => word.startsWith('-') || QUOTED_OR_PLACEHOLDER.test(word))
    return { tool, args: [...words.slice(0, end), '--help'], names: flags }
  }
  throw new Error(`the table names a command of ${tool}, which this test cannot ask for --help: ${command}`)
}

function helpOf(command: string): { command: string, answered: boolean, missing: string[] } {
  const call = helpCallOf(command)
  const run = spawnSync(call.tool, call.args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...SCRATCH_BUS } })
  const output = `${run.stdout}${run.stderr}`
  return { command, answered: USAGE.test(output), missing: call.names.filter(name => !output.includes(name)) }
}

describe('the window-recipes skill', () => {
  it('every command in the table exists', () => {
    const commands = commandsOf(read(SKILL))
    expect(commands).toContain('pnpm intake --move \'#N\' --to lane-K')
    expect(commands.map(helpOf)).toEqual(commands.map(command => ({ command, answered: true, missing: [] })))
  }, HELP_TIMEOUT_MS)

  it('reads a script or an option that does not exist as absent', () => {
    expect(helpOf('pnpm no-such-script').answered).toBe(false)
    expect(helpOf('pnpm intake --no-such-option <x>').missing).toEqual(['--no-such-option'])
    expect(helpOf('pnpm bus:request no.such.kind --card <N>').missing).toEqual(['no.such.kind'])
  }, HELP_TIMEOUT_MS)

  it('never hands --help to a bus:request kind, which would write a real request', () => {
    expect(helpCallOf('pnpm bus:request requeue --task <task_key>').args).toEqual(['--silent', 'bus:request', '--help'])
  })

  it('refuses a command whose tool it cannot ask for --help', () => {
    expect(() => helpCallOf('rm -rf <dir>')).toThrow('cannot ask for --help')
  })

  it('has one table of the four columns, each row run by the window or the owner', () => {
    const [header, ...rows] = rowsOf(read(SKILL))
    expect(header).toEqual(COLUMNS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(row => row.length !== COLUMNS.length || !WHO.has(row[WHO_COLUMN]!))).toEqual([])
  })

  it('carries each trigger the owner named in its description', () => {
    const description = read(SKILL).split('\n').find(line => line.startsWith('description:'))!
    for (const trigger of ['a card stands still', 'a dead end', 'not its own lane', 'outside touches', 'a question that does not close', 'a PR with no card', 'a conflict', 'the merge queue holds'])
      expect(description).toContain(trigger)
  })

  it('the template carries the same skill', () => {
    expect(read(TEMPLATE)).toBe(read(SKILL))
  })

  it('window-core sends a dead end to the skill', () => {
    const core = read(CORE)
    expect(core.slice(core.indexOf(PROCEDURES)).split('\n')).toContain(CORE_LINE)
  })
})
