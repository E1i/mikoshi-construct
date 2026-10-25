import type { ShiftTask } from '../../../src/card/task-file.js'
import type { PromptPlaces } from './prompt.js'
import type { CardStart, CardStarter, HeldTree, QueuedCard, StartedCard } from './launch-executor.js'
import type { SessionJournal, TreeFile } from './session-journal.js'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseParkingFile } from '../../../src/card/parking.js'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { FACTORY_RUNTIME } from '../../core/factory-paths.js'
import { continuationBody } from './prompt.js'
import { messageOf } from '../../core/errors.js'
import { HELD_TREE_CHANGED, technical } from './launch-executor.js'
import { journalDoubt, parseSessionJournal } from './session-journal.js'

export interface DetachedSpawn {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input: string
  log: string
}

export interface StarterPorts {
  read: (cardId: number) => string | null
  cut: (task: ShiftTask) => string
  base: (worktree: string) => string
  spawnDetached: (spawn: DetachedSpawn) => number
  pgidOf: (pid: number) => number
  kill: (target: number) => void
  uuid: () => string
  envOf: (cardId: number) => NodeJS.ProcessEnv
  prompt: (task: ShiftTask, places: { worktree: string, report: string }) => string
  changedPaths: (worktree: string) => string[]
  readReport: (file: string) => string | null
  cardSessions: (cardId: number) => string[]
  readTranscript: (worktree: string, session: string) => string | null
  treeFile: (file: string) => TreeFile | null
}

export interface StarterPlaces {
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
  return `pnpm --dir ${shellWord(repo)} --silent exec tsx ${FACTORY_RUNTIME.shiftTreePr}`
}

export function launchArgv(session: { command: string, treePr: string, cardId: number, worktree: string, report: string, id: string }): string[] {
  return ['-c', `env -u ${BUS_DB_VARIABLE} ${session.command} "$@" && ${session.treePr} ${session.cardId} ${shellWord(session.worktree)} ${shellWord(session.report)}`, 'shift', '-p', '--session-id', session.id]
}

export function launchEnv(session: NodeJS.ProcessEnv, launching: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bus = launching[BUS_DB_VARIABLE]
  return bus === undefined || bus === '' ? session : { ...session, [BUS_DB_VARIABLE]: bus }
}

export function unreadableCard(cardId: number): string {
  return `the bus holds no card body of card #${cardId}`
}

const PATH_DELIMITERS = /[\s`'"(),;<>[\]{}]+/

export function pathTokens(text: string): Set<string> {
  return new Set(text.split(PATH_DELIMITERS).map(token => token.replace(/[.:]+$/, '')).filter(token => token !== ''))
}

export interface SessionContinuer {
  continueFrom: (card: QueuedCard, from: StartedCard) => CardStart
}

interface SessionTree {
  worktree: string
  base: string
  body: (task: ShiftTask, places: PromptPlaces) => string
}

export class ShiftCardStarter implements CardStarter, SessionContinuer {
  constructor(private readonly places: StarterPlaces, private readonly ports: StarterPorts) {}

  start(card: QueuedCard): CardStart {
    if (card.continueIn !== undefined)
      return this.continueIn(card, card.continueIn)
    return this.session(card, (task) => {
      const worktree = this.ports.cut(task)
      return { worktree, base: this.ports.base(worktree), body: each => each.body }
    })
  }

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    return this.continueIn(card, { worktree: from.worktree, base: from.base }, from.session)
  }

  private continueIn(card: QueuedCard, held: HeldTree, session?: string): CardStart {
    const refusal = this.unnamedChanges(card.cardId, held.worktree, session)
    if (refusal !== null)
      return refusal
    return this.session(card, () => ({ worktree: held.worktree, base: held.base ?? this.ports.base(held.worktree), body: continuationBody }))
  }

  private unnamedChanges(cardId: number, worktree: string, ended: string | undefined): CardStart | null {
    try {
      const named = pathTokens(this.ports.readReport(this.reportOf(cardId)) ?? '')
      const unnamed = this.ports.changedPaths(worktree).filter(changed => !named.has(changed))
      if (unnamed.length === 0)
        return null
      const sessions = [...new Set([...this.ports.cardSessions(cardId), ...(ended === undefined ? [] : [ended])])]
      const doubts = this.journalDoubts(worktree, sessions, unnamed)
      if (doubts.length === 0)
        return null
      const detail = `card #${cardId} is not continued in ${worktree}: neither its report nor the journal of any of its sessions ${sessions.join(', ') || '-'} owns the changed paths ${doubts.map(doubt => `${doubt.path} (${doubt.reason})`).join(', ')}`
      return { kind: 'refused', denial: { ...technical(HELD_TREE_CHANGED, detail), paths: doubts.map(doubt => doubt.path) } }
    }
    catch (error) {
      return { kind: 'refused', denial: technical('start_failed', messageOf(error)) }
    }
  }

  private journalDoubts(worktree: string, sessions: string[], unnamed: string[]): { path: string, reason: string }[] {
    const all = (reason: string): { path: string, reason: string }[] => unnamed.map(each => ({ path: each, reason }))
    if (sessions.length === 0)
      return all('the bus records no session that held the tree')
    const journals: { session: string, journal: SessionJournal }[] = []
    for (const session of sessions) {
      const read = this.journalOf(worktree, session)
      if (typeof read === 'string')
        return all(read)
      journals.push({ session, journal: read })
    }
    return unnamed.flatMap((each) => {
      const file = this.ports.treeFile(path.join(worktree, each))
      const reasons = journals.map(({ session, journal }) => ({ session, reason: journalDoubt(journal, each, file) }))
      if (reasons.some(({ reason }) => reason === null))
        return []
      const reason = reasons.length === 1 ? reasons[0]!.reason! : reasons.map(({ session, reason }) => `session ${session}: ${reason}`).join('; ')
      return [{ path: each, reason }]
    })
  }

  private journalOf(worktree: string, session: string): SessionJournal | string {
    const text = this.ports.readTranscript(worktree, session)
    if (text === null)
      return `the journal of session ${session} cannot be read`
    try {
      return parseSessionJournal(text, worktree)
    }
    catch (error) {
      return `the journal of session ${session} cannot be read: ${messageOf(error)}`
    }
  }

  private reportOf(cardId: number): string {
    return path.join(this.places.launchDir, `report-${cardId}.md`)
  }

  private session(card: QueuedCard, treeOf: (task: ShiftTask) => SessionTree): CardStart {
    const text = this.ports.read(card.cardId)
    if (text === null)
      return { kind: 'refused', denial: technical('card_unreadable', unreadableCard(card.cardId)) }
    const parsed = parseParkingFile(`${card.cardId}.md`, text)
    if (parsed.kind === 'refused')
      return { kind: 'refused', denial: technical('card_unreadable', parsed.reason) }
    const { task } = parsed.parked
    try {
      const { worktree, base, body } = treeOf(task)
      const session = this.ports.uuid()
      const report = this.reportOf(card.cardId)
      const prompt = this.ports.prompt({ ...task, body: body(task, { worktree, report }) }, { worktree, report })
      const pid = this.ports.spawnDetached({
        command: 'sh',
        args: launchArgv({ command: cardCommand(this.places.claude), treePr: this.places.treePr, cardId: card.cardId, worktree, report, id: session }),
        cwd: worktree,
        env: launchEnv(this.ports.envOf(card.cardId)),
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

export function gitChangedPaths(worktree: string): string[] {
  const entries = execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' }).split('\0')
  const paths: string[] = []
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]!
    if (entry.length < 4)
      continue
    paths.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2)))
      paths.push(entries[++at] ?? '')
  }
  return paths.filter(each => each !== '')
}

export function psPgid(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}
