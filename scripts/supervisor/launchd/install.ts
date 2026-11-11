import type { BgResult } from '../bg.js'
import type { LaunchctlRun } from '../start.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { OWNER_AGENT } from '../../core/bus-path.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { printBg } from '../bg.js'
import { LAUNCH_AGENTS } from '../start.js'

export const AGENT_COMMAND_PREFIX = '[bus:agent] '
export const FACTORY_DIR_FLAG = 'factory-dir'
export const TOKEN_SOURCE_FLAG = 'token-source'
export const APPLY_FLAG = 'apply'
export const FACTORY_DIR_VARIABLE = 'CONSTRUCT_FACTORY_DIR'
export const TOKEN_SOURCE_VARIABLE = 'CONSTRUCT_BUS_TOKEN_SOURCE'
export const USAGE = `usage: ${pnpmCommand('bus:agent')} [--${FACTORY_DIR_FLAG} <absolute path>] [--${TOKEN_SOURCE_FLAG} <command that prints the GitHub token>] [--${APPLY_FLAG}] — renders the bus agent from its template and prints a diff against the installed file; --${APPLY_FLAG} replaces the file and reloads the agent. A value not given as a flag is read from ${FACTORY_DIR_VARIABLE} or ${TOKEN_SOURCE_VARIABLE}`

const TEMPLATE = path.join(import.meta.dirname, 'dev.mikoshi.bus.plist')
const PLACEHOLDER = /\{\{(\w+)\}\}/g
const DIFF_FOUND_CHANGES = 1
const DIFF_COULD_NOT_COMPARE = 2

export interface AgentValues {
  factoryDir: string
  tokenSource: string
}

export interface AgentCommand extends AgentValues {
  apply: boolean
}

export interface DiffRun extends LaunchctlRun {
  stdout: string
}

export interface AgentParts {
  template: string
  home: string
  uid: number
  diff: (installed: string, rendered: string) => DiffRun
  launchctl: (args: string[]) => LaunchctlRun
}

function xmlEscaped(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`
}

export function renderAgent(template: string, values: AgentValues): string {
  const rendered = new Map([
    ['factoryDir', xmlEscaped(shellQuoted(values.factoryDir))],
    ['tokenSource', xmlEscaped(values.tokenSource)],
  ])
  return template.replaceAll(PLACEHOLDER, (placeholder: string, name: string) => {
    const value = rendered.get(name)
    if (value === undefined)
      throw new Error(`the template asks for ${placeholder}, which this command has no value for`)
    return value
  })
}

export function agentCommandOf(argv: string[], env: NodeJS.ProcessEnv): AgentCommand | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        [FACTORY_DIR_FLAG]: { type: 'string' },
        [TOKEN_SOURCE_FLAG]: { type: 'string' },
        [APPLY_FLAG]: { type: 'boolean', default: false },
      },
    })
    return {
      factoryDir: (values[FACTORY_DIR_FLAG] ?? env[FACTORY_DIR_VARIABLE] ?? '').trim(),
      tokenSource: (values[TOKEN_SOURCE_FLAG] ?? env[TOKEN_SOURCE_VARIABLE] ?? '').trim(),
      apply: values[APPLY_FLAG] === true,
    }
  }
  catch {
    return null
  }
}

function refusalsOf(command: AgentValues): string[] {
  return [
    ...(command.factoryDir === '' ? [`no factory directory: give --${FACTORY_DIR_FLAG} or ${FACTORY_DIR_VARIABLE}`] : []),
    ...(command.factoryDir !== '' && !path.isAbsolute(command.factoryDir) ? [`the factory directory ${command.factoryDir} is not absolute, and launchd does not start in this directory`] : []),
    ...(command.tokenSource === '' ? [`no token source: give --${TOKEN_SOURCE_FLAG} or ${TOKEN_SOURCE_VARIABLE}`] : []),
  ]
}

function refused(lines: string[]): BgResult {
  return { stdout: [], stderr: [...lines, 'nothing was written'].map(line => `${AGENT_COMMAND_PREFIX}${line}`), exitCode: 1 }
}

export function runAgentCommand(command: AgentCommand, parts: AgentParts): BgResult {
  const refusals = refusalsOf(command)
  if (refusals.length > 0)
    return refused(refusals)
  const rendered = renderAgent(parts.template, command)
  const installed = path.join(parts.home, LAUNCH_AGENTS, `${OWNER_AGENT}.plist`)
  const diff = parts.diff(installed, rendered)
  if (diff.status > DIFF_FOUND_CHANGES)
    return refused([`diff could not compare ${installed} (exit ${diff.status}): ${diff.stderr.trim()}`])
  const domain = `gui/${parts.uid}`
  if (diff.status !== DIFF_FOUND_CHANGES && (!command.apply || parts.launchctl(['print', `${domain}/${OWNER_AGENT}`]).status === 0))
    return { stdout: [`${AGENT_COMMAND_PREFIX}${installed} already matches the template; nothing to do`], stderr: [], exitCode: 0 }
  const shown = diff.stdout === '' ? [] : [diff.stdout.trimEnd()]
  if (!command.apply)
    return { stdout: [...shown, `${AGENT_COMMAND_PREFIX}nothing was written; run again with --${APPLY_FLAG} to replace ${installed} and reload the agent`], stderr: [], exitCode: 0 }
  mkdirSync(path.dirname(installed), { recursive: true })
  writeFileSync(installed, rendered)
  parts.launchctl(['bootout', `${domain}/${OWNER_AGENT}`])
  const loaded = parts.launchctl(['bootstrap', domain, installed])
  if (loaded.status !== 0)
    return { stdout: shown, stderr: [`${AGENT_COMMAND_PREFIX}wrote ${installed}, but launchctl bootstrap ${domain} refused it (exit ${loaded.status}): ${loaded.stderr.trim()}; the agent is not loaded until launchctl bootstrap ${domain} ${installed} succeeds`], exitCode: 1 }
  return { stdout: [...shown, `${AGENT_COMMAND_PREFIX}replaced ${installed} and reloaded ${OWNER_AGENT}; a bus node already running keeps the environment it started with until it next starts`], stderr: [], exitCode: 0 }
}

export function systemDiff(installed: string, rendered: string): DiffRun {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bus-agent-'))
  try {
    const candidate = path.join(scratch, `${OWNER_AGENT}.plist`)
    const nothingInstalled = path.join(scratch, 'nothing-installed')
    writeFileSync(candidate, rendered)
    writeFileSync(nothingInstalled, '')
    const run = spawnSync('diff', ['-u', '--label', `${installed} (installed)`, '--label', `${installed} (rendered)`, existsSync(installed) ? installed : nothingInstalled, candidate], { encoding: 'utf8' })
    return { status: run.status ?? DIFF_COULD_NOT_COMPARE, stdout: run.stdout ?? '', stderr: `${run.stderr ?? ''}${run.error?.message ?? ''}` }
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function systemLaunchctl(args: string[]): LaunchctlRun {
  const run = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: run.status ?? 1, stderr: `${run.stderr ?? ''}${run.error?.message ?? ''}` }
}

function main(): void {
  const command = agentCommandOf(process.argv.slice(2), process.env)
  if (command === null) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  printBg(runAgentCommand(command, {
    template: readFileSync(TEMPLATE, 'utf8'),
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    diff: systemDiff,
    launchctl: systemLaunchctl,
  }))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
