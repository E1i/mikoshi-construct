import type { ShiftTask } from '../../src/card/task-file.js'
import type { CardStart, CardStarter, LaunchedCard, LaunchTechnicalReason, QueuedCard, StartedCard } from './launch-executor.js'
import type { StarterPlaces, StarterPorts } from './launch-starter.js'
import path from 'node:path'
import { parseParkingFile } from '../../src/card/parking.js'
import { messageOf } from './errors.js'
import { technical } from './launch-executor.js'
import { cardCommand, shellWord } from './launch-starter.js'

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
  task: ShiftTask
  cardFile: string
  worktree: string
  report: string
  brief: string
  tasksFile: string
  prompt: string
}

interface Chain {
  script: string
  input: string
}

const BRIEF_FINISH_CLI = 'scripts/shift/brief-finish-cli.ts'
const ANSWER_YES = `printf 'yes\\n'`

function pnpmScript(places: LadderPlaces, args: string[]): string {
  return ['pnpm', '--dir', shellWord(places.repo), '--silent', ...args.map(shellWord)].join(' ')
}

function finishScript(context: ChainContext): string {
  const args = [BRIEF_FINISH_CLI, context.cardFile, context.worktree, context.brief]
  return ['pnpm', '--dir', shellWord(context.places.repo), '--silent', 'exec', 'tsx', ...args.map(shellWord)].join(' ')
}

function hashScript(context: ChainContext): string {
  return pnpmScript(context.places, ['ghosts:hash', context.brief, '--by', 'morse', '--card', String(context.task.card.id), '--parking', context.places.parking])
}

function launchScript(context: ChainContext): string {
  return `${ANSWER_YES} | ${pnpmScript(context.places, ['ghosts:launch', '--tasks', context.tasksFile])}`
}

function treePrScript(context: ChainContext): string {
  return [context.places.treePr, shellWord(context.cardFile), shellWord(context.worktree), shellWord(context.report)].join(' ')
}

function claudeScript(context: ChainContext): string {
  return `env ${cardCommand(context.places.claude)} "$@"`
}

const CHAINS: Record<ChainStep, (context: ChainContext) => Chain> = {
  brief: context => ({ script: `${claudeScript(context)} && ${finishScript(context)} && ${hashScript(context)} && ${launchScript(context)}`, input: context.prompt }),
  launch: context => ({ script: launchScript(context), input: '' }),
  review: context => ({ script: `${claudeScript(context)} && ${treePrScript(context)}`, input: context.prompt }),
}

function refused(reason: LaunchTechnicalReason, detail: string): CardStart {
  return { kind: 'refused', denial: technical(reason, detail) }
}

export class LadderCardStarter implements CardStarter {
  constructor(private readonly places: LadderPlaces, private readonly ports: StarterPorts, private readonly steps: LadderSteps) {}

  start(card: QueuedCard): CardStart {
    const laneDir = path.join(this.places.parking, card.lane)
    const file = `${card.cardId}.md`
    const text = this.ports.read(path.join(laneDir, file))
    if (text === null)
      return refused('card_unreadable', `${path.join(laneDir, file)} is not there`)
    const parsed = parseParkingFile(file, text)
    if (parsed.kind === 'refused')
      return refused('card_unreadable', parsed.reason)
    const { task } = parsed.parked
    try {
      const step = this.steps.stepOf(task)
      if (step.kind === 'running')
        return refused('ladder_running', `card #${card.cardId} has a Ghost running; nothing to start`)
      if (step.kind === 'fault')
        return refused('ladder_fault', step.why)
      return this.run(card, task, step.kind, laneDir, path.join(laneDir, file))
    }
    catch (error) {
      return refused('start_failed', messageOf(error))
    }
  }

  private run(card: QueuedCard, task: ShiftTask, step: ChainStep, laneDir: string, cardFile: string): CardStart {
    const worktree = this.steps.tree(task) ?? (step === 'brief' ? this.ports.cut(task, laneDir) : null)
    if (worktree === null)
      return refused('start_failed', `card #${card.cardId} has no tree for its ${step} step`)
    const base = this.ports.base(worktree)
    const session = this.ports.uuid()
    const report = path.join(this.places.launchDir, step === 'brief' ? `report-${card.cardId}-brief.md` : `report-${card.cardId}.md`)
    const prompt = step === 'launch' ? '' : this.ports.prompt({ ...task, body: `${this.steps.body(task, step)}\n\n${task.body}` }, { worktree, report })
    const chain = CHAINS[step]({ places: this.places, task, cardFile, worktree, report, brief: this.steps.brief(task), tasksFile: step === 'review' ? '' : this.steps.tasksFile(task), prompt })
    const pid = this.ports.spawnDetached({
      command: 'sh',
      args: ['-c', chain.script, 'shift', '-p', '--session-id', session],
      cwd: worktree,
      env: this.ports.envOf(card.cardId),
      input: chain.input,
      log: path.join(this.places.launchDir, `log-${card.cardId}.txt`),
    })
    const started: LaunchedCard = { session, worktree, branch: task.branch, base, pid, pgid: this.groupOrKill(pid), step }
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
