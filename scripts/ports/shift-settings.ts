import type { ShiftGate } from '../../src/manifest.js'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserLabExcludedCommand, browserLabInstalledScript, cardTreeGitWrites, SETTINGS_FILE } from '../../src/commands/attach/settings.js'
import { isJsonObject } from '../../src/materialize/strategies.js'
import { cardOfTree, grantOf } from './card-grants.js'
import { WIDE_VITEST_HOOKS } from './wide-vitest-guard.js'

const SANDBOX_UID = os.userInfo().uid

export const TSX_PIPE_DIRECTORY = `/tmp/claude-${SANDBOX_UID}/tsx-${SANDBOX_UID}`

export const CARD_SESSION_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true, allowUnixSockets: [TSX_PIPE_DIRECTORY] } } as const

const SESSION_BASH_CAP_MS = String(30 * 60 * 1000)

export const SESSION_BASH_CAP = { BASH_MAX_TIMEOUT_MS: SESSION_BASH_CAP_MS, BASH_DEFAULT_TIMEOUT_MS: SESSION_BASH_CAP_MS, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } as const

const BROWSER_LAB_SCRIPT = 'scripts/construct/browser-lab.mjs'

const REPOSITORY_SETTINGS_FILES = ['.claude/settings.json', SETTINGS_FILE]

const GITDIR_POINTER = /^gitdir:[ \t]*(\S.*)$/m

export interface ShiftSettings {
  sandbox: typeof CARD_SESSION_SANDBOX & { excludedCommands?: string[], filesystem?: { allowWrite?: string[], denyWrite?: string[] }, network: { allowedDomains?: string[] } }
  permissions: { allow: string[], deny?: string[] }
  env: typeof SESSION_BASH_CAP
  hooks: typeof WIDE_VITEST_HOOKS
}

function excludes(file: string, entry: string): boolean {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isJsonObject(settings) && isJsonObject(settings.sandbox) && Array.isArray(settings.sandbox.excludedCommands) && settings.sandbox.excludedCommands.includes(entry)
  }
  catch {
    return false
  }
}

function gitDirOfLinkedTree(tree: string): string | null {
  try {
    const pointer = GITDIR_POINTER.exec(readFileSync(path.join(tree, '.git'), 'utf8'))?.[1]
    return pointer === undefined ? null : path.resolve(tree, pointer.trim())
  }
  catch {
    return null
  }
}

function commonDirOf(gitDir: string): string | null {
  try {
    return path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
  }
  catch {
    return null
  }
}

function mainCheckoutOf(tree: string): string | null {
  const gitDir = gitDirOfLinkedTree(tree)
  const common = gitDir === null ? null : commonDirOf(gitDir)
  return common !== null && path.basename(common) === '.git' ? path.dirname(common) : null
}

export function treeGitWrites(tree: string): string[] {
  const gitDir = gitDirOfLinkedTree(tree)
  const common = gitDir === null ? null : commonDirOf(gitDir)
  return gitDir === null || common === null ? [] : cardTreeGitWrites(gitDir, common)
}

function mainCheckoutExcludes(tree: string, entry: string): boolean {
  const main = mainCheckoutOf(tree)
  return main !== null && excludes(path.join(main, SETTINGS_FILE), entry)
}

function grantedSandbox(card: number | null, home: string, tree: string): ShiftSettings['sandbox'] {
  const grant = grantOf(card)
  const allowWrite = [...(grant?.homeWrites ?? []).map(entry => path.join(home, entry)), ...treeGitWrites(tree)]
  const sandbox = grant === null ? CARD_SESSION_SANDBOX : { ...CARD_SESSION_SANDBOX, network: { ...CARD_SESSION_SANDBOX.network, allowedDomains: [...grant.domains] } }
  return allowWrite.length === 0 ? sandbox : { ...sandbox, filesystem: { allowWrite } }
}

export function shiftSettings(tree: string, gate: ShiftGate, writable: string[] = [], home: string = os.homedir(), card: number | null = cardOfTree(tree)): ShiftSettings {
  const allow = [
    ...gate.prepush.map(command => `Bash(${command})`),
    `Edit(/${tree}/**)`,
    ...writable.map(file => `Edit(/${file})`),
    ...grantOf(card)?.allow ?? [],
  ]
  const sandbox = grantedSandbox(card, home, tree)
  const entry = browserLabExcludedCommand(home)
  const excluded = existsSync(browserLabInstalledScript(home)) && (REPOSITORY_SETTINGS_FILES.some(file => excludes(path.join(tree, file), entry)) || mainCheckoutExcludes(tree, entry))
  if (!excluded)
    return { sandbox, permissions: { allow }, env: SESSION_BASH_CAP, hooks: WIDE_VITEST_HOOKS }
  const lab = path.join(tree, BROWSER_LAB_SCRIPT)
  const labHome = path.join(home, '.construct', 'browser-lab')
  return {
    sandbox: { ...sandbox, excludedCommands: [entry], filesystem: { ...sandbox.filesystem, denyWrite: [lab, labHome] } },
    permissions: { allow, deny: [`Edit(/${lab})`, `Edit(/${labHome}/**)`] },
    env: SESSION_BASH_CAP,
    hooks: WIDE_VITEST_HOOKS,
  }
}

export function settingsFlag(settings: ShiftSettings): string[] {
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings)]
}
