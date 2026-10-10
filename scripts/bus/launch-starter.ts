import type { ShiftTask } from '../../src/card/task-file.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from './launch-executor.js'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseParkingFile } from '../../src/card/parking.js'
import { sessionEnv } from '../ghosts/session.js'
import { taskWorktree, worktreeHome } from '../ghosts/worktree-home.js'
import { renderPrompt } from '../shift/prompt.js'
import { messageOf } from './executor.js'
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
}

export interface StarterPlaces {
  parking: string
  launchDir: string
  header: string
  claude: string
  treePr: string
  env: NodeJS.ProcessEnv
}

export const CARD_PERMISSION_MODE = 'dontAsk'

export function cardCommand(claude: string): string {
  return `${claude} --permission-mode ${CARD_PERMISSION_MODE}`
}

export function shellWord(text: string): string {
  return `'${text.replaceAll('\'', `'\\''`)}'`
}

export function treePrCommand(repo: string): string {
  return `pnpm --dir ${shellWord(repo)} --silent exec tsx scripts/shift/tree-pr-cli.ts`
}

export function launchArgv(session: { command: string, treePr: string, cardFile: string, worktree: string, id: string }): string[] {
  return ['-c', `env ${session.command} "$@" && ${session.treePr} ${shellWord(session.cardFile)} ${shellWord(session.worktree)}`, 'shift', '-p', '--session-id', session.id]
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
      const pid = this.ports.spawnDetached({
        command: 'sh',
        args: launchArgv({ command: cardCommand(this.places.claude), treePr: this.places.treePr, cardFile: path.join(laneDir, file), worktree, id: session }),
        cwd: worktree,
        env: sessionEnv(this.places.env, card.cardId),
        input: renderPrompt(this.places.header, task, { worktree, report }),
        log: path.join(this.places.launchDir, `log-${card.cardId}.txt`),
      })
      return { kind: 'started', card: { session, worktree, branch: task.branch, base, pid, pgid: this.groupOrKill(pid) } }
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

export function realStarterPorts(repo: string, env: NodeJS.ProcessEnv, uuid: () => string): StarterPorts {
  return {
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    cut: (task, laneDir) => {
      execFileSync('pnpm', ['--silent', 'task:start', task.branch, '--card', task.card.line, '--parking', laneDir], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return taskWorktree(worktreeHome(env), String(task.card.id))
    },
    base: worktree => execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    spawnDetached,
    pgidOf: psPgid,
    kill: killQuietly,
    uuid,
  }
}
