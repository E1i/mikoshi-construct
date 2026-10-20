import type { ShiftTask } from '../../src/card/task-file.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from './launch-executor.js'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseParkingFile } from '../../src/card/parking.js'
import { messageOf } from './errors.js'
import { technical } from './launch-executor.js'

export interface DetachedSpawn {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input: string
  log: string
}

export interface StarterPorts {
  read: (file: string) => string | null
  cut: (task: ShiftTask, laneDir: string) => string
  base: (worktree: string) => string
  spawnDetached: (spawn: DetachedSpawn) => number
  pgidOf: (pid: number) => number
  kill: (target: number) => void
  uuid: () => string
  envOf: (cardId: number) => NodeJS.ProcessEnv
  prompt: (task: ShiftTask, places: { worktree: string, report: string }) => string
}

export interface StarterPlaces {
  parking: string
  launchDir: string
  claude: string
  treePr: string
}

export const CARD_PERMISSION_MODE = 'dontAsk'

export const HTTPS_ORIGIN_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
  GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_2: '',
  GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_3: '!gh auth git-credential',
}

export function cardCommand(claude: string): string {
  return `${claude} --permission-mode ${CARD_PERMISSION_MODE}`
}

export function shellWord(text: string): string {
  return `'${text.replaceAll('\'', `'\\''`)}'`
}

export function treePrCommand(repo: string): string {
  return `pnpm --dir ${shellWord(repo)} --silent exec tsx scripts/shift/tree-pr-cli.ts`
}

export function launchArgv(session: { command: string, treePr: string, cardFile: string, worktree: string, report: string, id: string }): string[] {
  return ['-c', `env ${session.command} "$@" && ${session.treePr} ${shellWord(session.cardFile)} ${shellWord(session.worktree)} ${shellWord(session.report)}`, 'shift', '-p', '--session-id', session.id]
}

export class ShiftCardStarter implements CardStarter {
  constructor(private readonly places: StarterPlaces, private readonly ports: StarterPorts) {}

  start(card: QueuedCard): CardStart {
    const laneDir = path.join(this.places.parking, card.lane)
    const file = `${card.cardId}.md`
    const text = this.ports.read(path.join(laneDir, file))
    if (text === null)
      return { kind: 'refused', denial: technical('card_unreadable', `${path.join(laneDir, file)} is not there`) }
    const parsed = parseParkingFile(file, text)
    if (parsed.kind === 'refused')
      return { kind: 'refused', denial: technical('card_unreadable', parsed.reason) }
    const { task } = parsed.parked
    try {
      const worktree = this.ports.cut(task, laneDir)
      const base = this.ports.base(worktree)
      const session = this.ports.uuid()
      const report = path.join(this.places.launchDir, `report-${card.cardId}.md`)
      const prompt = this.ports.prompt(task, { worktree, report })
      const pid = this.ports.spawnDetached({
        command: 'sh',
        args: launchArgv({ command: cardCommand(this.places.claude), treePr: this.places.treePr, cardFile: path.join(laneDir, file), worktree, report, id: session }),
        cwd: worktree,
        env: this.ports.envOf(card.cardId),
        input: prompt,
        log: path.join(this.places.launchDir, `log-${card.cardId}.txt`),
      })
      return { kind: 'started', card: { session, worktree, branch: task.branch, base, pid, pgid: this.groupOrKill(pid), input: { prompt } } }
    }
    catch (error) {
      return { kind: 'refused', denial: technical('start_failed', messageOf(error)) }
    }
  }

  private groupOrKill(pid: number): number {
    try {
      return this.ports.pgidOf(pid)
    }
    catch (error) {
      this.ports.kill(pid)
      throw error
    }
  }

  stop(card: StartedCard): void {
    this.ports.kill(card.pgid === card.pid ? -card.pid : card.pid)
  }
}

export function killQuietly(target: number): void {
  try {
    process.kill(target, 'SIGKILL')
  }
  catch {}
}

export function spawnDetached(run: DetachedSpawn): number {
  mkdirSync(path.dirname(run.log), { recursive: true })
  const fd = openSync(run.log, 'a')
  try {
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, detached: true, stdio: ['pipe', fd, fd] })
    child.on('error', () => {})
    child.stdin?.on('error', () => {})
    child.stdin?.end(run.input)
    child.unref()
    if (child.pid === undefined)
      throw new Error(`${run.command} did not start`)
    return child.pid
  }
  finally {
    closeSync(fd)
  }
}

export function psPgid(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}
