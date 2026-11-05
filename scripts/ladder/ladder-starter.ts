import type { ShiftTask } from '../../src/card/task-file.js'
import type { CardStart, CardStarter, LaunchedCard, LaunchTechnicalReason, QueuedCard, StartedCard } from '../nodes/launch/launch-executor.js'
import type { StarterPlaces, StarterPorts } from '../nodes/launch/launch-starter.js'
import path from 'node:path'
import { parseParkingFile } from '../../src/card/parking.js'
import { readShiftGate } from '../../src/manifest.js'
import { messageOf } from '../core/errors.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { technical } from '../nodes/launch/launch-executor.js'
import { chainedClient, shellWord, unreadableCard } from '../nodes/launch/launch-starter.js'

export type LadderStep
  = | { kind: 'brief' }
    | { kind: 'launch' }
    | { kind: 'running' }
    | { kind: 'review' }
    | { kind: 'fault', why: string }

export type ChainStep = 'brief' | 'launch' | 'review'

export interface LadderSteps {
  stepOf: (task: ShiftTask) => LadderStep
  tree: (task: ShiftTask) => string | null
  brief: (task: ShiftTask) => string
  tasksFile: (task: ShiftTask) => string
  body: (task: ShiftTask, step: 'brief' | 'review') => string
}

export interface LadderPlaces extends StarterPlaces {
  repo: string
}

interface ChainContext {
  places: LadderPlaces
  client: string
  task: ShiftTask
  worktree: string
  report: string
  brief: string
  tasksFile: string
  input: string
}

interface Chain {
  script: string
  input: string
}

export const BRIEF_FINISH_CLI = FACTORY_RUNTIME.shiftBriefFinish
const ANSWER_YES = `printf 'yes\\n'`

function pnpmScript(places: LadderPlaces, args: string[]): string {
  return ['pnpm', '--dir', shellWord(places.repo), '--silent', ...args.map(shellWord)].join(' ')
}

function finishScript(context: ChainContext): string {
  const args = [BRIEF_FINISH_CLI, String(context.task.card.id), context.worktree, context.brief]
  return ['pnpm', '--dir', shellWord(context.places.repo), '--silent', 'exec', 'tsx', ...args.map(shellWord)].join(' ')
}

function hashScript(context: ChainContext): string {
  return pnpmScript(context.places, ['ghosts:hash', context.brief, '--by', 'morse', '--card', String(context.task.card.id)])
}

function launchScript(context: ChainContext): string {
  return `${ANSWER_YES} | ${pnpmScript(context.places, ['ghosts:launch', '--tasks', context.tasksFile])}`
}

function treePrScript(context: ChainContext): string {
  return [context.places.treePr, String(context.task.card.id), shellWord(context.worktree), shellWord(context.report)].join(' ')
}

function clientScript(context: ChainContext): string {
  return `env ${context.client} "$@"`
}

const CHAINS: Record<ChainStep, (context: ChainContext) => Chain> = {
  brief: context => ({ script: `${clientScript(context)} && ${finishScript(context)} && ${hashScript(context)} && ${launchScript(context)}`, input: context.input }),
  launch: context => ({ script: launchScript(context), input: '' }),
  review: context => ({ script: `${clientScript(context)} && ${treePrScript(context)}`, input: context.input }),
}

const LADDER_POSITIONAL_WORDS = 3

function refused(reason: LaunchTechnicalReason, detail: string): CardStart {
  return { kind: 'refused', denial: technical(reason, detail) }
}

export class LadderCardStarter implements CardStarter {
  constructor(private readonly places: LadderPlaces, private readonly ports: StarterPorts, private readonly steps: LadderSteps) {}

  start(card: QueuedCard): CardStart {
    const text = this.ports.read(card.cardId)
    if (text === null)
      return refused('card_unreadable', unreadableCard(card.cardId))
    const parsed = parseParkingFile(`${card.cardId}.md`, text)
    if (parsed.kind === 'refused')
      return refused('card_unreadable', parsed.reason)
    const { task } = parsed.parked
    try {
      const step = this.steps.stepOf(task)
      if (step.kind === 'running')
        return refused('ladder_running', `card #${card.cardId} has a Ghost running; nothing to start`)
      if (step.kind === 'fault')
        return refused('ladder_fault', step.why)
      return this.run(card, task, step.kind)
    }
    catch (error) {
      return refused('start_failed', messageOf(error))
    }
  }

  private run(card: QueuedCard, task: ShiftTask, step: ChainStep): CardStart {
    const worktree = this.steps.tree(task) ?? (step === 'brief' ? this.ports.cut(task) : null)
    if (worktree === null)
      return refused('start_failed', `card #${card.cardId} has no tree for its ${step} step`)
    const base = this.ports.base(worktree)
    const session = this.ports.uuid()
    const report = path.join(this.places.launchDir, step === 'brief' ? `report-${card.cardId}-brief.md` : `report-${card.cardId}.md`)
    const prompt = step === 'launch' ? '' : this.ports.prompt({ ...task, body: `${this.steps.body(task, step)}\n\n${task.body}` }, { worktree, report, gate: readShiftGate(worktree) })
    const client = chainedClient({ kind: 'start', role: 'ladder', session, cwd: worktree, prompt, addDirs: [], pick: { model: null }, policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false } }, LADDER_POSITIONAL_WORDS, this.places.claude)
    const chain = CHAINS[step]({ places: this.places, client: client.command, task, worktree, report, brief: this.steps.brief(task), tasksFile: step === 'review' ? '' : this.steps.tasksFile(task), input: client.input })
    const pid = this.ports.spawnDetached({
      command: 'sh',
      args: ['-c', chain.script, 'shift', ...client.positional],
      cwd: worktree,
      env: { ...this.ports.envOf(card.cardId), ...client.env },
      input: chain.input,
      log: path.join(this.places.launchDir, `log-${card.cardId}.txt`),
    })
    const started: LaunchedCard = { session, worktree, branch: task.branch, base, pid, pgid: this.groupOrKill(pid), step, ...(prompt === '' ? {} : { input: { prompt } }) }
    return { kind: 'started', card: started }
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
