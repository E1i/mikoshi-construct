import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { formatViolation, scanText } from '../scripts/privacy/scan.js'
import { cliEnv } from './cli-process.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const TEMPLATE = 'templates/ai/claude/_claude/skills/window-recipes/SKILL.md'
const THIS_REPOSITORYS_SKILL = '.claude/skills/window-recipes/SKILL.md'
const NODE_WITH_TSX = ['--import', 'tsx']
const COLUMNS = ['Situation', 'Sign in the bus', 'Command', 'Who']
const COMMAND_COLUMN = COLUMNS.indexOf('Command')
const WHO_COLUMN = COLUMNS.indexOf('Who')
const WHO = new Set(['window', 'owner'])
const HELP_TIMEOUT_MS = 300_000
const SEPARATOR_ROW = /^\|[-|]+\|$/
const INLINE_CODE = /`([^`]+)`/g
const NOT_A_NAME = /^[<'"+-]/
const FLAG = /^--[a-z-]+$/
const USAGE = /usage/i
const BUILT_PREFIX = /^dist\//
const BUILT_SUFFIX = /\.js$/
const ROOT_HELP = 'USAGE construct init|'
const THIS_REPOSITORYS_WORDS = ['pnpm', 'Kukloda', 'Ghost', 'owner-decisions', 'bus heartbeat', 'card #', '~/', 'D-']
const GH = 'gh'
const WITH_A_SUBCOMMAND = new Set(['construct', 'miko'])

const scratch = mkdtempSync(path.join(tmpdir(), 'window-recipes-template-'))
const SCRATCH_ENV = { ...cliEnv(scratch), CONSTRUCT_BUS_DB: path.join(scratch, 'bus.db') }

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
  return [...new Set(rowsOf(skill).slice(1).flatMap(row => [...row[COMMAND_COLUMN]!.matchAll(INLINE_CODE)].map(match => match[1]!)))]
}

function descriptionOf(skill: string): string {
  return skill.split('\n').find(line => line.startsWith('description:'))!
}

function sourceOfBin(tool: string): string {
  const bins = (JSON.parse(read('package.json')) as { bin: Record<string, string> }).bin
  const built = bins[tool]
  if (built === undefined)
    throw new Error(`the table names ${tool}, which is no bin of the package, so a generated repository does not have it`)
  const relative = built.replace(BUILT_PREFIX, '').replace(BUILT_SUFFIX, '.ts')
  return relative.startsWith('scripts/') ? relative : `src/${relative}`
}

interface HelpCall {
  file: string
  args: string[]
  names: string[]
}

function helpCallOf(command: string): HelpCall {
  const [tool, ...words] = command.split(' ')
  const flags = words.filter(word => FLAG.test(word))
  if (tool === GH) {
    const end = words.findIndex(word => NOT_A_NAME.test(word))
    return { file: GH, args: [...words.slice(0, end), '--help'], names: flags }
  }
  const prefix = [...NODE_WITH_TSX, sourceOfBin(tool!)]
  if (!WITH_A_SUBCOMMAND.has(tool!))
    return { file: process.execPath, args: [...prefix, '--help'], names: flags }
  const [subcommand, argument] = words
  const named = argument === undefined || NOT_A_NAME.test(argument) ? [] : [argument]
  return { file: process.execPath, args: [...prefix, subcommand!, '--help'], names: [...named, ...flags] }
}

function helpOf(command: string): { command: string, answered: boolean, missing: string[] } {
  const call = helpCallOf(command)
  const run = spawnSync(call.file, call.args, { cwd: REPO_ROOT, encoding: 'utf8', env: SCRATCH_ENV })
  const output = `${run.stdout}${run.stderr}`
  return { command, answered: USAGE.test(output) && !output.includes(ROOT_HELP), missing: call.names.filter(name => !output.includes(name)) }
}

describe('the window-recipes template', () => {
  it('every command in the template table exists', () => {
    const commands = commandsOf(read(TEMPLATE))
    expect(commands).toContain('miko request requeue --task <task_key>')
    expect(commands.map(helpOf)).toEqual(commands.map(command => ({ command, answered: true, missing: [] })))
  }, HELP_TIMEOUT_MS)

  it('reads a command or an option that does not exist as absent', () => {
    expect(helpOf('construct no-such-command').answered).toBe(false)
    expect(helpOf('miko no-such-command --card <N>').answered).toBe(false)
    expect(helpOf('construct-intake --no-such-option <x>')).toMatchObject({ answered: true, missing: ['--no-such-option'] })
    expect(helpOf('miko request no.such.kind --card <N>')).toMatchObject({ answered: true, missing: ['no.such.kind'] })
  }, HELP_TIMEOUT_MS)

  it('never hands --help to a miko request kind, which would write a real request', () => {
    expect(helpCallOf('miko request requeue --task <task_key>').args.slice(-2)).toEqual(['request', '--help'])
  })

  it('refuses a tool the package does not ship, such as this repository\'s scripts', () => {
    expect(() => helpCallOf('pnpm bus:request requeue --task <task_key>')).toThrow('no bin of the package')
  })

  it('names construct-intake for a move, because construct intake with no bus wired refuses it', () => {
    const refused = spawnSync(process.execPath, [...NODE_WITH_TSX, sourceOfBin('construct'), 'intake', '--plain', '--move', '#1', '--to', 'lane-2'], { cwd: REPO_ROOT, encoding: 'utf8', env: SCRATCH_ENV })
    expect(refused.status).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain('construct-intake')
    expect(commandsOf(read(TEMPLATE)).filter(command => command.includes('--move') || command.includes('--amend')).map(command => command.split(' ')[0])).toEqual(['construct-intake', 'construct-intake'])
  }, HELP_TIMEOUT_MS)

  it('has one table of the four columns, each row run by the window or the owner', () => {
    const [header, ...rows] = rowsOf(read(TEMPLATE))
    expect(header).toEqual(COLUMNS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(row => row.length !== COLUMNS.length || !WHO.has(row[WHO_COLUMN]!))).toEqual([])
  })

  it('carries the triggers of the skill this repository runs on', () => {
    expect(descriptionOf(read(TEMPLATE))).toBe(descriptionOf(read(THIS_REPOSITORYS_SKILL)))
  })

  it('passes the privacy scan and names nothing private to this repository', () => {
    const template = read(TEMPLATE)
    expect(scanText(template, TEMPLATE).map(formatViolation)).toEqual([])
    expect(THIS_REPOSITORYS_WORDS.filter(word => template.includes(word))).toEqual([])
  })
})
