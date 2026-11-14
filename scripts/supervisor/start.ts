import type { BusEvent } from '../core/db.js'
import type { WindowShard } from '../policy/shards.js'
import type { GhCaller } from '../ports/gh.js'
import type { BgResult, ProcessList, RunningProcess } from './bg.js'
import type { BusWorker, FactoryMode } from './workers.js'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { agentLabel, BUS_DB_VARIABLE, busDirOf, GH_ACCOUNT_VARIABLE, isOwnerCheckout, LAUNCH_AGENTS, OWNER_AGENT, OWNER_AGENT_FILE, pinBus, remoteUrlOf, repoSlugOfUrl } from '../core/bus-path.js'
import { appendEvent, openBus } from '../core/db.js'
import { SHARD_ISSUED, SHARD_REVOKED } from '../core/events.js'
import { constructCommand } from '../core/owner-commands.js'
import { consumeOwnerWord, ownerChannelOfBus, USED_WORD } from '../owner/channel.js'
import { inForceInText, OWNER_SOURCE } from '../policy/decisions/decisions.js'
import { decisionsAdderOpeningTheBus, projectionText } from '../policy/decisions/projection.js'
import { allowLiveText, namesQueueLive } from '../policy/live-decision.js'
import { activeWindowShards, DECISIONS_SCOPE, WINDOW_SHARD_HOURS, windowShardEnded } from '../policy/shards.js'
import { ghPort, readGhJson, recordedAccount } from '../ports/gh.js'
import { installedPackage, instancesOf, printBg, provenOnBus, psList } from './bg.js'
import { startBus, SUPERVISOR_LAUNCH } from './supervisor.js'
import { DEFAULT_MODE, FACTORY_MODES, isBusWorker, isFactoryMode, MODE_LIVE, MODE_WORKERS, startingMode, switchDetection, switchMode } from './workers.js'

export { AGENT_PREFIX, agentLabel, LAUNCH_AGENTS } from '../core/bus-path.js'

export const START_PREFIX = '[factory:start] '
export const KEEP_ALIVE_PLATFORM = 'darwin'
export const AGENT_LOG = 'launchd.log'
export const RAISED_WITHIN_S = 20
export const START_BIN = 'construct-factory'
export const HOLD_FLAG = '--hold'
export const HOLD_CHECK_MS = RAISED_WITHIN_S * 1000
export const KEEP_ALIVE_PROGRAM = ['/usr/bin/env', START_BIN, HOLD_FLAG]
export const MODE_FLAG = '--mode'
export const HOURS_FLAG = '--hours'
export const LIVE_SWITCH = '--live'
export const SHADOW_SWITCH = '--shadow'
export const SAY_COMMAND = constructCommand('say')
export const MODE_SHARD_SCOPE = DECISIONS_SCOPE
export const SHARD_DECIDES_LIVE: readonly BusWorker[] = ['merge', 'update']
export const USAGE = `usage: ${START_BIN} — starts the factory for the git repository in the current directory and installs its keep-alive; ${START_BIN} ${HOLD_FLAG} — does the same, then stays up while the supervisor of its bus runs and exits once it is gone, as the keep-alive runs it; ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[0]} | ${MODE_FLAG} ${FACTORY_MODES[1]} [${HOURS_FLAG} <n>] | ${LIVE_SWITCH} <worker> | ${SHADOW_SWITCH} <worker> — switches its mode or a worker's queue and writes bus/workers.json`

const HOUR_MS = 3_600_000
const DECISION_TERM_LENGTH = 19
const MODE_SHARD_ACTOR = 'owner'
const MODE_ACTOR = 'policy'
const GITHUB_REMOTE = /github\.com[:/]/
const NO_ACCESS = /HTTP 40[34]/

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
  env: NodeJS.ProcessEnv
  gh: GhCaller
}

export interface KeepAliveAgent {
  label: string
  repository: string
  path: string
  busDb: string
  log: string
  account: string | null
}

export function factoryBusOf(env: NodeJS.ProcessEnv, home: string, repository: string): string {
  return pinBus(env, home, repository, isOwnerCheckout(repository))
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
    ...(agent.account === null ? [] : [`\t\t<key>${GH_ACCOUNT_VARIABLE}</key>`, `\t\t${plistString(agent.account)}`]),
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
  const text = keepAlivePlist({ label, repository, path: parts.path, busDb: parts.busDb, log: path.join(parts.busDir, AGENT_LOG), account: recordedAccount(parts.env) })
  if (readOrNull(plist) === text && parts.launchctl(['print', `${domain}/${label}`]).status === 0)
    return { stdout: [`${START_PREFIX}the keep-alive ${label} for ${repository} is already installed and loaded (${plist})`], stderr: [], exitCode: 0 }
  mkdirSync(path.dirname(plist), { recursive: true })
  mkdirSync(parts.busDir, { recursive: true })
  writeFileSync(plist, text)
  parts.launchctl(['bootout', `${domain}/${label}`])
  const loaded = parts.launchctl(['bootstrap', domain, plist])
  if (loaded.status !== 0)
    return { stdout: [], stderr: [`${START_PREFIX}wrote ${plist}, but launchctl bootstrap ${domain} refused it (exit ${loaded.status}): ${loaded.stderr.trim()}`], exitCode: 1 }
  return { stdout: [`${START_PREFIX}installed the keep-alive ${label} for ${repository}: the starter it runs stays up while the supervisor of the bus runs, and launchd reruns it within ${RAISED_WITHIN_S} s once it exits, also after a restart of the machine (${plist})`], stderr: [], exitCode: 0 }
}

function sameLogin(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase()
}

export function accountOfRepository(slug: string, gh: GhCaller): { account: string | null, because: string } {
  const owner = slug.split('/')[0]!
  const active = readGhJson<{ login?: string }>(gh, ['api', 'user'])
  if (active.kind === 'failed')
    return { account: null, because: `the active gh account could not be read: ${active.reason}` }
  const login = active.value.login
  if (login === undefined || login === '')
    return { account: null, because: 'the active gh account could not be read: gh api user named no login' }
  if (sameLogin(login, owner))
    return { account: login, because: `the gh account that started it owns ${slug}` }
  const access = readGhJson<{ permissions?: { push?: boolean } }>(gh, ['api', `repos/${slug}`])
  if (access.kind === 'read' && access.value.permissions?.push === true)
    return { account: login, because: `the gh account that started it can push to ${slug}` }
  if (access.kind === 'read' || NO_ACCESS.test(access.reason))
    return { account: owner, because: `the gh account that started it, ${login}, cannot push to ${slug}, so its owner wins` }
  return { account: null, because: `the access of ${login} to ${slug} could not be read: ${access.reason}` }
}

function installedAccount(repository: string, home: string): string | null {
  const plist = readOrNull(path.join(home, LAUNCH_AGENTS, `${agentLabel(repository)}.plist`))
  return plist === null ? null : new RegExp(`<key>${GH_ACCOUNT_VARIABLE}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? null
}

export function recordAccount(repository: string, parts: KeepAliveParts): string[] {
  if (isOwnerCheckout(repository) || recordedAccount(parts.env) !== null)
    return []
  const url = remoteUrlOf(repository)
  const slug = url === null || !GITHUB_REMOTE.test(url) ? null : repoSlugOfUrl(url)
  if (slug === null)
    return []
  const found = accountOfRepository(slug, parts.gh)
  const account = found.account ?? installedAccount(repository, parts.home)
  if (account !== null)
    parts.env[GH_ACCOUNT_VARIABLE] = account
  if (found.account !== null)
    return [`${START_PREFIX}the factory runs as the GitHub account ${account}: ${found.because}`]
  return [account === null
    ? `${START_PREFIX}no GitHub account is recorded, so the factory follows the active gh account: ${found.because}; run ${START_BIN} again once gh answers`
    : `${START_PREFIX}the factory keeps the GitHub account ${account} its keep-alive records: ${found.because}`]
}

export async function runStart(repository: string, installed: string | null, parts: KeepAliveParts, start: () => Promise<BgResult> = () => startBus(parts.busDir, undefined, null)): Promise<BgResult> {
  const account = recordAccount(repository, parts)
  const mode = startingMode(parts.busDir)
  const fresh = mode === null ? [] : [`${START_PREFIX}a fresh factory starts in mode ${mode}: ${MODE_WORKERS[mode].join(', ')} switched on, merge off, a human merges; ${START_BIN} ${MODE_FLAG} ${FACTORY_MODES[1]} switches to ${FACTORY_MODES[1]} on the owner's word`]
  const started = await start()
  const kept = installKeepAlive(repository, installed, parts)
  return { stdout: [...account, ...fresh, ...started.stdout, ...kept.stdout], stderr: [...started.stderr, ...kept.stderr], exitCode: Math.max(started.exitCode, kept.exitCode) }
}

export interface HoldParts {
  busDb: string
  processes: ProcessList
  wait: (ms: number) => Promise<void>
  say: (line: string) => void
}

export function heldSupervisors(processes: RunningProcess[], busDb: string): RunningProcess[] {
  return instancesOf(processes, SUPERVISOR_LAUNCH.markers, busDb).filter(candidate => provenOnBus(candidate, busDb))
}

export async function holdWhileSupervised(parts: HoldParts): Promise<BgResult> {
  let checks = 0
  for (;;) {
    const [supervisor] = heldSupervisors(parts.processes(), parts.busDb)
    if (supervisor === undefined) {
      const after = checks === 0 ? 'right after the start' : `after ${checks} checks ${HOLD_CHECK_MS / 1000} s apart`
      return { stdout: [], stderr: [`${START_PREFIX}no supervisor of ${parts.busDb} is running ${after}; the starter exits so its keep-alive starts the factory again`], exitCode: 1 }
    }
    if (checks === 0)
      parts.say(`${START_PREFIX}holding while the supervisor of ${parts.busDb} runs as pid ${supervisor.pid}; checked every ${HOLD_CHECK_MS / 1000} s`)
    checks += 1
    await parts.wait(HOLD_CHECK_MS)
  }
}

export async function startAndHold(start: () => Promise<BgResult>, hold: HoldParts, print: (result: BgResult) => void = printBg): Promise<void> {
  const started = await start()
  print(started)
  if (started.exitCode === 0)
    print(await holdWhileSupervised(hold))
}

export type StartCommand
  = | { kind: 'start', hold: boolean }
    | { kind: 'mode', mode: FactoryMode, hours: number }
    | { kind: 'queue', worker: BusWorker, live: boolean }

export interface ModeParts {
  busDir: string
  channel: string
  now: () => Date
  uuid: () => string
  record: (event: BusEvent) => void
  activeWindows: (now: Date) => WindowShard[]
  addDecision: (args: string[]) => { code: number, lines: string[] }
  decisionsText: () => string
}

function positiveHours(value: string | undefined): number | null {
  const hours = Number(value)
  return value !== undefined && Number.isInteger(hours) && hours > 0 ? hours : null
}

export function startCommandOf(argv: readonly string[]): StartCommand | null {
  if (argv.length === 0)
    return { kind: 'start', hold: false }
  if (argv.length === 1 && argv[0] === HOLD_FLAG)
    return { kind: 'start', hold: true }
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
      continue
    }
    const ended = endLiveDecisionsOf(parts, shard, now)
    const lines = ended.lines.map(line => `${START_PREFIX}${line}`)
    if (ended.code === 0)
      stdout.push(...lines)
    else
      stderr.push(...lines)
  }
  return { stdout, stderr, exitCode: stderr.length === 0 ? 0 : 1 }
}

function ghostProtocol(parts: ModeParts, hours: number): BgResult {
  const words = ghostProtocolWord(hours)
  const word = consumeOwnerWord(parts.channel, words, parts.now())
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
    on = switchMode(parts.busDir, FACTORY_MODES[1], until, MODE_LIVE[FACTORY_MODES[1]])
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
  const decided = SHARD_DECIDES_LIVE.map(worker => liveDecisionUnderShard(parts, worker, until))
  const stderr = decided.flatMap(result => result.code === 0 ? [] : result.lines.map(line => `${START_PREFIX}${line}`))
  return { stdout: [`${START_PREFIX}shard ${id} issued by the owner word ${word.file}, scope ${MODE_SHARD_SCOPE}, until ${until}`, switchedTo(FACTORY_MODES[1], on), ...decided.flatMap(result => result.code === 0 ? result.lines : []), `${START_PREFIX}at ${until} the supervisor returns the factory to ${DEFAULT_MODE} on its next tick; ${START_BIN} ${MODE_FLAG} ${DEFAULT_MODE} returns sooner and revokes the shard`], stderr, exitCode: stderr.length === 0 ? 0 : 1 }
}

function decisionTerm(until: string): string {
  return `${until.slice(0, DECISION_TERM_LENGTH)}Z`
}

function liveDecisionsOfShard(parts: ModeParts, shard: WindowShard, now: Date): number[] {
  const term = decisionTerm(shard.until)
  return inForceInText(parts.decisionsText(), now)
    .filter(decision => decision.term.until === term && SHARD_DECIDES_LIVE.some(worker => namesQueueLive(decision.body, worker)))
    .map(decision => decision.number)
}

function endLiveDecisionsOf(parts: ModeParts, shard: WindowShard, now: Date): { code: number, lines: string[] } {
  try {
    const live = liveDecisionsOfShard(parts, shard, now)
    if (live.length === 0)
      return { code: 0, lines: [] }
    return parts.addDecision([...live.flatMap(number => ['--supersedes', `D-${number}`]), `${OWNER_SOURCE} ${SHARD_DECIDES_LIVE.map(allowLiveText).join(' and ')} end with the revocation of shard ${shard.id}`])
  }
  catch (error) {
    return { code: 1, lines: [`the live decisions of shard ${shard.id} were not ended: ${messageOf(error)}; they lapse at ${shard.until}`] }
  }
}

function liveDecisionUnderShard(parts: ModeParts, worker: BusWorker, until: string): { code: number, lines: string[] } {
  try {
    return parts.addDecision(['--until', decisionTerm(until), `${OWNER_SOURCE} ${allowLiveText(worker)}`])
  }
  catch (error) {
    return { code: 1, lines: [`${allowLiveText(worker)} was not written: ${messageOf(error)}`] }
  }
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
  const word = consumeOwnerWord(parts.channel, words, parts.now())
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

export function busDecisionsText(busDb: string): ModeParts['decisionsText'] {
  return () => projectionText(busDb)
}

export function busDecisionsAdder(busDb: string, now: () => Date): ModeParts['addDecision'] {
  return decisionsAdderOpeningTheBus(busDb, now)
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
      addDecision: busDecisionsAdder(busDb, () => new Date()),
      decisionsText: busDecisionsText(busDb),
    }))
    return
  }
  const start = async (): Promise<BgResult> => runStart(realpathSync(process.cwd()), installedPackage(), {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    path: process.env.PATH ?? '',
    busDb,
    busDir: busDirOf(busDb),
    launchctl: systemLaunchctl,
    env: process.env,
    gh: args => ghPort({ attempts: 1 }).call(args),
  })
  if (!command.hold) {
    printBg(await start())
    return
  }
  await startAndHold(start, { busDb, processes: psList(), wait: async (ms) => {
    await sleep(ms)
  }, say: line => console.log(line) })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
