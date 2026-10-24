import type { BgResult } from './bg.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { builtEntryOf, installedPackage, printBg } from './bg.js'
import { pinnedBusDir, startBus, SUPERVISOR_LAUNCH } from './supervisor.js'

export const START_PREFIX = '[factory:start] '
export const OWNER_AGENT = 'dev.mikoshi.bus'
export const OWNER_AGENT_FILE = path.join('scripts', 'bus', 'launchd', `${OWNER_AGENT}.plist`)
export const AGENT_PREFIX = 'dev.mikoshi.factory.'
export const KEEP_ALIVE_PLATFORM = 'darwin'
export const LAUNCH_AGENTS = path.join('Library', 'LaunchAgents')
export const AGENT_LOG = 'launchd.log'
export const RAISED_WITHIN_S = 20
export const USAGE = 'usage: construct-factory — starts the factory for the git repository in the current directory and installs its keep-alive; takes no arguments'

const REPOSITORY_HASH_LENGTH = 12

export interface LaunchctlRun {
  status: number
  stderr: string
}

export interface KeepAliveParts {
  platform: NodeJS.Platform
  home: string
  uid: number
  node: string
  path: string
  busDir: string
  launchctl: (args: string[]) => LaunchctlRun
}

export interface KeepAliveAgent {
  label: string
  node: string
  starter: string
  repository: string
  path: string
  log: string
}

export function isOwnerCheckout(repository: string): boolean {
  return existsSync(path.join(repository, OWNER_AGENT_FILE))
}

export function agentLabel(repository: string): string {
  const name = path.basename(repository).toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-')
  return `${AGENT_PREFIX}${name}-${createHash('sha256').update(repository).digest('hex').slice(0, REPOSITORY_HASH_LENGTH)}`
}

function escaped(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')
}

function plistString(value: string): string {
  return `<string>${escaped(value)}</string>`
}

export function keepAlivePlist(agent: KeepAliveAgent): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${plistString(agent.label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    `\t\t${plistString(agent.node)}`,
    `\t\t${plistString(agent.starter)}`,
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t${plistString(agent.repository)}`,
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    '\t\t<key>PATH</key>',
    `\t\t${plistString(agent.path)}`,
    '\t</dict>',
    '\t<key>StandardOutPath</key>',
    `\t${plistString(agent.log)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${plistString(agent.log)}`,
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<true/>',
    '\t<key>ThrottleInterval</key>',
    `\t<integer>${RAISED_WITHIN_S}</integer>`,
    '\t<key>AbandonProcessGroup</key>',
    '\t<true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

export function installKeepAlive(repository: string, installed: string | null, parts: KeepAliveParts): BgResult {
  if (isOwnerCheckout(repository))
    return { stdout: [`${START_PREFIX}${repository} is the factory's own checkout; its keep-alive is the agent ${OWNER_AGENT} in ${OWNER_AGENT_FILE}, installed by its owner, so no keep-alive is installed`], stderr: [], exitCode: 0 }
  if (installed === null)
    return { stdout: [], stderr: [`${START_PREFIX}this command runs from source, not from an installed package; the keep-alive starts the built factory, so run construct-factory from the installed mikoshi-construct`], exitCode: 1 }
  if (parts.platform !== KEEP_ALIVE_PLATFORM)
    return { stdout: [`${START_PREFIX}the keep-alive is a launchd agent, which only macOS has, so none is installed on ${parts.platform}; the factory runs detached and survives closing the terminal, and after a restart of the machine run construct-factory in ${repository} again`], stderr: [], exitCode: 0 }
  const label = agentLabel(repository)
  const plist = path.join(parts.home, LAUNCH_AGENTS, `${label}.plist`)
  const domain = `gui/${parts.uid}`
  const text = keepAlivePlist({ label, node: parts.node, starter: builtEntryOf(installed, SUPERVISOR_LAUNCH.script), repository, path: parts.path, log: path.join(parts.busDir, AGENT_LOG) })
  if (readOrNull(plist) === text && parts.launchctl(['print', `${domain}/${label}`]).status === 0)
    return { stdout: [`${START_PREFIX}the keep-alive ${label} for ${repository} is already installed and loaded (${plist})`], stderr: [], exitCode: 0 }
  mkdirSync(path.dirname(plist), { recursive: true })
  mkdirSync(parts.busDir, { recursive: true })
  writeFileSync(plist, text)
  parts.launchctl(['bootout', `${domain}/${label}`])
  const loaded = parts.launchctl(['bootstrap', domain, plist])
  if (loaded.status !== 0)
    return { stdout: [], stderr: [`${START_PREFIX}wrote ${plist}, but launchctl bootstrap ${domain} refused it (exit ${loaded.status}): ${loaded.stderr.trim()}`], exitCode: 1 }
  return { stdout: [`${START_PREFIX}installed the keep-alive ${label} for ${repository}: launchd reruns the factory starter within ${RAISED_WITHIN_S} s whenever it is not running, also after a restart of the machine (${plist})`], stderr: [], exitCode: 0 }
}

export async function runStart(repository: string, installed: string | null, parts: KeepAliveParts, start: () => Promise<BgResult> = () => startBus(parts.busDir)): Promise<BgResult> {
  const started = await start()
  const kept = installKeepAlive(repository, installed, parts)
  return { stdout: [...started.stdout, ...kept.stdout], stderr: [...started.stderr, ...kept.stderr], exitCode: Math.max(started.exitCode, kept.exitCode) }
}

function systemLaunchctl(args: string[]): LaunchctlRun {
  const run = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: run.status ?? 1, stderr: `${run.stderr ?? ''}${run.error?.message ?? ''}` }
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  printBg(await runStart(realpathSync(process.cwd()), installedPackage(), {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    path: process.env.PATH ?? '',
    busDir: pinnedBusDir(),
    launchctl: systemLaunchctl,
  }))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
