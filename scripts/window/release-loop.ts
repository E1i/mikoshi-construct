export const RELEASES_IN_A_ROW = 3

export interface ReleaseTypes {
  released: string
  completed: string
  fieldsOf: (payload: string) => Record<string, unknown>
}

export interface LoopEvent {
  id: number
  type: string
  cardId: number | null
  payload: string
  ts?: string
}

interface ReleaseRun {
  reason: string
  count: number
  firstTs: string
}

export function textOf(fields: Record<string, unknown>, name: string): string | undefined {
  return typeof fields[name] === 'string' ? fields[name] : undefined
}

export function releaseLoopLine(event: LoopEvent, queue: string, run: ReleaseRun): string {
  return `release loop: card ${event.cardId ?? '-'} queue ${queue} released ${run.count} times in a row with reason ${run.reason}, first at ${run.firstTs}; the window finds the cause and hands the owner the decision`
}

export class ReleaseLoops {
  private readonly runs = new Map<string, ReleaseRun>()
  private readonly lines = new Map<number, string>()

  constructor(private readonly types: ReleaseTypes) {}

  static upTo(types: ReleaseTypes, history: readonly LoopEvent[]): ReleaseLoops {
    const loops = new ReleaseLoops(types)
    for (const event of history)
      loops.wakes(event)
    loops.lines.clear()
    return loops
  }

  read(): readonly string[] {
    return [this.types.released, this.types.completed]
  }

  wakes(event: LoopEvent): boolean {
    if (!this.read().includes(event.type))
      return false
    const fields = this.types.fieldsOf(event.payload)
    const queue = textOf(fields, 'queue') ?? '-'
    const task = `${queue}:${textOf(fields, 'task_key') ?? '-'}`
    if (event.type === this.types.completed) {
      this.runs.delete(task)
      return false
    }
    const reason = textOf(fields, 'reason') ?? '-'
    const before = this.runs.get(task)
    const run = before?.reason === reason ? { ...before, count: before.count + 1 } : { reason, count: 1, firstTs: event.ts ?? '-' }
    this.runs.set(task, run)
    if (run.count !== RELEASES_IN_A_ROW)
      return false
    this.lines.set(event.id, releaseLoopLine(event, queue, run))
    return true
  }

  wokenLine<E extends LoopEvent & { pr: number | null }>(event: E, plain: (event: E) => string): string {
    const loop = this.lines.get(event.id)
    return loop === undefined ? plain(event) : `bus ${event.type} card ${event.cardId ?? '-'} pr ${event.pr ?? '-'} ${loop} ${event.payload}`
  }
}
