import type { BusEvent } from '../core/db.js'
import type { WindowShard } from '../policy/shards.js'
import type { BgResult } from './bg.js'
import type { BusWorker, FactoryMode } from './workers.js'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUS_DB_VARIABLE, busDirOf, pinBus } from '../core/bus-path.js'
import { appendEvent, openBus } from '../core/db.js'
import { SHARD_ISSUED, SHARD_REVOKED } from '../core/events.js'
import { FACTORY_NAMED } from '../core/factory-paths.js'
import { consumeOwnerWord, ownerChannelOfBus, USED_WORD } from '../owner/channel.js'
import { allowLiveText } from '../policy/live-decision.js'
import { activeWindowShards, WINDOW_SHARD_HOURS, windowShardEnded } from '../policy/shards.js'
import { installedPackage, printBg } from './bg.js'
import { startBus } from './supervisor.js'
import { DEFAULT_MODE, FACTORY_MODES, isBusWorker, isFactoryMode, MODE_LIVE, MODE_WORKERS, startingMode, switchDetection, switchMode } from './workers.js'

export const START_PREFIX = '[factory:start] '
export const OWNER_AGENT = 'dev.mikoshi.bus'
export const OWNER_AGENT_FILE = path.join(FACTORY_NAMED.launchdDirectory, `${OWNER_AGENT}.plist`)
export const AGENT_PREFIX = 'dev.mikoshi.factory.'
export const KEEP_ALIVE_PLATFORM = 'darwin'
export const LAUNCH_AGENTS = path.join('Library', 'LaunchAgents')
export const AGENT_LOG = 'launchd.log'
export const RAISED_WITHIN_S = 20
export const START_BIN = 'construct-factory'
export const KEEP_ALIVE_PROGRAM = ['/usr/bin/env', START_BIN]
export const MODE_FLAG = '--mode'
export const HOURS_FLAG = '--hours'
export const LIVE_SWITCH = '--live'
export const SHADOW_SWITCH = '--shadow'
export const SAY_COMMAND = 'construct say'
export const MODE_SHARD_SCOPE = 'merge'
export const USAGE = `usage: ${START_BIN} — starts the factory for the git repository in the current directory and installs its keep-alive; ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[0]} | ${MODE_FLAG} ${FACTORY_MODES[1]} [${HOURS_FLAG} <n>] | ${LIVE_SWITCH} <worker> | ${SHADOW_SWITCH} <worker> — switches its mode or a worker's queue and writes bus/workers.json`

const REPOSITORY_HASH_LENGTH = 12
const HOUR_MS = 3_600_000
const MODE_SHARD_ACTOR = 'owner'
const MODE_ACTOR = 'factory:mode'

export interface LaunchctlRun {
  status: number
  stderr: string
}

export interface KeepAliveParts {
  platform: NodeJS.Platform
  home: string
  uid: number
  path: string
  busDb: string
  busDir: string
  launchctl: (args: string[]) => LaunchctlRun
}

export interface KeepAliveAgent {
  label: string
  repository: string
  path: string
  busDb: string
  log: string
}

export function isOwnerCheckout(repository: string): boolean {
  return existsSync(path.join(repository, OWNER_AGENT_FILE))
}

export function factoryBusOf(env: NodeJS.ProcessEnv, home: string, repository: string): string {
  return pinBus(env, home, repository, isOwnerCheckout(repository))
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
    ...KEEP_ALIVE_PROGRAM.map(argument => `\t\t${plistString(argument)}`),
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t${plistString(agent.repository)}`,
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    '\t\t<key>PATH</key>',
    `\t\t${plistString(agent.path)}`,
    `\t\t<key>${BUS_DB_VARIABLE}</key>`,
    `\t\t${plistString(agent.busDb)}`,
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
  const text = keepAlivePlist({ label, repository, path: parts.path, busDb: parts.busDb, log: path.join(parts.busDir, AGENT_LOG) })
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
  const mode = startingMode(parts.busDir)
  const fresh = mode === null ? [] : [`${START_PREFIX}a fresh factory starts in mode ${mode}: ${MODE_WORKERS[mode].join(', ')} switched on, merge off, a human merges; ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[1]} switches to ${FACTORY_MODES[1]} on the owner's word`]
  const started = await start()
  const kept = installKeepAlive(repository, installed, parts)
  return { stdout: [...fresh, ...started.stdout, ...kept.stdout], stderr: [...started.stderr, ...kept.stderr], exitCode: Math.max(started.exitCode, kept.exitCode) }
}

export type StartCommand
  = | { kind: 'start' }
    | { kind: 'mode', mode: FactoryMode, hours: number }
    | { kind: 'queue', worker: BusWorker, live: boolean }

export interface ModeParts {
  busDir: string
  channel: string
  now: () => Date
  uuid: () => string
  record: (event: BusEvent) => void
  activeWindows: (now: Date) => WindowShard[]
}

function positiveHours(value: string | undefined): number | null {
  const hours = Number(value)
  return value !== undefined && Number.isInteger(hours) && hours > 0 ? hours : null
}

export function startCommandOf(argv: readonly string[]): StartCommand | null {
  if (argv.length === 0)
    return { kind: 'start' }
  const [flag, value, ...rest] = argv
  if ((flag === LIVE_SWITCH || flag === SHADOW_SWITCH) && value !== undefined && isBusWorker(value) && rest.length === 0)
    return { kind: 'queue', worker: value, live: flag === LIVE_SWITCH }
  if (flag !== MODE_FLAG || value === undefined || !isFactoryMode(value))
    return null
  if (rest.length === 0)
    return { kind: 'mode', mode: value, hours: WINDOW_SHARD_HOURS }
  const hours = rest[0] === HOURS_FLAG && rest.length === 2 && value !== DEFAULT_MODE ? positiveHours(rest[1]) : null
  return hours === null ? null : { kind: 'mode', mode: value, hours }
}

export function ghostProtocolWord(hours: number): string {
  return `ghost-protocol ${hours}h`
}

export function sayCommand(words: string): string {
  return `${SAY_COMMAND} "${words}"`
}

function switchedTo(mode: FactoryMode, on: readonly BusWorker[]): string {
  return `${START_PREFIX}mode ${mode}: switched on ${on.join(', ')}; the supervisor starts what is switched on and stops what is switched off on its next tick`
}

function refusedWithoutWord(words: string, then: string, why: string): BgResult {
  return { stdout: [], stderr: [`${START_PREFIX}${why}, and no unused owner word "${words}" is in ${SAY_COMMAND}'s channel; nothing was switched. The owner runs: ${sayCommand(words)} && ${then}`], exitCode: 1 }
}

function fateOf(release: () => boolean, file: string): string {
  return release() ? 'left unused' : `stays used though nothing was switched; the owner renames ${file}${USED_WORD} back to ${path.basename(file)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(lines: string[]): BgResult {
  return { stdout: [], stderr: lines.map(line => `${START_PREFIX}${line}`), exitCode: 1 }
}

function windowMode(parts: ModeParts): BgResult {
  let on: BusWorker[]
  try {
    on = switchMode(parts.busDir, DEFAULT_MODE, null, MODE_LIVE[DEFAULT_MODE])
  }
  catch (error) {
    return failed([`${DEFAULT_MODE} was not switched, so no shard was revoked: ${messageOf(error)}`])
  }
  const now = parts.now()
  const stdout = [switchedTo(DEFAULT_MODE, on)]
  const stderr: string[] = []
  for (const shard of parts.activeWindows(now)) {
    try {
      parts.record(windowShardEnded(SHARD_REVOKED, MODE_ACTOR, shard.id, now))
      stdout.push(`${START_PREFIX}shard ${shard.id} revoked: in ${DEFAULT_MODE} a human merges`)
    }
    catch (error) {
      stderr.push(`${START_PREFIX}merge is off, but shard ${shard.id} was not revoked (${messageOf(error)}); it ends at its term`)
    }
  }
  return { stdout, stderr, exitCode: stderr.length === 0 ? 0 : 1 }
}

function ghostProtocol(parts: ModeParts, hours: number): BgResult {
  const words = ghostProtocolWord(hours)
  const word = consumeOwnerWord(parts.channel, words)
  if (word === null)
    return refusedWithoutWord(words, `${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[1]}${hours === WINDOW_SHARD_HOURS ? '' : ` ${HOURS_FLAG} ${hours}`}`, `${FACTORY_MODES[1]} merges under the owner's shard for ${hours} h`)
  const id = parts.uuid()
  const now = parts.now()
  const until = new Date(now.getTime() + hours * HOUR_MS).toISOString()
  try {
    parts.record({ ts: now.toISOString(), type: SHARD_ISSUED, actor: MODE_SHARD_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${id}`, payload: { id, by: word.file, run: null, window: true, scope: MODE_SHARD_SCOPE, until }, legacy: false })
  }
  catch (error) {
    return failed([`the shard was not recorded in the bus (${messageOf(error)}); owner word ${word.file} ${fateOf(word.release, word.file)}`])
  }
  let on: BusWorker[]
  try {
    on = switchMode(parts.busDir, FACTORY_MODES[1], until)
  }
  catch (error) {
    const revoked = (() => {
      try {
        parts.record(windowShardEnded(SHARD_REVOKED, MODE_ACTOR, id, now))
        return `shard ${id} revoked`
      }
      catch (revokeError) {
        return `shard ${id} was not revoked (${messageOf(revokeError)}) and ends at its term`
      }
    })()
    return failed([`${FACTORY_MODES[1]} was not switched: ${messageOf(error)}; ${revoked}; owner word ${word.file} ${fateOf(word.release, word.file)}`])
  }
  return { stdout: [`${START_PREFIX}shard ${id} issued by the owner word ${word.file}, scope ${MODE_SHARD_SCOPE}, until ${until}`, switchedTo(FACTORY_MODES[1], on), `${START_PREFIX}at ${until} the supervisor returns the factory to ${DEFAULT_MODE} on its next tick; ${START_BIN} ${MODE_FLAG} ${DEFAULT_MODE} returns sooner and revokes the shard`], stderr: [], exitCode: 0 }
}

function detecting(now: BusWorker[]): BgResult {
  return { stdout: [`${START_PREFIX}detecting live: ${now.join(', ') || 'none'}; every other worker detects in shadow, and a worker already running changes mode when it is switched off and on`], stderr: [], exitCode: 0 }
}

function queueSwitch(parts: ModeParts, worker: BusWorker, live: boolean): BgResult {
  if (!live) {
    try {
      return detecting(switchDetection(parts.busDir, worker, false))
    }
    catch (error) {
      return failed([`${worker} was not switched to shadow: ${messageOf(error)}`])
    }
  }
  const words = allowLiveText(worker)
  const word = consumeOwnerWord(parts.channel, words)
  if (word === null)
    return refusedWithoutWord(words, `${START_BIN} ${LIVE_SWITCH} ${worker}`, `the ${worker} queue goes live only on the owner's word`)
  try {
    return detecting(switchDetection(parts.busDir, worker, true))
  }
  catch (error) {
    return failed([`${worker} was not switched live: ${messageOf(error)}; owner word ${word.file} ${fateOf(word.release, word.file)}`])
  }
}

export function runMode(command: Exclude<StartCommand, { kind: 'start' }>, parts: ModeParts): BgResult {
  if (command.kind === 'queue')
    return queueSwitch(parts, command.worker, command.live)
  return command.mode === DEFAULT_MODE ? windowMode(parts) : ghostProtocol(parts, command.hours)
}

function systemLaunchctl(args: string[]): LaunchctlRun {
  const run = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: run.status ?? 1, stderr: `${run.stderr ?? ''}${run.error?.message ?? ''}` }
}

function withBus<T>(busDb: string, read: (db: ReturnType<typeof openBus>) => T): T {
  const db = openBus(busDb)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const command = startCommandOf(process.argv.slice(2))
  if (command === null) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const busDb = factoryBusOf(process.env, os.homedir(), process.cwd())
  if (command.kind !== 'start') {
    printBg(runMode(command, {
      busDir: busDirOf(busDb),
      channel: ownerChannelOfBus(os.homedir(), busDb),
      now: () => new Date(),
      uuid: randomUUID,
      record: event => withBus(busDb, db => appendEvent(db, event)),
      activeWindows: now => withBus(busDb, db => activeWindowShards(db, now)),
    }))
    return
  }
  printBg(await runStart(realpathSync(process.cwd()), installedPackage(), {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    path: process.env.PATH ?? '',
    busDb,
    busDir: busDirOf(busDb),
    launchctl: systemLaunchctl,
  }))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
