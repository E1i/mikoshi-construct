import type { AttemptView, TaskPath, TaskView } from './derive.js'
import type { Next } from './next.js'
import { latestStage, unknownEvent } from './derive.js'

export interface Age {
  minutes: number
  skew: boolean
}

export interface Row {
  id: string
  path: TaskPath
  stage: { name: string, at: string } | undefined
  age: Age | undefined
  next: Next
}

export type NextOf = (view: AttemptView) => Next

export function ageSince(at: Date, now: Date): Age {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  return minutes < 0 ? { minutes: -minutes, skew: true } : { minutes, skew: false }
}

export function rowOf(task: TaskView, nextOf: NextOf, now: Date): Row {
  const stage = latestStage(task.live)
  return {
    id: task.live.attempt.id,
    path: task.live.path,
    stage: stage === undefined ? undefined : { name: stage.name, at: stage.at },
    age: stage === undefined ? undefined : ageSince(new Date(stage.at), now),
    next: nextOf(task.live),
  }
}

export function unknownTally(views: AttemptView[]): Map<string, number> {
  const tally = new Map<string, number>()
  for (const view of views) {
    for (const stage of view.stages) {
      if (stage.state === 'unknown') {
        const event = unknownEvent(stage.missing)
        tally.set(event, (tally.get(event) ?? 0) + 1)
      }
    }
  }
  return tally
}
