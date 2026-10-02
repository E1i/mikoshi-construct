import type { AttemptView } from './derive.js'
import type { Age } from './row.js'
import { latestStage, OPEN_CATEGORIES } from './derive.js'
import { ageSince } from './row.js'

export const STALE_HOURS = 4

export function lastEventAt(view: AttemptView): Date | undefined {
  const times = [latestStage(view)?.at, view.path === 'cheap' ? view.attempt.window.lastAt?.toISOString() : undefined]
    .filter((time): time is string => time !== undefined)
    .map(time => new Date(time).getTime())
  return times.length === 0 ? undefined : new Date(Math.max(...times))
}

export function staleAge(view: AttemptView, now: Date, hours: number): Age | undefined {
  const at = lastEventAt(view)
  if (!OPEN_CATEGORIES.includes(view.category) || at === undefined)
    return undefined
  const age = ageSince(at, now)
  return !age.skew && age.minutes > hours * 60 ? age : undefined
}
