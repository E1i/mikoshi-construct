import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'

export const SPAWNER_VARIABLE = 'SCENARIO_SPAWNER'
export const WAITER_POLL_S = 0.05
export const WAITER_OUT_OF_TIME = 124
export const WAITER_ORPHANED = 125
export const DEFAULT_WAITER_BOUND_S = 90

const LEADER_POLL_MS = Math.round(WAITER_POLL_S * 1000)
const ENDING_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const LEADER = `
const { spawn } = require('node:child_process')
const { closeSync, openSync } = require('node:fs')
const spawner = Number(process.argv[1])
const pollMs = Number(process.argv[2])
function endGroup() {
  try { process.kill(-process.pid, 'SIGKILL') } catch {}
  process.exit(1)
}
function reply(message) {
  if (process.connected)
    process.send(message)
}
process.on('disconnect', endGroup)
setInterval(() => {
  try { process.kill(spawner, 0) } catch { endGroup() }
}, pollMs)
process.on('message', (request) => {
  const output = request.log === undefined ? 'ignore' : openSync(request.log, 'a')
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ['ignore', output, output] })
  if (typeof output === 'number')
    closeSync(output)
  child.once('error', error => reply({ id: request.id, error: String(error) }))
  child.once('spawn', () => reply({ id: request.id, pid: child.pid }))
  child.once('exit', (code, signal) => reply({ id: request.id, code, signal }))
})
`

export interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ScenarioChild {
  pid: number
  exited: Promise<Exit>
}

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  log?: string
}

type LeaderMessage = { id: number, pid: number } | { id: number, error: string } | { id: number, code: number | null, signal: NodeJS.Signals | null }

interface Pending {
  started: (pid: number) => void
  refused: (error: Error) => void
  ended: (exit: Exit) => void
}

export function waiterScript(then: string, boundS = DEFAULT_WAITER_BOUND_S): string {
  const ticks = Math.ceil(boundS / WAITER_POLL_S)
  return `n=0; while [ ! -f "$0" ]; do kill -0 "$${SPAWNER_VARIABLE}" 2>/dev/null || exit ${WAITER_ORPHANED}; n=$((n+1)); [ "$n" -gt ${ticks} ] && exit ${WAITER_OUT_OF_TIME}; sleep ${WAITER_POLL_S}; done; ${then}`
}

export class ScenarioGroup {
  private readonly leader: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private next = 0
  private killed = false

  constructor(private readonly spawner: number) {
    this.leader = spawn(process.execPath, ['-e', LEADER, String(spawner), String(LEADER_POLL_MS)], { detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    this.leader.on('message', message => this.settle(message as LeaderMessage))
    this.leader.once('exit', () => this.refuseAll())
    this.leader.on('error', () => this.refuseAll())
    this.leader.unref()
    this.leader.channel?.unref()
  }

  get pgid(): number {
    return this.leader.pid!
  }

  async spawn(command: string, args: string[], options: SpawnOptions = {}): Promise<ScenarioChild> {
    if (this.killed || this.leader.exitCode !== null || this.leader.signalCode !== null)
      throw new Error('the scenario group has ended')
    const id = this.next++
    let ended!: (exit: Exit) => void
    const exited = new Promise<Exit>((resolve) => {
      ended = resolve
    })
    const pid = await new Promise<number>((started, refused) => {
      this.pending.set(id, { started, refused, ended })
      this.leader.channel?.ref()
      const env = { ...(options.env ?? process.env), [SPAWNER_VARIABLE]: String(this.spawner) }
      this.leader.send({ id, command, args, cwd: options.cwd, env, log: options.log })
    })
    return { pid, exited }
  }

  kill(): void {
    this.killed = true
    try {
      process.kill(-this.pgid, 'SIGKILL')
    }
    catch {}
  }

  private settle(message: LeaderMessage): void {
    const pending = this.pending.get(message.id)
    if (pending === undefined)
      return
    if ('pid' in message) {
      pending.started(message.pid)
      return
    }
    this.pending.delete(message.id)
    if (this.pending.size === 0)
      this.leader.channel?.unref()
    if ('error' in message)
      pending.refused(new Error(message.error))
    else
      pending.ended({ code: message.code, signal: message.signal })
  }

  private refuseAll(): void {
    for (const pending of this.pending.values())
      pending.refused(new Error(this.killed ? 'the scenario group was killed' : 'the scenario group leader died'))
  }
}

export class ScenarioProcesses {
  private readonly groups = new Set<ScenarioGroup>()
  private hooked = false

  open(): ScenarioGroup {
    this.hook()
    const group = new ScenarioGroup(process.pid)
    this.groups.add(group)
    return group
  }

  killAll(): void {
    for (const group of this.groups)
      group.kill()
    this.groups.clear()
  }

  private hook(): void {
    if (this.hooked)
      return
    this.hooked = true
    process.on('exit', () => this.killAll())
    for (const signal of ENDING_SIGNALS) {
      process.once(signal, () => {
        this.killAll()
        process.kill(process.pid, signal)
      })
    }
  }
}

export const scenarioProcesses = new ScenarioProcesses()
