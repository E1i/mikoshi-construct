export const CHECK_IDS = ['lint-policy', 'construct-tests', 'ci', 'hook', 'red-gate'] as const
export const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const

export type CheckId = (typeof CHECK_IDS)[number]
export type Level = (typeof LEVELS)[number]
export type CheckState = 'present' | 'absent' | 'unknown'

export interface CheckVerdict {
  id: CheckId
  level: Level
  state: CheckState
  evidence: string
}

export interface WeakestLink {
  id: CheckId
  level: Level
}

export function weakestLink(checks: CheckVerdict[]): WeakestLink | null {
  const claimed = checks.filter(check => check.state === 'present')
  if (claimed.length === 0)
    return null
  const ordered = [...claimed].sort((left, right) => CHECK_IDS.indexOf(left.id) - CHECK_IDS.indexOf(right.id))
  const weakest = ordered.reduce((current, check) => (LEVELS.indexOf(check.level) < LEVELS.indexOf(current.level) ? check : current))
  return { id: weakest.id, level: weakest.level }
}
