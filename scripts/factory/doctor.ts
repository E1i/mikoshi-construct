import type { FactoryContract, PullRequest, Rule, Settings } from './permissions.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { REPO } from '../shift/places.js'
import { OPERATOR_ROLE } from '../shift/relaunch.js'
import { realStateDeps, stateFindings } from '../state/index.js'
import { backtickedCommands, contractRules, missingRules, unallowedCommands, unmatchedCommands, withRules } from './permissions.js'

export const PREFIX = '[doctor:factory] '
export const USAGE = 'usage: pnpm doctor:factory [--apply]'
export const CONTRACT = path.join('contract', 'factory-permissions.json')
export const LOCAL_SETTINGS = path.join('.claude', 'settings.local.json')
export const WINDOW_DOC = path.join('architecture', 'window.md')

export interface OperatorCommands {
  window: string[]
  role: string[]
}

export interface DoctorDeps {
  cwd: string
  gh: (args: string[]) => string
  commands: () => OperatorCommands
  state: () => string[]
  confirm: (() => Promise<boolean>) | null
}

export interface DoctorResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

function openPulls(gh: DoctorDeps['gh']): PullRequest[] {
  return JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--limit', '200', '-R', REPO])) as PullRequest[]
}

function readSettings(file: string): Settings {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Settings : {}
}

function ruleLine(rule: Rule): string {
  return `${PREFIX}missing ${rule.list} ${rule.rule}`
}

export async function runDoctor(argv: string[], deps: DoctorDeps): Promise<DoctorResult> {
  const apply = argv.includes('--apply')
  if (argv.some(arg => arg !== '--apply'))
    return { stdout: [], stderr: [USAGE], exitCode: 2 }
  const contract = JSON.parse(readFileSync(path.join(deps.cwd, CONTRACT), 'utf8')) as FactoryContract
  const settingsFile = path.join(deps.cwd, LOCAL_SETTINGS)
  const settings = readSettings(settingsFile)
  const missing = missingRules(contractRules(contract, openPulls(deps.gh)), settings)
  const { window, role } = deps.commands()
  const unmatched = unmatchedCommands(window, contract.allow)
  const unallowed = unallowedCommands(role, contract.allow)
  const state = deps.state()
  const stdout = [
    ...missing.map(ruleLine),
    ...unmatched.map(({ command, rule }) => `${PREFIX}command \`${command}\` does not have the shape of ${rule}`),
    ...unallowed.map(command => `${PREFIX}command \`${command}\` is allowed by no rule in ${CONTRACT}`),
    ...state.map(finding => `${PREFIX}state: ${finding}`),
  ]
  const commandsHold = unmatched.length === 0 && unallowed.length === 0 && state.length === 0
  if (missing.length === 0 && commandsHold)
    return { stdout: [`${PREFIX}every contract rule is in ${LOCAL_SETTINGS}, every command has the shape of one and every state file was written through state:*`], stderr: [], exitCode: 0 }
  if (!apply || missing.length === 0)
    return { stdout, stderr: [], exitCode: 1 }
  if (deps.confirm === null)
    return { stdout: [...stdout, `${PREFIX}no terminal to confirm on — nothing written`], stderr: [], exitCode: 1 }
  if (!await deps.confirm())
    return { stdout: [...stdout, `${PREFIX}not confirmed — nothing written`], stderr: [], exitCode: 1 }
  writeFileSync(settingsFile, `${JSON.stringify(withRules(settings, missing), null, 2)}\n`)
  return {
    stdout: [...stdout, `${PREFIX}appended ${missing.length} rule(s) to ${LOCAL_SETTINGS}`],
    stderr: [],
    exitCode: commandsHold ? 0 : 1,
  }
}

export function operatorCommands(cwd: string): OperatorCommands {
  return {
    window: backtickedCommands(readFileSync(path.join(cwd, WINDOW_DOC), 'utf8')),
    role: backtickedCommands(OPERATOR_ROLE),
  }
}

async function askYes(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(?:es)?$/i.test((await prompt.question(`${PREFIX}append these rules to ${LOCAL_SETTINGS}? [y/N] `)).trim())
  }
  finally {
    prompt.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd()
  const result = await runDoctor(process.argv.slice(2), {
    cwd,
    gh: args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    commands: () => operatorCommands(cwd),
    state: () => stateFindings(realStateDeps().places),
    confirm: process.stdin.isTTY ? askYes : null,
  })
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
